import {
    Engine,
    Scene,
    Vector3,
    HemisphericLight,
    ArcRotateCamera,
    MeshBuilder,
    StandardMaterial,
    Color3,
    SceneLoader,
    GizmoManager,
    AbstractMesh,
    PBRMaterial,
    PointerEventTypes,
    ArcRotateCameraPointersInput,
    CubeTexture,
    Texture,
    Mesh,
    Material,
    VertexData,
    DynamicTexture,
    Plane
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';

const availableModels = [
    { name: 'Móvel Geométrico', file: 'geometria.glb', type: 'floor' as const },
    { name: 'Móvel Superior 2 Portas', file: 'superior_2_portas.glb', type: 'wall' as const }
];

const WALL_MOUNT_HEIGHT = 0.5; // Height from floor for wall-mounted items

// ─── Undo/Redo/Save System ──────────────────────────────────────────────────
interface ObjectState {
    name: string;
    file: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scaling: { x: number; y: number; z: number };
    color: string;
}

interface Wall2DState {
    id: string;
    start: { x: number; z: number };
    end: { x: number; z: number };
    thickness?: number;
}

interface SceneState {
    roomWidth: number;
    roomDepth: number;
    customWalls: Wall2DState[];
    objects: ObjectState[];
}

let undoStack: string[] = [];
let redoStack: string[] = [];
let isApplyingState = false;

function getCurrentSceneState(): SceneState {
    const objects: ObjectState[] = [];
    currentScene.meshes.forEach(m => {
        if (!isInfrastructure(m) && m.name !== '__root__' && !m.name.includes('collider')) {
            const root = getTopLevelMesh(m);
            if (root && root.metadata?.glbFile && !objects.some(o => o.name === root.name)) {
                let color = '#ffffff';
                const firstMesh = root.getChildMeshes().find(cm => cm.material) || root;
                if (firstMesh.material) {
                    if (firstMesh.material instanceof PBRMaterial && firstMesh.material.albedoColor) {
                        color = firstMesh.material.albedoColor.toHexString();
                    } else if (firstMesh.material instanceof StandardMaterial && firstMesh.material.diffuseColor) {
                        color = firstMesh.material.diffuseColor.toHexString();
                    }
                }

                objects.push({
                    name: root.name,
                    file: root.metadata.glbFile,
                    position: { x: root.position.x, y: root.position.y, z: root.position.z },
                    rotation: { x: root.rotation.x || 0, y: root.rotation.y || 0, z: root.rotation.z || 0 },
                    scaling: { x: root.scaling.x, y: root.scaling.y, z: root.scaling.z },
                    color: color
                });
            }
        }
    });

    return {
        roomWidth,
        roomDepth,
        customWalls: customWalls.map(w => ({
            id: w.id,
            start: { ...w.start },
            end: { ...w.end },
            thickness: w.thickness
        })),
        objects
    };
}

async function applySceneState(state: SceneState) {
    isApplyingState = true;

    // Clear current scene objects
    const toReset = currentScene.meshes.filter(m => !isInfrastructure(m) && m.name !== '__root__' && !m.name.includes('collider'));
    toReset.forEach(m => {
        const root = getTopLevelMesh(m);
        if (root && root.metadata?.glbFile) {
            disposeObjectCollider(root);
            root.dispose();
        }
    });

    // Clear custom walls + end caps
    customWalls.forEach(w => {
        if (w.mesh) {
            disposeWallCaps(w.mesh);
            const idx = roomColliders.indexOf(w.mesh);
            if (idx > -1) roomColliders.splice(idx, 1);
            w.mesh.dispose();
        }
    });
    customWalls.length = 0;

    // Reset room dimensions
    updateRoomDimensions(state.roomWidth, state.roomDepth);
    const wInput = document.getElementById('tool-floor-width') as HTMLInputElement;
    const dInput = document.getElementById('tool-floor-depth') as HTMLInputElement;
    if (wInput) wInput.value = state.roomWidth.toString();
    if (dInput) dInput.value = state.roomDepth.toString();

    // Recreate custom walls
    for (const wState of state.customWalls) {
        const wall: Wall2D = {
            id: wState.id,
            start: { ...wState.start },
            end: { ...wState.end },
            thickness: wState.thickness || wallThickness,
            mesh: null
        };
        customWalls.push(wall);
        build3DWallFrom2D(wall);
    }

    // Load objects
    for (const obj of state.objects) {
        await loadModel(obj.file, new Vector3(obj.position.x, obj.position.y, obj.position.z), null, obj);
    }

    isApplyingState = false;
    if (is2DMode) draw2D();
}

function saveToHistory() {
    if (isApplyingState) return;
    const state = JSON.stringify(getCurrentSceneState());
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== state) {
        undoStack.push(state);
        if (undoStack.length > 50) undoStack.shift();
        redoStack = [];
    }
}

function undo() {
    if (undoStack.length > 1) {
        redoStack.push(undoStack.pop()!);
        const previous = undoStack[undoStack.length - 1];
        applySceneState(JSON.parse(previous));
    }
}

function redo() {
    if (redoStack.length > 0) {
        const next = redoStack.pop()!;
        undoStack.push(next);
        applySceneState(JSON.parse(next));
    }
}

function resetToNew() {
    const initialState: SceneState = {
        roomWidth: 10,
        roomDepth: 10,
        customWalls: [],
        objects: []
    };
    applySceneState(initialState).then(() => {
        undoStack = [];
        redoStack = [];
        saveToHistory();
    });
}

function saveToLocalStorage() {
    const state = getCurrentSceneState();
    localStorage.setItem('site_construcao_save', JSON.stringify(state));
    alert('Projeto salvo com sucesso!');
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem('site_construcao_save');
    if (saved) {
        applySceneState(JSON.parse(saved)).then(() => {
            saveToHistory();
        });
    }
}


const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
const engine = new Engine(canvas, true);

let selectedMesh: AbstractMesh | null = null;
let gizmoManager: GizmoManager;
let currentScene: Scene;
let roomColliders: AbstractMesh[] = [];
const objectColliders = new Map<AbstractMesh, Mesh>();
const wallCapMap = new Map<AbstractMesh, Mesh[]>();

let draggingFile: string | null = null;
let dragPreviewMesh: AbstractMesh | null = null;

let roomWidth = 10;
let roomDepth = 10;
let roomHalfWidth = 5;
let roomHalfDepth = 5;
const FLOOR_Y = 0;

let floorMesh: AbstractMesh | null = null;
const dimensionMarkers: AbstractMesh[] = [];


const wallHeight = 3;
const wallThickness = 0.15;


// ─── 2D Wall Drawing System ─────────────────────────────────────────────────
interface Wall2D {
    id: string;
    start: { x: number; z: number };
    end: { x: number; z: number };
    mesh: AbstractMesh | null;
    decorativeMeshes?: Mesh[];
    thickness?: number;
}
const customWalls: Wall2D[] = [];
let wallCanvas2D: HTMLCanvasElement | null = null;
let wallCtx2D: CanvasRenderingContext2D | null = null;
let is2DMode = false;
let isDrawingWall = false;
let wallDrawStart: { x: number; z: number } | null = null;
let wallDrawPreview: { x: number; z: number } | null = null;
let activeSnapPoint: { x: number; z: number } | null = null;
let selectedWall2D: Wall2D | null = null;
let isModifyingWall = false;
let modifiedWallEnd: 'start' | 'end' | null = null;
const SNAP_RADIUS_PX = 20;
let pxPerMeter = 50;



const createScene = function () {
    const scene = new Scene(engine);
    scene.clearColor = new Color3(0.9, 0.9, 0.9).toColor4();

    const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 15, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.wheelPrecision = 10;
    camera.minZ = 0.01;

    camera.inputs.removeByType('ArcRotateCameraPointersInput');

    const customPointerInput = new ArcRotateCameraPointersInput();
    customPointerInput.buttons = [1, 2];
    customPointerInput.angularSensibilityX = 500.0;
    customPointerInput.angularSensibilityY = 500.0;
    customPointerInput.panningSensibility = 200.0;
    camera.inputs.add(customPointerInput);

    camera._panningMouseButton = 1;

    // Camera Limits
    camera.lowerRadiusLimit = 0.5;
    camera.upperRadiusLimit = 30;
    camera.upperBetaLimit = Math.PI / 2.0; // Allow looking horizontal
    camera.inertia = 0; // Remove camera rotation and zoom delay
    camera.panningInertia = 0; // Remove panning delay

    scene.onBeforeRenderObservable.add(() => {
        // Keep target within room boundaries
        camera.target.x = Math.max(-roomWidth, Math.min(roomWidth, camera.target.x));
        camera.target.z = Math.max(-roomDepth, Math.min(roomDepth, camera.target.z));
    });

    const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene);
    light.intensity = 0.8;

    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(
        'https://playground.babylonjs.com/textures/environment.dds',
        scene
    );


    createRoom(scene);
    setupGizmos(scene);

    return scene;
};

function createRoom(scene: Scene) {
    roomColliders = [];

    floorMesh = MeshBuilder.CreateGround('floor', { width: 1, height: 1 }, scene);
    floorMesh.scaling.set(roomWidth, 1, roomDepth);
    const floorMat = new StandardMaterial('floorMat', scene);

    const woodTexture = new Texture('https://playground.babylonjs.com/textures/wood.jpg', scene);
    woodTexture.uScale = 4;
    woodTexture.vScale = 4;
    floorMat.diffuseTexture = woodTexture;
    floorMat.specularColor = new Color3(0.1, 0.1, 0.1);

    floorMesh.material = floorMat;
    floorMesh.receiveShadows = true;
    floorMesh.isPickable = true;

    // Create perimeter walls as Wall2D objects
    const hw = roomHalfWidth;
    const hd = roomHalfDepth;
    const perimeterWalls: Wall2D[] = [
        { id: 'backWall', start: { x: -hw, z: hd }, end: { x: hw, z: hd }, mesh: null },
        { id: 'frontWall', start: { x: hw, z: -hd }, end: { x: -hw, z: -hd }, mesh: null },
        { id: 'leftWall', start: { x: -hw, z: -hd }, end: { x: -hw, z: hd }, mesh: null },
        { id: 'rightWall', start: { x: hw, z: hd }, end: { x: hw, z: -hd }, mesh: null }
    ];

    perimeterWalls.forEach(w => {
        customWalls.push(w);
        build3DWallFrom2D(w);
    });
}

function updateRoomDimensions(width: number, depth: number) {
    roomWidth = width;
    roomDepth = depth;
    roomHalfWidth = width / 2;
    roomHalfDepth = depth / 2;

    if (floorMesh) {
        floorMesh.scaling.set(roomWidth, 1, roomDepth);
        if (floorMesh.material instanceof StandardMaterial && floorMesh.material.diffuseTexture) {
            (floorMesh.material.diffuseTexture as Texture).uScale = roomWidth / 2.5;
            (floorMesh.material.diffuseTexture as Texture).vScale = roomDepth / 2.5;
        }
    }

    // Refresh perimeter walls positions
    const hw = roomHalfWidth;
    const hd = roomHalfDepth;

    const back = customWalls.find(w => w.id === 'backWall');
    if (back) { back.start = { x: -hw, z: hd }; back.end = { x: hw, z: hd }; update3DWallFrom2D(back); }

    const front = customWalls.find(w => w.id === 'frontWall');
    if (front) { front.start = { x: hw, z: -hd }; front.end = { x: -hw, z: -hd }; update3DWallFrom2D(front); }

    const left = customWalls.find(w => w.id === 'leftWall');
    if (left) { left.start = { x: -hw, z: -hd }; left.end = { x: -hw, z: hd }; update3DWallFrom2D(left); }

    const right = customWalls.find(w => w.id === 'rightWall');
    if (right) { right.start = { x: hw, z: hd }; right.end = { x: hw, z: -hd }; update3DWallFrom2D(right); }

    // Force all objects to stay within new boundaries
    currentScene.meshes.forEach(m => {
        if (!isInfrastructure(m) && m.name !== '__root__' && !m.name.includes('collider')) {
            const root = getTopLevelMesh(m);
            if (root) applyRoomBoundaries(root);
        }
    });

    // Sync Toolbar UI
    const wInput = document.getElementById('tool-floor-width') as HTMLInputElement;
    const dInput = document.getElementById('tool-floor-depth') as HTMLInputElement;
    if (wInput) wInput.value = roomWidth.toString();
    if (dInput) dInput.value = roomDepth.toString();
}

function isInfrastructure(mesh: AbstractMesh): boolean {
    return mesh.name === 'floor' || mesh.name.includes('Wall');
}

function getTopLevelMesh(mesh: AbstractMesh): AbstractMesh {
    let node = mesh;
    while (node.parent && node.parent instanceof AbstractMesh && node.parent.name !== '__root__') {
        node = node.parent;
    }
    if (node.parent && node.parent instanceof AbstractMesh && node.parent.name === '__root__') {
        node = node.parent;
    }
    return node;
}

function computeMeshWorldBounds(root: AbstractMesh) {
    root.computeWorldMatrix(true);

    const childMeshes = root.getChildMeshes(false);
    const meshesToMeasure = childMeshes.length > 0 ? childMeshes : [root];

    let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

    for (const mesh of meshesToMeasure) {
        mesh.computeWorldMatrix(true);
        const bbox = mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, bbox.minimumWorld);
        max = Vector3.Maximize(max, bbox.maximumWorld);
    }

    if (!isFinite(min.x) || !isFinite(max.x)) {
        const bbox = root.getBoundingInfo().boundingBox;
        min = bbox.minimumWorld.clone();
        max = bbox.maximumWorld.clone();
    }

    return { min, max };
}

function createOrUpdateObjectCollider(root: AbstractMesh): Mesh {
    const { min, max } = computeMeshWorldBounds(root);
    const size = max.subtract(min);
    const center = min.add(max).scale(0.5);

    let collider = objectColliders.get(root);

    if (!collider || collider.isDisposed()) {
        collider = MeshBuilder.CreateBox(`${root.name}_collider`, {
            width: 1,
            height: 1,
            depth: 1
        }, currentScene);

        collider.isVisible = false;
        collider.isPickable = false;
        collider.checkCollisions = false;
        collider.rotationQuaternion = null;

        objectColliders.set(root, collider);
    }

    collider.scaling.set(
        Math.max(size.x, 0.05),
        Math.max(size.y, 0.05),
        Math.max(size.z, 0.05)
    );
    collider.position.copyFrom(center);
    collider.rotation.set(0, 0, 0);
    collider.computeWorldMatrix(true);

    return collider;
}

function updateObjectCollider(root: AbstractMesh) {
    createOrUpdateObjectCollider(root);
}

function disposeObjectCollider(root: AbstractMesh) {
    const collider = objectColliders.get(root);
    if (collider) {
        collider.dispose();
        objectColliders.delete(root);
    }
}

function getMTV(min: Vector3, max: Vector3, wall: AbstractMesh): Vector3 | null {
    // Broad phase AABB check FIRST
    const wallBBox = wall.getBoundingInfo().boundingBox;
    if (min.x > wallBBox.maximumWorld.x || max.x < wallBBox.minimumWorld.x ||
        min.z > wallBBox.maximumWorld.z || max.z < wallBBox.minimumWorld.z) {
        return null;
    }

    const objC = new Vector3((min.x + max.x) / 2, 0, (min.z + max.z) / 2);
    const hX = (max.x - min.x) / 2;
    const hZ = (max.z - min.z) / 2;

    const wallMatrix = wall.getWorldMatrix();

    // Extract local axes transformed to world space
    const uX = Vector3.TransformNormal(new Vector3(1, 0, 0), wallMatrix);
    uX.y = 0; if (uX.lengthSquared() > 0) uX.normalize(); else uX.copyFromFloats(1, 0, 0);

    const uZ = Vector3.TransformNormal(new Vector3(0, 0, 1), wallMatrix);
    uZ.y = 0; if (uZ.lengthSquared() > 0) uZ.normalize(); else uZ.copyFromFloats(0, 0, 1);

    const wallBoundingInfo = wall.getBoundingInfo().boundingBox;
    // Get actual local half-extents applying any scaling the wall has
    const wallHx = (wallBoundingInfo.maximum.x - wallBoundingInfo.minimum.x) / 2 * wall.absoluteScaling.x;
    const wallHz = (wallBoundingInfo.maximum.z - wallBoundingInfo.minimum.z) / 2 * wall.absoluteScaling.z;

    const wallC = wall.getBoundingInfo().boundingBox.centerWorld.clone();
    wallC.y = 0;

    const d = objC.subtract(wallC);

    const axes = [
        new Vector3(1, 0, 0),
        new Vector3(0, 0, 1),
        uX,
        uZ
    ];

    let minOverlap = Infinity;
    let mtv = new Vector3(0, 0, 0);

    for (const axis of axes) {
        // Project object half-extents
        const rObj = hX * Math.abs(axis.x) + hZ * Math.abs(axis.z);
        // Project wall half-extents
        const rWall = wallHx * Math.abs(Vector3.Dot(axis, uX)) + wallHz * Math.abs(Vector3.Dot(axis, uZ));

        // Distance between centers projected on axis
        const dist = Math.abs(Vector3.Dot(d, axis));

        const overlap = rObj + rWall - dist;
        if (overlap <= 0.001) {
            return null; // Separating axis found
        }

        if (overlap < minOverlap) {
            minOverlap = overlap;
            mtv = axis.clone();
            // Ensure push is from wall -> object
            if (Vector3.Dot(d, mtv) < 0) {
                mtv.scaleInPlace(-1);
            }
        }
    }

    return mtv.scale(minOverlap + 0.001);
}

// Returns the correction delta that was applied (zero vector if no correction)
function resolveCollisions(root: AbstractMesh, includeWalls: boolean): Vector3 {
    const totalCorrection = new Vector3(0, 0, 0);
    let { min, max } = computeMeshWorldBounds(root);

    // Build the list of colliders to check
    const colliders: AbstractMesh[] = [];
    if (includeWalls) {
        colliders.push(...roomColliders);
    }
    for (const [p, c] of objectColliders.entries()) {
        if (p === root) continue;
        colliders.push(c);
    }

    // Iterate multiple times to resolve compound/cascading collisions
    for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        for (const other of colliders) {
            if (other === root || getTopLevelMesh(other) === root) continue;

            const mtv = getMTV(min, max, other);
            if (mtv) {
                root.position.addInPlace(mtv);
                totalCorrection.addInPlace(mtv);
                moved = true;

                // Update bounds for the next collider check
                root.computeWorldMatrix(true);
                const newBounds = computeMeshWorldBounds(root);
                min = newBounds.min;
                max = newBounds.max;
            }
        }
        if (!moved) break;
    }

    return totalCorrection;
}

function applyRoomBoundaries(mesh: AbstractMesh): Vector3 {
    const root = getTopLevelMesh(mesh);

    // Force full world-matrix cascade so bounds reflect the LATEST position
    root.computeWorldMatrix(true);
    root.getChildMeshes(false).forEach(c => c.computeWorldMatrix(true));

    let { min, max } = computeMeshWorldBounds(root);
    const totalCorrection = new Vector3(0, 0, 0);

    let dx = 0, dy = 0, dz = 0;
    const margin = wallThickness / 2;

    if (min.x < -roomHalfWidth + margin) dx = -roomHalfWidth + margin - min.x;
    else if (max.x > roomHalfWidth - margin) dx = roomHalfWidth - margin - max.x;

    if (min.z < -roomHalfDepth + margin) dz = -roomHalfDepth + margin - min.z;
    else if (max.z > roomHalfDepth - margin) dz = roomHalfDepth - margin - max.z;

    if (min.y < FLOOR_Y + 0.001 && !(root.metadata?.mountType === 'wall')) dy = (FLOOR_Y + 0.001) - min.y;

    if (dx !== 0 || dy !== 0 || dz !== 0) {
        const correction = new Vector3(dx, dy, dz);
        root.position.addInPlace(correction);
        totalCorrection.addInPlace(correction);

        root.computeWorldMatrix(true);
    }

    // Resolve collisions against walls and other objects
    const collisionCorrection = resolveCollisions(root, true);
    totalCorrection.addInPlace(collisionCorrection);

    if (totalCorrection.lengthSquared() > 0) {
        updateObjectCollider(root);
    }

    return totalCorrection;
}

function isWallMounted(mesh: AbstractMesh): boolean {
    const root = getTopLevelMesh(mesh);
    return root.metadata?.mountType === 'wall';
}

function snapToNearestWall(root: AbstractMesh, useDefaultHeight: boolean = false, preserveRotation: boolean = false) {
    // Temporarily reset rotation to measure unrotated bounds
    const savedRotY = root.rotation.y;
    root.rotation.y = 0;
    root.computeWorldMatrix(true);
    root.getChildMeshes(false).forEach(c => c.computeWorldMatrix(true));
    const { min, max } = computeMeshWorldBounds(root);
    root.rotation.y = savedRotY;

    const center = min.add(max).scale(0.5);
    const sizeX = max.x - min.x;
    const sizeZ = max.z - min.z;
    // The "depth" of the cabinet (the thin side that goes against the wall)
    const objDepthHalf = Math.min(sizeX, sizeZ) / 2;

    // Preserve current Y unless it's initial placement
    const currentY = useDefaultHeight ? WALL_MOUNT_HEIGHT : root.position.y;

    // Build list of all wall segments: perimeter + custom
    type WallSeg = { start: { x: number; z: number }; end: { x: number; z: number }; thickness: number; isPerimeter?: boolean };
    const allWalls: WallSeg[] = [];

    // 4 perimeter walls (room boundary)
    const hw = roomHalfWidth;
    const hd = roomHalfDepth;
    allWalls.push({ start: { x: -hw, z: -hd }, end: { x: hw, z: -hd }, thickness: wallThickness, isPerimeter: true }); // South
    allWalls.push({ start: { x: hw, z: -hd }, end: { x: hw, z: hd }, thickness: wallThickness, isPerimeter: true }); // East
    allWalls.push({ start: { x: hw, z: hd }, end: { x: -hw, z: hd }, thickness: wallThickness, isPerimeter: true }); // North
    allWalls.push({ start: { x: -hw, z: hd }, end: { x: -hw, z: -hd }, thickness: wallThickness, isPerimeter: true }); // West

    // Custom walls
    for (const w of customWalls) {
        allWalls.push({ start: w.start, end: w.end, thickness: w.thickness || wallThickness });
    }

    let bestDist = Infinity;
    let bestSnapX = root.position.x;
    let bestSnapZ = root.position.z;
    let bestRotY = root.rotation.y;
    let bestNormalX = 0;
    let bestNormalZ = 0;

    for (const w of allWalls) {
        const wx = w.end.x - w.start.x;
        const wz = w.end.z - w.start.z;
        const wallLen = Math.sqrt(wx * wx + wz * wz);
        if (wallLen < 0.01) continue;

        const dirX = wx / wallLen;
        const dirZ = wz / wallLen;

        // Base inward normal (perpendicular to wall direction)
        const nx = -dirZ;
        const nz = dirX;

        // Project center onto wall line
        const t = ((center.x - w.start.x) * dirX + (center.z - w.start.z) * dirZ) / wallLen;
        const clampedT = Math.max(0, Math.min(1, t));
        const projX = w.start.x + clampedT * wx;
        const projZ = w.start.z + clampedT * wz;

        const dist = Math.sqrt((center.x - projX) ** 2 + (center.z - projZ) ** 2);

        const isWallMountedObj = root.metadata?.mountType === 'wall';
        if ((isWallMountedObj || dist < 1.2) && dist < bestDist) {
            bestDist = dist;

            // Determine which side of the wall the object center is on
            const toObj = { x: center.x - w.start.x, z: center.z - w.start.z };
            let side = toObj.x * nx + toObj.z * nz;

            // For perimeter walls, always force the inward-facing side
            if (w.isPerimeter) {
                side = 1;
            }

            const finalNormalX = side >= 0 ? nx : -nx;
            const finalNormalZ = side >= 0 ? nz : -nz;

            const thickness = (w.thickness || wallThickness) / 2;
            bestSnapX = projX + finalNormalX * (thickness + objDepthHalf);
            bestSnapZ = projZ + finalNormalZ * (thickness + objDepthHalf);
            bestNormalX = finalNormalX;
            bestNormalZ = finalNormalZ;

            // Wall normal angle: the direction the object should face (outward from wall)
            bestRotY = Math.atan2(finalNormalX, finalNormalZ);
        }
    }

    root.position.x = bestSnapX;
    root.position.z = bestSnapZ;
    root.position.y = currentY;

    if (!preserveRotation) {
        // Crucial: nullify rotationQuaternion to allow rotation.y to work
        root.rotationQuaternion = null;
        root.rotation.y = bestRotY;
    }

    // Resolve collisions against walls and other objects
    resolveCollisions(root, true);

    // Re-snap to ensure collision resolution didn't push us away from the wall surface
    // by projecting the current position onto the wall plane
    const dx = root.position.x - bestSnapX;
    const dz = root.position.z - bestSnapZ;
    const pushOutDist = dx * bestNormalX + dz * bestNormalZ;

    root.position.x -= pushOutDist * bestNormalX;
    root.position.z -= pushOutDist * bestNormalZ;

    // Recompute bounds after rotation to clamp Y properly
    root.computeWorldMatrix(true);
    root.getChildMeshes(false).forEach(c => c.computeWorldMatrix(true));
    const boundsAfter = computeMeshWorldBounds(root);
    const objHalfH = (boundsAfter.max.y - boundsAfter.min.y) / 2;
    if (root.position.y - objHalfH < FLOOR_Y) {
        root.position.y = FLOOR_Y + objHalfH;
    }
    if (root.position.y + objHalfH > wallHeight) {
        root.position.y = wallHeight - objHalfH;
    }

    updateObjectCollider(root);
}

function clearDimensionMarkers() {
    dimensionMarkers.forEach(m => m.dispose());
    dimensionMarkers.length = 0;
}

function disposeWallMeshes(wall: Wall2D) {
    if (wall.mesh) {
        disposeWallCaps(wall.mesh);
        const idx = roomColliders.indexOf(wall.mesh);
        if (idx > -1) roomColliders.splice(idx, 1);
        wall.mesh.dispose();
        wall.mesh = null;
    }
    if (wall.decorativeMeshes) {
        wall.decorativeMeshes.forEach(m => m.dispose());
        wall.decorativeMeshes = [];
    }
}

function deleteWall(wall: Wall2D) {
    const idx = customWalls.indexOf(wall);
    if (idx > -1) {
        customWalls.splice(idx, 1);
        disposeWallMeshes(wall);
        // Rebuild connected walls to revert their miters to flat
        for (const other of customWalls) {
            if (pointsMatch(wall.start, other.start) || pointsMatch(wall.start, other.end) ||
                pointsMatch(wall.end, other.start) || pointsMatch(wall.end, other.end)) {
                build3DWallFrom2D(other, false);
            }
        }
    }
    if (selectedWall2D === wall) selectWall2D(null);
}

function deleteSelectedObject() {
    if (is2DMode && selectedWall2D) {
        deleteWall(selectedWall2D);
        draw2D();
        saveToHistory();
        return;
    }

    if (!selectedMesh) return;
    const root = getTopLevelMesh(selectedMesh);

    // If it's a wall
    const wall = customWalls.find(w => w.mesh === root);
    if (wall) {
        deleteWall(wall);
    } else if (!isInfrastructure(root)) {
        disposeObjectCollider(root);
        root.dispose();
    }

    selectedMesh = null;
    gizmoManager.attachToMesh(null);
    clearDimensionMarkers();
    const objTools = document.getElementById('object-tools');
    if (objTools) objTools.style.display = 'none';
    draw2D();
    saveToHistory();
}

function createDimensionLabel(distance: number, start: Vector3, end: Vector3, scene: Scene): Mesh {
    const text = distance >= 1 ? `${distance.toFixed(2)}m` : `${Math.round(distance * 1000)}mm`;

    const plane = MeshBuilder.CreatePlane("dimLabel", { size: 0.35 }, scene);
    const dt = new DynamicTexture("dimTex", { width: 256, height: 128 }, scene, false);
    dt.hasAlpha = true;

    const mat = new StandardMaterial("dimLabelMat", scene);
    mat.diffuseTexture = dt;
    mat.useAlphaFromDiffuseTexture = true;
    mat.diffuseColor = Color3.White();
    mat.emissiveColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    plane.material = mat;

    // Drawing the text in WHITE so it can be colored by the material's diffuse/emissive color
    dt.drawText(text, null, null, "bold 64px 'Open Sans', sans-serif", "#ffffff", "transparent", true);

    // Position label in the middle of the line, slightly offset
    const mid = start.add(end).scale(0.5);
    plane.position.copyFrom(mid);
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;

    return plane;
}

function updateDimensionMarkers(mesh: AbstractMesh) {
    clearDimensionMarkers();
    const root = getTopLevelMesh(mesh);
    const { min, max } = computeMeshWorldBounds(root);
    const center = min.add(max).scale(0.5);
    const scene = mesh.getScene();

    const hw = roomHalfWidth;
    const hd = roomHalfDepth;

    // Floor detection: heuristic 0.05m
    const isAerial = min.y > 0.05;

    // Dimensions to check: Left(-X), Right(+X), Front(+Z), Back(-Z), Floor(-Y), Ceiling(+Y)
    const points = [
        { axis: 'x', target: -hw, val: min.x, start: new Vector3(min.x, center.y, center.z), end: new Vector3(-hw, center.y, center.z) },
        { axis: 'x', target: hw, val: max.x, start: new Vector3(max.x, center.y, center.z), end: new Vector3(hw, center.y, center.z) },
        { axis: 'z', target: -hd, val: min.z, start: new Vector3(center.x, center.y, min.z), end: new Vector3(center.x, center.y, -hd) },
        { axis: 'z', target: hd, val: max.z, start: new Vector3(center.x, center.y, max.z), end: new Vector3(center.x, center.y, hd) }
    ];

    if (isAerial) {
        points.push({ axis: 'y', target: 0, val: min.y, start: new Vector3(center.x, min.y, center.z), end: new Vector3(center.x, 0, center.z) });
        points.push({ axis: 'y', target: 3.0, val: max.y, start: new Vector3(center.x, max.y, center.z), end: new Vector3(center.x, 3.0, center.z) });
    }

    points.forEach(p => {
        const dist = Math.abs(p.target - p.val);
        if (dist > 0.01) {
            const line = MeshBuilder.CreateDashedLines("dimLine", {
                points: [p.start, p.end],
                dashSize: 0.1,
                gapSize: 0.05,
                dashNb: 20
            }, scene);
            line.color = new Color3(0, 0, 0);
            line.isPickable = false;
            dimensionMarkers.push(line);

            const label = createDimensionLabel(dist, p.start, p.end, scene);
            dimensionMarkers.push(label);
        }
    });
}

// Drag state for manual dragging
let isDraggingMesh = false;


// ─── 2D Wall System Functions ───────────────────────────────────────────────

function enter2DMode() {
    is2DMode = true;
    selectedMesh = null;
    gizmoManager.attachToMesh(null);
    clearDimensionMarkers();

    if (!wallCanvas2D) {
        const container = document.querySelector('.canvas-container') as HTMLElement;
        container.style.position = 'relative';
        container.style.overflow = 'hidden';

        // 2D drawing canvas
        wallCanvas2D = document.createElement('canvas');
        wallCanvas2D.id = 'wallCanvas2D';
        Object.assign(wallCanvas2D.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            cursor: 'crosshair', zIndex: '10', display: 'none'
        });
        container.appendChild(wallCanvas2D);

        // Top instruction bar (Instruction only)
        const bar = document.createElement('div');
        bar.id = 'wall2d-bar';
        Object.assign(bar.style, {
            position: 'absolute', top: '0', left: '0', right: '0',
            height: '32px', background: 'rgba(0,0,0,0.8)', color: '#fff',
            display: 'none', alignItems: 'center',
            justifyContent: 'center', padding: '0 16px',
            zIndex: '11', fontFamily: 'Open Sans, sans-serif', fontSize: '11px',
            boxSizing: 'border-box'
        });
        bar.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span><b>Construção de Paredes</b> — Clique e arraste para desenhar. Pontos <span style="color:#FF8533">●</span> = encaixe automático.</span>
            </div>
        `;
        container.appendChild(bar);

        document.getElementById('wall2d-length-input-toolbar')?.addEventListener('input', (e) => {
            if (!selectedWall2D) return;
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(val) && val >= 0.05) {
                const w = selectedWall2D;
                const dx = w.end.x - w.start.x;
                const dz = w.end.z - w.start.z;
                const angle = Math.atan2(dz, dx);
                w.end.x = w.start.x + val * Math.cos(angle);
                w.end.z = w.start.z + val * Math.sin(angle);
                draw2D();
                update3DWallFrom2D(w);
            }
        });
        document.getElementById('wall2d-length-input-toolbar')?.addEventListener('keydown', (e) => e.stopPropagation());

        document.getElementById('tool-exit-2d-toolbar')?.addEventListener('click', exit2DMode);
        document.getElementById('tool-undo-wall-toolbar')?.addEventListener('click', () => {
            const last = customWalls.pop();
            if (last) {
                disposeWallMeshes(last);
                if (selectedWall2D === last) selectWall2D(null);
                // Rebuild connected walls to revert their miters to flat
                for (const other of customWalls) {
                    if (pointsMatch(last.start, other.start) || pointsMatch(last.start, other.end) ||
                        pointsMatch(last.end, other.start) || pointsMatch(last.end, other.end)) {
                        build3DWallFrom2D(other, false);
                    }
                }
            }
            draw2D();
        });

        document.getElementById('tool-delete-wall-toolbar')?.addEventListener('click', deleteSelectedObject);

        setup2DCanvasEvents();
    }

    resize2DCanvas();
    wallCtx2D = wallCanvas2D.getContext('2d');
    wallCanvas2D.style.display = 'block';
    const bar = document.getElementById('wall2d-bar')!;
    bar.style.display = 'flex';
    const toolbar = document.getElementById('wall-tools-toolbar');
    if (toolbar) toolbar.style.display = 'flex';
    document.getElementById('tool-undo-wall-toolbar')!.style.display = 'flex';
    document.getElementById('tool-exit-2d-toolbar')!.style.display = 'flex';
    document.getElementById('wall-length-container')!.style.display = 'none';
    selectWall2D(null);
    draw2D();
}

function exit2DMode() {
    is2DMode = false;
    isDrawingWall = false;
    wallDrawStart = null;
    wallDrawPreview = null;
    activeSnapPoint = null;
    selectedWall2D = null;
    isModifyingWall = false;
    modifiedWallEnd = null;
    selectWall2D(null);
    if (wallCanvas2D) wallCanvas2D.style.display = 'none';
    const bar = document.getElementById('wall2d-bar');
    if (bar) bar.style.display = 'none';
    const toolbar = document.getElementById('wall-tools-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    saveToHistory();
}

function resize2DCanvas() {
    if (!wallCanvas2D) return;
    const container = document.querySelector('.canvas-container') as HTMLElement;
    wallCanvas2D.width = container.clientWidth;
    wallCanvas2D.height = container.clientHeight;
    const margin = 80;
    const headerH = 48;
    const availW = wallCanvas2D.width - margin * 2;
    const availH = wallCanvas2D.height - margin * 2 - headerH;
    pxPerMeter = Math.max(20, Math.min(availW / roomWidth, availH / roomDepth));
}

function worldToCanvas2D(x: number, z: number) {
    return {
        cx: wallCanvas2D!.width / 2 + x * pxPerMeter,
        cy: wallCanvas2D!.height / 2 + 24 - z * pxPerMeter
    };
}

function canvasToWorld2D(cx: number, cy: number) {
    return {
        x: (cx - wallCanvas2D!.width / 2) / pxPerMeter,
        z: (wallCanvas2D!.height / 2 + 24 - cy) / pxPerMeter
    };
}

function getAllSnapPoints2D(): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    // Room corners
    const hw = roomHalfWidth, hd = roomHalfDepth;
    pts.push({ x: -hw, z: -hd }, { x: hw, z: -hd },
        { x: -hw, z: hd }, { x: hw, z: hd });
    // Room edge midpoints
    pts.push({ x: 0, z: -hd }, { x: 0, z: hd },
        { x: -hw, z: 0 }, { x: hw, z: 0 });
    // Custom wall endpoints
    for (const w of customWalls) {
        if (isModifyingWall && w === selectedWall2D) continue; // don't snap to itself when modifying
        pts.push({ ...w.start }, { ...w.end });
    }
    return pts;
}

function snapToAngles(fixed: { x: number, z: number }, target: { x: number, z: number }) {
    const dx = target.x - fixed.x;
    const dz = target.z - fixed.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.05) return target;

    const angle = Math.atan2(dz, dx);
    const degrees = (angle * 180 / Math.PI + 360) % 360;

    // Snap to 45 degree increments
    const snapInterval = 45;
    const snappedDegrees = Math.round(degrees / snapInterval) * snapInterval;

    if (Math.abs(degrees - snappedDegrees) < 5 || Math.abs(degrees - snappedDegrees + 360) < 5 || Math.abs(degrees - snappedDegrees - 360) < 5) {
        const snappedAngle = (snappedDegrees % 360) * Math.PI / 180;
        return {
            x: fixed.x + dist * Math.cos(snappedAngle),
            z: fixed.z + dist * Math.sin(snappedAngle)
        };
    }
    return target;
}

function findSnap2D(cx: number, cy: number): { x: number; z: number } | null {
    const pts = getAllSnapPoints2D();
    let best: { x: number; z: number } | null = null;
    let bestDist = SNAP_RADIUS_PX;
    for (const pt of pts) {
        const { cx: px, cy: py } = worldToCanvas2D(pt.x, pt.z);
        const d = Math.hypot(cx - px, cy - py);
        if (d < bestDist) { bestDist = d; best = pt; }
    }
    return best;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
    const l2 = (x1 - x2) ** 2 + (y1 - y2) ** 2;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * (x2 - x1);
    const projY = y1 + t * (y2 - y1);
    return Math.hypot(px - projX, py - projY);
}

function getWallAt(cx: number, cy: number): Wall2D | null {
    let bestDist = 15;
    let bestWall = null;
    for (const w of customWalls) {
        const s = worldToCanvas2D(w.start.x, w.start.z);
        const e = worldToCanvas2D(w.end.x, w.end.z);
        const d = distToSegment(cx, cy, s.cx, s.cy, e.cx, e.cy);
        if (d < bestDist) {
            bestDist = d;
            bestWall = w;
        }
    }
    return bestWall;
}

function selectWall2D(w: Wall2D | null) {
    selectedWall2D = w;
    const input = document.getElementById('wall2d-length-input-toolbar') as HTMLInputElement;
    const deleteBtn = document.getElementById('tool-delete-wall-toolbar');
    if (w) {
        if (input) {
            const dx = w.end.x - w.start.x;
            const dz = w.end.z - w.start.z;
            const length = Math.sqrt(dx * dx + dz * dz);
            input.value = length.toFixed(2);
        }
        if (deleteBtn) deleteBtn.style.display = 'flex';
        document.getElementById('wall-length-container')!.style.display = 'flex';
    } else {
        if (input) {
            input.value = '';
            input.blur();
        }
        if (deleteBtn) deleteBtn.style.display = 'none';
        document.getElementById('wall-length-container')!.style.display = 'none';
    }
    draw2D();
}



function draw2D() {
    if (!wallCanvas2D || !wallCtx2D) return;
    const ctx = wallCtx2D;
    const W = wallCanvas2D.width;
    const H = wallCanvas2D.height;

    ctx.clearRect(0, 0, W, H);

    // Exterior background
    ctx.fillStyle = '#9e9e9e';
    ctx.fillRect(0, 0, W, H);

    // Room floor
    const tl = worldToCanvas2D(-roomHalfWidth, -roomHalfDepth);
    const br = worldToCanvas2D(roomHalfWidth, roomHalfDepth);
    const rW = br.cx - tl.cx;
    const rH = br.cy - tl.cy;

    // Floor pattern
    ctx.fillStyle = '#d4b57a';
    ctx.fillRect(tl.cx, tl.cy, rW, rH);
    // Subtle floor lines
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    const lineSpacing = Math.max(pxPerMeter * 0.4, 8);
    for (let lx = tl.cx; lx < br.cx; lx += lineSpacing) {
        ctx.beginPath(); ctx.moveTo(lx, tl.cy); ctx.lineTo(lx, br.cy); ctx.stroke();
    }

    // Room area visual
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(tl.cx, tl.cy, rW, rH);

    // Custom walls
    const wallPxW = Math.max(wallThickness * pxPerMeter, 8);
    for (const w of customWalls) {
        const isSelected = w === selectedWall2D;
        const t = w.thickness || wallThickness;
        const currPxW = Math.max(t * pxPerMeter, 8);
        const s = worldToCanvas2D(w.start.x, w.start.z);
        const e = worldToCanvas2D(w.end.x, w.end.z);

        if (isSelected) {
            ctx.lineWidth = currPxW + 6;
            ctx.strokeStyle = '#FF8533';
            ctx.lineCap = 'square';
            ctx.beginPath(); ctx.moveTo(s.cx, s.cy); ctx.lineTo(e.cx, e.cy); ctx.stroke();
        }

        // Shadow
        ctx.lineWidth = currPxW + 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineCap = 'square';
        ctx.beginPath(); ctx.moveTo(s.cx + 2, s.cy + 2); ctx.lineTo(e.cx + 2, e.cy + 2); ctx.stroke();
        // Wall
        ctx.lineWidth = currPxW;
        ctx.strokeStyle = '#2a2a2a';
        ctx.beginPath(); ctx.moveTo(s.cx, s.cy); ctx.lineTo(e.cx, e.cy); ctx.stroke();
        // Highlight
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath(); ctx.moveTo(s.cx, s.cy); ctx.lineTo(e.cx, e.cy); ctx.stroke();
    }

    // Snap points
    const snapPts = getAllSnapPoints2D();
    for (const pt of snapPts) {
        const { cx, cy } = worldToCanvas2D(pt.x, pt.z);
        ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Active snap highlight (magnet indicator)
    if (activeSnapPoint) {
        const { cx, cy } = worldToCanvas2D(activeSnapPoint.x, activeSnapPoint.z);
        ctx.beginPath(); ctx.arc(cx, cy, SNAP_RADIUS_PX, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,133,51,0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#FF8533';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Wall preview while drawing
    if (isDrawingWall && wallDrawStart && wallDrawPreview) {
        const s = worldToCanvas2D(wallDrawStart.x, wallDrawStart.z);
        const e = worldToCanvas2D(wallDrawPreview.x, wallDrawPreview.z);

        // Preview wall
        ctx.lineWidth = wallPxW;
        ctx.strokeStyle = 'rgba(0,180,90,0.85)';
        ctx.lineCap = 'round';
        ctx.setLineDash([10, 6]);
        ctx.beginPath(); ctx.moveTo(s.cx, s.cy); ctx.lineTo(e.cx, e.cy); ctx.stroke();
        ctx.setLineDash([]);

        // Start dot
        ctx.beginPath(); ctx.arc(s.cx, s.cy, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#00c864'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();

        // Dimension label
        const dx = wallDrawPreview.x - wallDrawStart.x;
        const dz = wallDrawPreview.z - wallDrawStart.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.05) {
            const midX = (s.cx + e.cx) / 2;
            const midY = (s.cy + e.cy) / 2;
            const angle = Math.atan2(e.cy - s.cy, e.cx - s.cx);
            const offset = 18;
            const lx = midX - Math.sin(angle) * offset;
            const ly = midY + Math.cos(angle) * offset;

            const label = dist >= 1
                ? `${dist.toFixed(2)} m`
                : `${Math.round(dist * 100)} cm`;

            ctx.font = 'bold 12px "Open Sans", sans-serif';
            const tw = ctx.measureText(label).width;

            ctx.fillStyle = 'rgba(0,0,0,0.75)';
            ctx.beginPath();
            ctx.rect(lx - tw / 2 - 6, ly - 10, tw + 12, 20);
            ctx.fill();

            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, lx, ly);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        }
    } else if (isDrawingWall && wallDrawStart) {
        const s = worldToCanvas2D(wallDrawStart.x, wallDrawStart.z);
        ctx.beginPath(); ctx.arc(s.cx, s.cy, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#00c864'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Grid reference label (top-left of room)
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(`${roomWidth}m × ${roomDepth}m`, tl.cx + 6, tl.cy + 16);

    if (selectedWall2D) {
        const s = worldToCanvas2D(selectedWall2D.start.x, selectedWall2D.start.z);
        const eNode = worldToCanvas2D(selectedWall2D.end.x, selectedWall2D.end.z);

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FF8533';

        ctx.beginPath(); ctx.arc(s.cx, s.cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();

        ctx.beginPath(); ctx.arc(eNode.cx, eNode.cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    }
}

function disposeWallCaps(mesh: AbstractMesh): void {
    const caps = wallCapMap.get(mesh);
    if (caps) { caps.forEach(c => c.dispose()); wallCapMap.delete(mesh); }
}

// ── Miter Joint Helpers ─────────────────────────────────────────────────────
const POINT_TOLERANCE = 0.02;

function pointsMatch(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    return Math.abs(a.x - b.x) < POINT_TOLERANCE && Math.abs(a.z - b.z) < POINT_TOLERANCE;
}

function findConnectedWall(wall: Wall2D, endpoint: 'start' | 'end'): Wall2D | null {
    const pt = wall[endpoint];
    for (const other of customWalls) {
        if (other === wall) continue;
        if (pointsMatch(pt, other.start) || pointsMatch(pt, other.end)) {
            return other;
        }
    }
    return null;
}

function lineIntersection2D(
    p1: { x: number; z: number }, d1: { x: number; z: number },
    p2: { x: number; z: number }, d2: { x: number; z: number }
): { x: number; z: number } | null {
    const denom = d1.x * d2.z - d1.z * d2.x;
    if (Math.abs(denom) < 1e-10) return null;
    const t = ((p2.x - p1.x) * d2.z - (p2.z - p1.z) * d2.x) / denom;
    return { x: p1.x + t * d1.x, z: p1.z + t * d1.z };
}

function computeWallCorners(wall: Wall2D, thicknessOverride?: number): { x: number; z: number }[] {
    const sx = wall.start.x, sz = wall.start.z;
    const ex = wall.end.x, ez = wall.end.z;
    const dx = ex - sx, dz = ez - sz;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return [];

    const udx = dx / len, udz = dz / len;
    const currentThickness = thicknessOverride !== undefined ? thicknessOverride : (wall.thickness || wallThickness);
    const halfT = currentThickness / 2;
    // Left normal (perpendicular, rotated -90 deg)
    const nlx = -udz, nlz = udx;

    // Default flat corners
    let startLeft = { x: sx + nlx * halfT, z: sz + nlz * halfT };
    let startRight = { x: sx - nlx * halfT, z: sz - nlz * halfT };
    let endLeft = { x: ex + nlx * halfT, z: ez + nlz * halfT };
    let endRight = { x: ex - nlx * halfT, z: ez - nlz * halfT };

    // Check for connected wall at START
    const connStart = findConnectedWall(wall, 'start');
    if (connStart) {
        // Direction of connected wall pointing away from the shared point
        let csx: number, csz: number;
        if (pointsMatch(wall.start, connStart.start)) {
            csx = connStart.end.x - connStart.start.x;
            csz = connStart.end.z - connStart.start.z;
        } else {
            csx = connStart.start.x - connStart.end.x;
            csz = connStart.start.z - connStart.end.z;
        }
        const cLen = Math.sqrt(csx * csx + csz * csz);
        if (cLen > 0.001) {
            const cudx = csx / cLen, cudz = csz / cLen;
            const cThickness = thicknessOverride !== undefined ? thicknessOverride : (connStart.thickness || wallThickness);
            const cHalfT = cThickness / 2;
            const cnlx = -cudz, cnlz = cudx;

            // Cross-intersect: left edge of this wall meets the RIGHT edge of connected wall
            const iLeft = lineIntersection2D(
                { x: sx + nlx * halfT, z: sz + nlz * halfT }, { x: udx, z: udz },
                { x: sx - cnlx * cHalfT, z: sz - cnlz * cHalfT }, { x: cudx, z: cudz }
            );
            // Cross-intersect: right edge of this wall meets the LEFT edge of connected wall
            const iRight = lineIntersection2D(
                { x: sx - nlx * halfT, z: sz - nlz * halfT }, { x: udx, z: udz },
                { x: sx - cnlx * cHalfT, z: sz - cnlz * cHalfT }, { x: cudx, z: cudz }
            );

            // Sanity check: don't let miter extend too far (max 3x halfT from endpoint)
            const maxExt = halfT * 3;
            if (iLeft) {
                const dxl = iLeft.x - sx, dzl = iLeft.z - sz;
                if (Math.sqrt(dxl * dxl + dzl * dzl) < maxExt) startLeft = iLeft;
            }
            if (iRight) {
                const dxr = iRight.x - sx, dzr = iRight.z - sz;
                if (Math.sqrt(dxr * dxr + dzr * dzr) < maxExt) startRight = iRight;
            }
        }
    }

    // Check for connected wall at END
    const connEnd = findConnectedWall(wall, 'end');
    if (connEnd) {
        let cex: number, cez: number;
        if (pointsMatch(wall.end, connEnd.start)) {
            cex = connEnd.end.x - connEnd.start.x;
            cez = connEnd.end.z - connEnd.start.z;
        } else {
            cex = connEnd.start.x - connEnd.end.x;
            cez = connEnd.start.z - connEnd.end.z;
        }
        const cLen = Math.sqrt(cex * cex + cez * cez);
        if (cLen > 0.001) {
            const cudx = cex / cLen, cudz = cez / cLen;
            const cThickness = thicknessOverride !== undefined ? thicknessOverride : (connEnd.thickness || wallThickness);
            const cHalfT = cThickness / 2;
            const cnlx = -cudz, cnlz = cudx;

            // Cross-intersect: left edge of this wall meets the RIGHT edge of connected wall
            const iLeft = lineIntersection2D(
                { x: ex + nlx * halfT, z: ez + nlz * halfT }, { x: -udx, z: -udz },
                { x: ex - cnlx * cHalfT, z: ez - cnlz * cHalfT }, { x: cudx, z: cudz }
            );
            // Cross-intersect: right edge of this wall meets the LEFT edge of connected wall
            const iRight = lineIntersection2D(
                { x: ex - nlx * halfT, z: ez - nlz * halfT }, { x: -udx, z: -udz },
                { x: ex + cnlx * cHalfT, z: ez + cnlz * cHalfT }, { x: cudx, z: cudz }
            );

            const maxExt = halfT * 3;
            if (iLeft) {
                const dxl = iLeft.x - ex, dzl = iLeft.z - ez;
                if (Math.sqrt(dxl * dxl + dzl * dzl) < maxExt) endLeft = iLeft;
            }
            if (iRight) {
                const dxr = iRight.x - ex, dzr = iRight.z - ez;
                if (Math.sqrt(dxr * dxr + dzr * dzr) < maxExt) endRight = iRight;
            }
        }
    }

    // Return corners in CCW order (top-down view)
    return [startLeft, endLeft, endRight, startRight];
}

function createWallMeshFromCorners(
    corners: { x: number; z: number }[], yBottom: number, yTop: number, id: string, scene: Scene
): Mesh {
    const n = corners.length; // typically 4
    // Bottom ring at y=yBottom, top ring at y=yTop
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];

    // vertex index counter
    let vi = 0;

    // ── Bottom face (y = yBottom), normal (0, -1, 0) ──
    for (let i = 0; i < n; i++) {
        positions.push(corners[i].x, yBottom, corners[i].z);
        normals.push(0, -1, 0);
    }
    // Triangulate as fan
    for (let i = 1; i < n - 1; i++) {
        indices.push(vi, vi + i + 1, vi + i);
    }
    vi += n;

    // ── Top face (y = yTop), normal (0, 1, 0) ──
    for (let i = 0; i < n; i++) {
        positions.push(corners[i].x, yTop, corners[i].z);
        normals.push(0, 1, 0);
    }
    for (let i = 1; i < n - 1; i++) {
        indices.push(vi, vi + i, vi + i + 1);
    }
    vi += n;

    // ── Side faces ──
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const c0 = corners[i], c1 = corners[j];

        // Compute outward normal for this side edge
        const edx = c1.x - c0.x, edz = c1.z - c0.z;
        const eLen = Math.sqrt(edx * edx + edz * edz);
        const nx = edz / (eLen || 1), nz = -edx / (eLen || 1); // perpendicular pointing outward

        // 4 vertices for this quad
        positions.push(c0.x, yBottom, c0.z); normals.push(nx, 0, nz);
        positions.push(c1.x, yBottom, c1.z); normals.push(nx, 0, nz);
        positions.push(c1.x, yTop, c1.z); normals.push(nx, 0, nz);
        positions.push(c0.x, yTop, c0.z); normals.push(nx, 0, nz);

        // Two triangles
        indices.push(vi, vi + 1, vi + 2);
        indices.push(vi, vi + 2, vi + 3);
        vi += 4;
    }

    const mesh = new Mesh(id, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);

    return mesh;
}

function getWallsConnectedTo(wall: Wall2D): Wall2D[] {
    const result: Wall2D[] = [];
    for (const other of customWalls) {
        if (other === wall) continue;
        if (pointsMatch(wall.start, other.start) || pointsMatch(wall.start, other.end) ||
            pointsMatch(wall.end, other.start) || pointsMatch(wall.end, other.end)) {
            result.push(other);
        }
    }
    return result;
}

function build3DWallFrom2D(w: Wall2D, rebuildConnected = true) {
    // Dispose previous mesh
    if (w.mesh) {
        disposeWallCaps(w.mesh);
        const idx = roomColliders.indexOf(w.mesh);
        if (idx > -1) roomColliders.splice(idx, 1);
        w.mesh.dispose();
        w.mesh = null;
    }
    if (w.decorativeMeshes) {
        w.decorativeMeshes.forEach(m => m.dispose());
        w.decorativeMeshes = [];
    }

    const corners = computeWallCorners(w);
    if (corners.length < 3) return;

    // Calculate center and rotation for OBB-based collision
    const centerX = (w.start.x + w.end.x) / 2;
    const centerZ = (w.start.z + w.end.z) / 2;
    const dx = w.end.x - w.start.x;
    const dz = w.end.z - w.start.z;
    const angle = Math.atan2(dz, dx);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Transform corners to local space (centered at 0,0 and aligned with X)
    const localCorners = corners.map(c => ({
        x: (c.x - centerX) * cosA + (c.z - centerZ) * sinA,
        z: -(c.x - centerX) * sinA + (c.z - centerZ) * cosA
    }));

    const mesh = createWallMeshFromCorners(localCorners, 0, wallHeight, w.id, currentScene);
    mesh.position.set(centerX, 0, centerZ);
    mesh.rotation.y = -angle;
    mesh.refreshBoundingInfo();
    mesh.isPickable = true;

    const wallColor = new Color3(0.96, 0.96, 0.94); // Premium off-white
    const mat = new StandardMaterial(w.id + '_mat', currentScene);
    mat.diffuseColor = wallColor;
    mat.emissiveColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;
    mesh.material = mat;

    roomColliders.push(mesh);
    w.mesh = mesh;

    // Build decorative moldings
    w.decorativeMeshes = [];
    const decoMat = new StandardMaterial(w.id + '_deco_mat', currentScene);
    decoMat.diffuseColor = new Color3(0.98, 0.98, 0.98); // Brighter white for moldings
    decoMat.specularColor = new Color3(0.1, 0.1, 0.1);

    const decoThickness = (w.thickness || wallThickness) + 0.015;
    const decoCorners = computeWallCorners(w, decoThickness);
    const localDecoCorners = decoCorners.map(c => ({
        x: (c.x - centerX) * cosA + (c.z - centerZ) * sinA,
        z: -(c.x - centerX) * sinA + (c.z - centerZ) * cosA
    }));

    // Skirting (baseboard)
    const skirting = createWallMeshFromCorners(localDecoCorners, 0, 0.08, w.id + '_skirting', currentScene);
    skirting.position.set(centerX, 0.001, centerZ); // tiny offset to avoid z-fighting with floor
    skirting.rotation.y = -angle;
    skirting.material = decoMat;
    skirting.isPickable = false;
    w.decorativeMeshes.push(skirting);

    // Crown molding (sanca)
    const crown = createWallMeshFromCorners(localDecoCorners, wallHeight - 0.05, wallHeight, w.id + '_crown', currentScene);
    crown.position.set(centerX, 0, centerZ);
    crown.rotation.y = -angle;
    crown.material = decoMat;
    crown.isPickable = false;
    w.decorativeMeshes.push(crown);

    // Rebuild any walls that share an endpoint so their miters update
    if (rebuildConnected) {
        const connected = getWallsConnectedTo(w);
        for (const cw of connected) {
            build3DWallFrom2D(cw, false);
        }
    }
}

function update3DWallFrom2D(w: Wall2D) {
    build3DWallFrom2D(w);
}

function setup2DCanvasEvents() {
    if (!wallCanvas2D) return;

    const getPos = (e: MouseEvent) => {
        const rect = wallCanvas2D!.getBoundingClientRect();
        return {
            cx: (e.clientX - rect.left) * (wallCanvas2D!.width / rect.width),
            cy: (e.clientY - rect.top) * (wallCanvas2D!.height / rect.height)
        };
    };

    wallCanvas2D.addEventListener('mousedown', (e) => {
        if (!is2DMode || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const { cx, cy } = getPos(e);

        if (selectedWall2D) {
            const s = worldToCanvas2D(selectedWall2D.start.x, selectedWall2D.start.z);
            const e2d = worldToCanvas2D(selectedWall2D.end.x, selectedWall2D.end.z);
            if (Math.hypot(cx - s.cx, cy - s.cy) < 15) {
                isModifyingWall = true;
                modifiedWallEnd = 'start';
                activeSnapPoint = null;
                return;
            }
            if (Math.hypot(cx - e2d.cx, cy - e2d.cy) < 15) {
                isModifyingWall = true;
                modifiedWallEnd = 'end';
                activeSnapPoint = null;
                return;
            }
        }

        const snap = findSnap2D(cx, cy);
        wallDrawStart = snap ?? canvasToWorld2D(cx, cy);
        wallDrawPreview = { ...wallDrawStart };
        isDrawingWall = true;
        draw2D();
    });

    wallCanvas2D.addEventListener('mousemove', (e) => {
        if (!is2DMode) return;
        const { cx, cy } = getPos(e);
        activeSnapPoint = findSnap2D(cx, cy);

        if (isModifyingWall && selectedWall2D && modifiedWallEnd) {
            const worldPos = canvasToWorld2D(cx, cy);
            const otherEnd = modifiedWallEnd === 'start' ? selectedWall2D.end : selectedWall2D.start;
            const pt = activeSnapPoint ?? snapToAngles(otherEnd, worldPos);
            selectedWall2D[modifiedWallEnd] = { ...pt };

            const dx = selectedWall2D.end.x - selectedWall2D.start.x;
            const dz = selectedWall2D.end.z - selectedWall2D.start.z;
            const length = Math.sqrt(dx * dx + dz * dz);
            const input = document.getElementById('wall2d-length-input') as HTMLInputElement;
            if (input) input.value = length.toFixed(2);

            draw2D();
            return;
        }

        if (isDrawingWall && wallDrawStart) {
            const worldPos = canvasToWorld2D(cx, cy);
            wallDrawPreview = activeSnapPoint ?? snapToAngles(wallDrawStart, worldPos);
        }
        draw2D();
    });

    wallCanvas2D.addEventListener('mouseup', (e) => {
        if (!is2DMode) return;
        e.preventDefault();

        if (isModifyingWall && selectedWall2D) {
            isModifyingWall = false;
            modifiedWallEnd = null;
            update3DWallFrom2D(selectedWall2D);
            draw2D();
            return;
        }

        if (!isDrawingWall || !wallDrawStart) return;
        const { cx, cy } = getPos(e);
        const snap = findSnap2D(cx, cy);
        const endPt = snap ?? snapToAngles(wallDrawStart, canvasToWorld2D(cx, cy));
        const dx = endPt.x - wallDrawStart.x;
        const dz = endPt.z - wallDrawStart.z;

        if (Math.sqrt(dx * dx + dz * dz) > 0.05) {
            const wall: Wall2D = {
                id: 'customWall_' + Date.now(),
                start: { ...wallDrawStart },
                end: { ...endPt },
                mesh: null,
                thickness: wallThickness
            };
            customWalls.push(wall);
            build3DWallFrom2D(wall);
            selectWall2D(null);
        } else {
            const hitWall = getWallAt(cx, cy);
            selectWall2D(hitWall);
        }

        isDrawingWall = false;
        wallDrawStart = null;
        wallDrawPreview = null;
        draw2D();
    });

    // Cancel current wall on right-click
    wallCanvas2D.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        isDrawingWall = false;
        wallDrawStart = null;
        wallDrawPreview = null;
        draw2D();
    });

    // Touch support
    const getTouchPos = (touch: Touch) => {
        const rect = wallCanvas2D!.getBoundingClientRect();
        return {
            cx: (touch.clientX - rect.left) * (wallCanvas2D!.width / rect.width),
            cy: (touch.clientY - rect.top) * (wallCanvas2D!.height / rect.height)
        };
    };

    wallCanvas2D.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const { cx, cy } = getTouchPos(e.touches[0]);

        if (selectedWall2D) {
            const s = worldToCanvas2D(selectedWall2D.start.x, selectedWall2D.start.z);
            const e2d = worldToCanvas2D(selectedWall2D.end.x, selectedWall2D.end.z);
            if (Math.hypot(cx - s.cx, cy - s.cy) < 25) {
                isModifyingWall = true;
                modifiedWallEnd = 'start';
                activeSnapPoint = null;
                return;
            }
            if (Math.hypot(cx - e2d.cx, cy - e2d.cy) < 25) {
                isModifyingWall = true;
                modifiedWallEnd = 'end';
                activeSnapPoint = null;
                return;
            }
        }

        const snap = findSnap2D(cx, cy);
        wallDrawStart = snap ?? canvasToWorld2D(cx, cy);
        wallDrawPreview = { ...wallDrawStart };
        isDrawingWall = true;
        draw2D();
    }, { passive: false });

    wallCanvas2D.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const { cx, cy } = getTouchPos(e.touches[0]);
        activeSnapPoint = findSnap2D(cx, cy);

        if (isModifyingWall && selectedWall2D && modifiedWallEnd) {
            const worldPos = canvasToWorld2D(cx, cy);
            const otherEnd = modifiedWallEnd === 'start' ? selectedWall2D.end : selectedWall2D.start;
            const pt = activeSnapPoint ?? snapToAngles(otherEnd, worldPos);
            selectedWall2D[modifiedWallEnd] = { ...pt };

            const dx = selectedWall2D.end.x - selectedWall2D.start.x;
            const dz = selectedWall2D.end.z - selectedWall2D.start.z;
            const length = Math.sqrt(dx * dx + dz * dz);
            const input = document.getElementById('wall2d-length-input') as HTMLInputElement;
            if (input) input.value = length.toFixed(2);

            draw2D();
            return;
        }

        if (isDrawingWall && wallDrawStart) {
            const worldPos = canvasToWorld2D(cx, cy);
            wallDrawPreview = activeSnapPoint ?? snapToAngles(wallDrawStart, worldPos);
        }
        draw2D();
    }, { passive: false });

    wallCanvas2D.addEventListener('touchend', (e) => {
        e.preventDefault();

        if (isModifyingWall && selectedWall2D) {
            isModifyingWall = false;
            modifiedWallEnd = null;
            update3DWallFrom2D(selectedWall2D);
            draw2D();
            return;
        }

        if (!isDrawingWall || !wallDrawStart || !wallDrawPreview) return;
        const dx = wallDrawPreview.x - wallDrawStart.x;
        const dz = wallDrawPreview.z - wallDrawStart.z;
        if (Math.sqrt(dx * dx + dz * dz) > 0.05) {
            const wall: Wall2D = {
                id: 'customWall_' + Date.now(),
                start: { ...wallDrawStart },
                end: { ...wallDrawPreview },
                mesh: null,
                thickness: wallThickness
            };
            customWalls.push(wall);
            build3DWallFrom2D(wall);
            selectWall2D(null);
        } else {
            const s = worldToCanvas2D(wallDrawStart.x, wallDrawStart.z);
            const hitWall = getWallAt(s.cx, s.cy);
            selectWall2D(hitWall);
        }
        isDrawingWall = false; wallDrawStart = null; wallDrawPreview = null;
        draw2D();
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (!is2DMode) return;
        if (e.key === 'Escape') {
            if (isDrawingWall) {
                isDrawingWall = false; wallDrawStart = null; wallDrawPreview = null;
                draw2D();
            } else {
                exit2DMode();
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            const last = customWalls.pop();
            if (last) {
                disposeWallMeshes(last);
                if (selectedWall2D === last) selectWall2D(null);
                // Rebuild connected walls to revert their miters to flat
                for (const other of customWalls) {
                    if (pointsMatch(last.start, other.start) || pointsMatch(last.start, other.end) ||
                        pointsMatch(last.end, other.start) || pointsMatch(last.end, other.end)) {
                        build3DWallFrom2D(other, false);
                    }
                }
            }
            draw2D();
        }
    });

    window.addEventListener('resize', () => {
        if (is2DMode) { resize2DCanvas(); wallCtx2D = wallCanvas2D!.getContext('2d'); draw2D(); }
    });
}

function setupGizmos(scene: Scene) {
    gizmoManager = new GizmoManager(scene);
    gizmoManager.positionGizmoEnabled = false;
    gizmoManager.rotationGizmoEnabled = false;
    gizmoManager.scaleGizmoEnabled = false;
    gizmoManager.usePointerToAttachGizmos = false;

    gizmoManager.gizmos.positionGizmo?.onDragObservable.add(() => {
        if (selectedMesh) {
            if (isWallMounted(selectedMesh)) {
                snapToNearestWall(getTopLevelMesh(selectedMesh), false, true);
            } else {
                applyRoomBoundaries(selectedMesh);
            }
            updateDimensionMarkers(selectedMesh);
        }
    });
    gizmoManager.gizmos.positionGizmo?.onDragEndObservable.add(() => saveToHistory());
    gizmoManager.gizmos.rotationGizmo?.onDragEndObservable.add(() => saveToHistory());
    gizmoManager.gizmos.scaleGizmo?.onDragEndObservable.add(() => saveToHistory());

    const objectTools = document.getElementById('object-tools') as HTMLElement;

    const clearSelectionVisuals = () => {
        currentScene.meshes.forEach(m => {
            if (m instanceof Mesh) {
                m.renderOutline = false;
                m.disableEdgesRendering();
            }
        });
    };

    const selectMesh = (mesh: AbstractMesh) => {
        let nodeToAttach = mesh;
        while (nodeToAttach.parent && nodeToAttach.parent.name !== '__root__') {
            nodeToAttach = nodeToAttach.parent as AbstractMesh;
        }
        if (nodeToAttach.parent && nodeToAttach.parent.name === '__root__') {
            nodeToAttach = nodeToAttach.parent as AbstractMesh;
        }

        selectedMesh = nodeToAttach;
        const infrastructure = isInfrastructure(nodeToAttach);

        if (infrastructure) {
            gizmoManager.attachToMesh(null);
            objectTools.style.display = 'none';
            clearDimensionMarkers();
        } else {
            gizmoManager.attachToMesh(nodeToAttach);
            updateObjectCollider(nodeToAttach);
            objectTools.style.display = 'flex';
            updateDimensionMarkers(nodeToAttach);
        }

        const scale = nodeToAttach.scaling;
        const scaleX = document.getElementById('obj-scale-x-toolbar') as HTMLInputElement;
        const scaleY = document.getElementById('obj-scale-y-toolbar') as HTMLInputElement;
        const scaleZ = document.getElementById('obj-scale-z-toolbar') as HTMLInputElement;

        scaleX.value = (scale.x * 100).toString();
        scaleY.value = (scale.y * 100).toString();
        scaleZ.value = (scale.z * 100).toString();

        scaleX.disabled = infrastructure;
        scaleY.disabled = infrastructure;
        scaleZ.disabled = infrastructure;

        // Clear existing outlines and edges
        clearSelectionVisuals();

        const selectionColor = Color3.FromHexString("#00ff00");

        if ((mesh.name.includes('Wall') || mesh.name === 'floor' || !infrastructure) && mesh.name !== 'floor') {
            const isWall = mesh.name.includes('Wall');
            const meshesToHighlight = nodeToAttach.getChildMeshes(false).concat(nodeToAttach);

            meshesToHighlight.forEach(m => {
                if (m instanceof Mesh) {
                    if (isWall) {
                        m.edgesWidth = 4.0;
                        m.edgesColor = selectionColor.toColor4(1.0);
                        m.enableEdgesRendering();
                    } else {
                        m.renderOutline = true;
                        m.outlineColor = selectionColor;
                        m.outlineWidth = 0.02;
                    }
                }
            });
        }

        const floorTools = document.getElementById('floor-tools')!;
        const wallTools = document.getElementById('wall-tools-toolbar')!;

        wallTools.style.display = 'none';
        floorTools.style.display = 'none';

        if (mesh.name === 'floor') {
            floorTools.style.display = 'flex';
            (document.getElementById('tool-floor-width') as HTMLInputElement).value = roomWidth.toString();
            (document.getElementById('tool-floor-depth') as HTMLInputElement).value = roomDepth.toString();
        } else if (mesh.name.includes('Wall')) {
            if (is2DMode) {
                wallTools.style.display = 'flex';
                document.getElementById('tool-undo-wall-toolbar')!.style.display = 'flex';
                document.getElementById('tool-exit-2d-toolbar')!.style.display = 'flex';
                document.getElementById('wall-length-container')!.style.display = 'flex';
            } else {
                wallTools.style.display = 'none';
            }
        }

        if (!infrastructure) {
            objectTools.style.display = 'flex';
            
            const rotateBtn = document.getElementById('tool-rotate');
            if (rotateBtn) {
                rotateBtn.style.display = isWallMounted(nodeToAttach) ? 'none' : 'flex';
            }

            // Default to selection mode (no movement gizmos)
            gizmoManager.positionGizmoEnabled = false;
            gizmoManager.rotationGizmoEnabled = false;
            updateToolActiveState('move');
        } else {
            objectTools.style.display = 'none';
        }
    };

    const updateToolActiveState = (activeAction: string) => {
        ['tool-move', 'tool-rotate'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                if (btn.id === `tool-${activeAction}`) {
                    btn.setAttribute('data-active', 'true');
                } else {
                    btn.removeAttribute('data-active');
                }
            }
        });
    };

    document.getElementById('tool-delete')?.addEventListener('click', deleteSelectedObject);

    document.getElementById('tool-rotate')?.addEventListener('click', () => {
        gizmoManager.rotationGizmoEnabled = true;
        gizmoManager.positionGizmoEnabled = false;
        updateToolActiveState('rotate');
    });

    document.getElementById('tool-move')?.addEventListener('click', () => {
        gizmoManager.positionGizmoEnabled = false;
        gizmoManager.rotationGizmoEnabled = false;
        updateToolActiveState('move');
    });

    document.getElementById('tool-duplicate')?.addEventListener('click', () => {
        if (!selectedMesh) return;
        const root = getTopLevelMesh(selectedMesh);
        const filename = root.metadata?.glbFile;
        if (!filename) return;

        // Calculate width to place clone side-by-side
        const savedRotY = root.rotation.y;
        
        root.rotation.y = 0;
        root.computeWorldMatrix(true);
        root.getChildMeshes().forEach(m => m.computeWorldMatrix(true));
        const bounds = computeMeshWorldBounds(root);
        const width = bounds.max.x - bounds.min.x;
        
        root.rotation.y = savedRotY;
        root.computeWorldMatrix(true);
        
        // Target position
        const worldMatrix = root.getWorldMatrix();
        const right = Vector3.TransformNormal(new Vector3(1, 0, 0), worldMatrix);
        const targetPos = root.position.add(right.scale(width));

        // Get exact state of origin object
        let color = '#ffffff';
        const childMeshes = root.getChildMeshes();
        const firstMesh = childMeshes.find(cm => cm.material) || root;
        if (firstMesh.material) {
            if (firstMesh.material instanceof PBRMaterial && firstMesh.material.albedoColor) {
                color = firstMesh.material.albedoColor.toHexString();
            } else if (firstMesh.material instanceof StandardMaterial && firstMesh.material.diffuseColor) {
                color = firstMesh.material.diffuseColor.toHexString();
            }
        }

        const state: ObjectState = {
            name: root.name + '_duplicate',
            file: filename,
            position: { x: targetPos.x, y: root.position.y, z: targetPos.z },
            rotation: { x: root.rotation.x || 0, y: root.rotation.y || 0, z: root.rotation.z || 0 },
            scaling: { x: root.scaling.x, y: root.scaling.y, z: root.scaling.z },
            color: color
        };

        // Temporarily flag to avoid duplicate saving in loadModel
        const wasApplying = isApplyingState;
        isApplyingState = true; 

        loadModel(filename, targetPos, null, state).then(newRoot => {
            isApplyingState = wasApplying;
            if (newRoot) {
                // Ensure rotation is preserved before boundaries
                newRoot.rotation.y = state.rotation.y;

                if (isWallMounted(newRoot)) {
                    snapToNearestWall(newRoot, false, true);
                } else {
                    applyRoomBoundaries(newRoot);
                }
                
                selectMesh(newRoot);
                saveToHistory();
            }
        });
    });

    let dragLastPos: Vector3 | null = null;

    scene.onPointerObservable.add(pointerInfo => {
        if (is2DMode) return;
        if (pointerInfo.event.button === 0) {
            if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
                const pickResult = pointerInfo.pickInfo;
                if (pickResult && pickResult.hit && pickResult.pickedMesh) {
                    const mesh = pickResult.pickedMesh as AbstractMesh;
                    // Check if it's a gizmo hit (gizmo mesh names contain '_gizmo' or belong to GizmoManager)
                    const isGizmoMesh = mesh.name.startsWith('_') || mesh.name.includes('gizmo') ||
                        !!(mesh as any)._isGizmo || mesh.isPickable === false;

                    if (!isGizmoMesh) {
                        selectMesh(mesh);
                        // Start drag only if selected mesh is draggable (not infrastructure)
                        if (!isInfrastructure(getTopLevelMesh(mesh))) {
                            isDraggingMesh = true;
                            dragLastPos = pickResult.pickedPoint ? pickResult.pickedPoint.clone() : null;
                        }
                    }
                } else {
                    selectedMesh = null;
                    gizmoManager.attachToMesh(null);
                    clearDimensionMarkers();
                    clearSelectionVisuals();
                    objectTools.style.display = 'none';
                    if (!is2DMode) {
                        document.getElementById('wall-tools-toolbar')!.style.display = 'none';
                    }
                    document.getElementById('floor-tools')!.style.display = 'none';
                }
            } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
                if (isDraggingMesh) {
                    isDraggingMesh = false;
                    dragLastPos = null;
                    saveToHistory();
                }
            }
        }

        if (pointerInfo.type === PointerEventTypes.POINTERMOVE && isDraggingMesh && selectedMesh && !isInfrastructure(selectedMesh)) {
            if (!scene.activeCamera || !dragLastPos) return;
            const root = getTopLevelMesh(selectedMesh);
            const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, null, scene.activeCamera);

            // 1. Try to pick against infrastructure (walls/floor)
            const pick = scene.pickWithRay(ray, (m) => isInfrastructure(m));

            if (pick && pick.hit && pick.pickedPoint) {
                const targetPos = pick.pickedPoint;
                root.position.copyFrom(targetPos);

                if (isWallMounted(root)) {
                    snapToNearestWall(root);
                } else {
                    applyRoomBoundaries(root);
                }

                updateObjectCollider(root);
                updateDimensionMarkers(root);
                dragLastPos = root.position.clone();
            } else {
                // 2. Fallback to camera-facing plane if no infrastructure hit
                const cameraDir = scene.activeCamera.getDirection(Vector3.Backward());
                const pickPlane = Plane.FromPositionAndNormal(dragLastPos, cameraDir);
                const t = ray.intersectsPlane(pickPlane);

                if (t !== null) {
                    const worldPoint = ray.origin.add(ray.direction.scale(t));
                    const delta = worldPoint.subtract(dragLastPos);
                    root.position.addInPlace(delta);

                    if (isWallMounted(root)) {
                        snapToNearestWall(root);
                    } else {
                        applyRoomBoundaries(root);
                    }

                    updateObjectCollider(root);
                    updateDimensionMarkers(root);
                    dragLastPos = root.position.clone();
                }
            }
        }
    });

    document.getElementById('tool-build-wall')?.addEventListener('click', () => {
        objectTools.style.display = 'none';
        document.getElementById('wall-tools-toolbar')!.style.display = 'none';
        document.getElementById('floor-tools')!.style.display = 'none';
        currentScene.meshes.forEach(m => { if (m instanceof Mesh) m.renderOutline = false; });
        gizmoManager.attachToMesh(null);
        enter2DMode();
    });

    function removeWall(wallMesh: AbstractMesh) {
        disposeWallCaps(wallMesh);
        const idx = roomColliders.indexOf(wallMesh);
        if (idx > -1) roomColliders.splice(idx, 1);

        const customIdx = customWalls.findIndex(w => w.mesh === wallMesh);
        let removedWall: Wall2D | null = null;
        if (customIdx > -1) {
            removedWall = customWalls[customIdx];
            customWalls.splice(customIdx, 1);
        }

        wallMesh.dispose();
        document.getElementById('wall-tools-toolbar')!.style.display = 'none';
        currentScene.meshes.forEach(m => { if (m instanceof Mesh) m.renderOutline = false; });

        // Rebuild walls that shared endpoints with the removed wall
        if (removedWall) {
            for (const other of customWalls) {
                if (pointsMatch(removedWall.start, other.start) || pointsMatch(removedWall.start, other.end) ||
                    pointsMatch(removedWall.end, other.start) || pointsMatch(removedWall.end, other.end)) {
                    build3DWallFrom2D(other, false);
                }
            }
        }

        if (is2DMode) draw2D();
        saveToHistory();
        selectedMesh = null;
        gizmoManager.attachToMesh(null);
    }

    document.getElementById('tool-delete-wall-toolbar')?.addEventListener('click', () => {
        if (selectedMesh && selectedMesh.name.includes('Wall')) {
            removeWall(selectedMesh);
        }
    });

    (window as any).selectMeshFromOutside = selectMesh;
    (window as any).removeWallFromOutside = removeWall;
}

function setupUI() {
    const catalogList = document.getElementById('catalogList')!;

    availableModels.forEach(model => {
        const item = document.createElement('div');
        item.className = 'catalog-item';
        item.draggable = true;
        item.dataset.file = model.file;
        item.innerHTML = `
            <div class="catalog-item-icon"><span class="material-symbols-outlined">cube</span></div>
            <div class="catalog-item-details">
                <div class="catalog-item-name">${model.name}</div>
                <div class="catalog-item-desc">Objeto customizável</div>
            </div>
        `;
        catalogList.appendChild(item);

        item.addEventListener('dragstart', e => {
            if (e.dataTransfer) {
                e.dataTransfer.setData('text/plain', model.file);
                draggingFile = model.file;

                // Create a transparent image to hide the default browser drag ghost
                const img = new Image();
                img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                e.dataTransfer.setDragImage(img, 0, 0);

                // Start loading the preview model immediately
                const dummyPos = new Vector3(0, -100, 0); // Hide initially
                loadModel(model.file, dummyPos, null).then(mesh => {
                    if (draggingFile === model.file && mesh) {
                        dragPreviewMesh = mesh;
                        // Set preview style
                        mesh.getChildMeshes().forEach(m => {
                            if (m.material) {
                                m.material = m.material.clone(m.material.name + '_preview') as Material;
                                m.material.alpha = 0.5;
                                m.material.transparencyMode = Material.MATERIAL_ALPHABLEND;
                            }
                        });
                        mesh.isPickable = false; // Don't pick yourself during drag
                    } else if (mesh) {
                        // Drag ended before model loaded - cleanup
                        mesh.dispose();
                    }
                });
            }
        });

        item.addEventListener('dragend', () => {
            if (dragPreviewMesh) {
                dragPreviewMesh.dispose();
                dragPreviewMesh = null;
            }
            draggingFile = null;
        });
    });

    canvas.addEventListener('dragover', e => {
        e.preventDefault();
        if (dragPreviewMesh && draggingFile) {
            const pickResult = currentScene.pick(e.offsetX, e.offsetY, (m) => isInfrastructure(m));
            if (pickResult.hit && pickResult.pickedPoint) {
                dragPreviewMesh.position.copyFrom(pickResult.pickedPoint);

                if (dragPreviewMesh.metadata?.mountType === 'wall') {
                    snapToNearestWall(dragPreviewMesh, false);
                } else {
                    applyRoomBoundaries(dragPreviewMesh);
                }

                // Hide or show based on valid position
                dragPreviewMesh.setEnabled(true);
            } else {
                // If not hitting floor/walls, use a reasonable plane or hide
                dragPreviewMesh.setEnabled(false);
            }
        }
    });

    canvas.addEventListener('drop', e => {
        e.preventDefault();
        const file = e.dataTransfer?.getData('text/plain');
        if (file) {
            if (dragPreviewMesh && draggingFile === file) {
                // Finalize the preview mesh instead of loading a new one
                dragPreviewMesh.getChildMeshes().forEach(m => {
                    if (m.material) {
                        m.material.alpha = 1.0;
                    }
                });
                dragPreviewMesh.isPickable = true;
                updateObjectCollider(dragPreviewMesh);

                if (!isApplyingState) {
                    (window as any).selectMeshFromOutside?.(dragPreviewMesh);
                    saveToHistory();
                }

                // Hand over the reference so dragend doesn't dispose it
                dragPreviewMesh = null;
                draggingFile = null;
            } else {
                // Fallback for unexpected cases
                const pickResult = currentScene.pick(e.offsetX, e.offsetY);
                if (pickResult.hit && pickResult.pickedPoint) {
                    loadModel(file, pickResult.pickedPoint, pickResult.getNormal(true));
                }
            }
        }
    });

    document.getElementById('obj-scale-x-toolbar')?.addEventListener('input', e =>
        updateScale('x', parseFloat((e.target as HTMLInputElement).value))
    );
    document.getElementById('obj-scale-y-toolbar')?.addEventListener('input', e =>
        updateScale('y', parseFloat((e.target as HTMLInputElement).value))
    );
    document.getElementById('obj-scale-z-toolbar')?.addEventListener('input', e =>
        updateScale('z', parseFloat((e.target as HTMLInputElement).value))
    );

    document.getElementById('obj-color-toolbar')?.addEventListener('input', e => {
        const hex = (e.target as HTMLInputElement).value;
        const color = Color3.FromHexString(hex);

        if (selectedMesh) {
            const meshesToColor = selectedMesh.name === '__root__' ? selectedMesh.getChildMeshes() : [selectedMesh];
            meshesToColor.forEach(m => {
                if (m.material) {
                    m.material = m.material.clone(m.material.name + '_colored') as Material;
                    if (m.material instanceof PBRMaterial) {
                        m.material.albedoColor = color;
                    } else if (m.material instanceof StandardMaterial) {
                        m.material.diffuseColor = color;
                    }
                }
            });
            saveToHistory();
        }
    });

    document.getElementById('tool-floor-width')?.addEventListener('change', e => {
        const val = parseFloat((e.target as HTMLInputElement).value);
        if (!isNaN(val)) {
            updateRoomDimensions(val, roomDepth);
            saveToHistory();
        }
    });

    document.getElementById('tool-floor-depth')?.addEventListener('change', e => {
        const val = parseFloat((e.target as HTMLInputElement).value);
        if (!isNaN(val)) {
            updateRoomDimensions(roomWidth, val);
            saveToHistory();
        }
    });


    // Toolbar Buttons
    document.getElementById('tool-new')?.addEventListener('click', resetToNew);
    document.getElementById('tool-save')?.addEventListener('click', saveToLocalStorage);
    document.getElementById('tool-undo')?.addEventListener('click', undo);
    document.getElementById('tool-redo')?.addEventListener('click', redo);
    document.getElementById('tool-build-wall')?.addEventListener('click', () => {
        enter2DMode();
    });
}

function updateScale(axis: 'x' | 'y' | 'z', percent: number) {
    if (selectedMesh && !isInfrastructure(selectedMesh)) {
        selectedMesh.scaling[axis] = percent / 100;
        updateObjectCollider(selectedMesh);
        applyRoomBoundaries(selectedMesh);
        updateObjectCollider(selectedMesh);
        saveToHistory();
    }
}

function loadModel(filename: string, position: Vector3, normal: Vector3 | null, state?: ObjectState) {
    return SceneLoader.ImportMeshAsync('', '/glb/', filename, currentScene)
        .then(result => {
            const root = result.meshes[0] as AbstractMesh;
            root.metadata = { glbFile: filename };

            let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
            let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

            const childMeshes = result.meshes.filter(m => m !== root);
            childMeshes.forEach(m => {
                m.isPickable = true;
                m.computeWorldMatrix(true);
                const boundingInfo = m.getBoundingInfo();
                min = Vector3.Minimize(min, boundingInfo.boundingBox.minimumWorld);
                max = Vector3.Maximize(max, boundingInfo.boundingBox.maximumWorld);
            });

            if (childMeshes.length > 0) {
                const center = min.add(max).scale(0.5);
                const bottomCenterWorld = new Vector3(center.x, min.y, center.z);
                const offset = bottomCenterWorld.subtract(root.position);

                childMeshes.forEach(m => {
                    m.setParent(null);
                    m.position.subtractInPlace(offset);
                    m.setParent(root);
                });
            }

            root.position.copyFrom(position);

            // Store mount type from model definition
            const modelDef = availableModels.find(m => m.file === filename);
            if (modelDef) {
                root.metadata.mountType = modelDef.type;
            }

            if (state) {
                if (state.rotation) root.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z);
                if (state.scaling) root.scaling.set(state.scaling.x, state.scaling.y, state.scaling.z);
                if (state.color) {
                    const color = Color3.FromHexString(state.color);
                    childMeshes.forEach(m => {
                        if (m.material) {
                            m.material = m.material.clone(m.material.name + '_colored') as Material;
                            if (m.material instanceof PBRMaterial) {
                                m.material.albedoColor = color;
                            } else if (m.material instanceof StandardMaterial) {
                                m.material.diffuseColor = color;
                            }
                        }
                    });
                }
            }



            if (normal && (Math.abs(normal.x) > 0.1 || Math.abs(normal.z) > 0.1)) {
                const target = root.position.add(normal);
                root.lookAt(target);
                root.rotation.y -= Math.PI / 2; // Offset for cabinets (+X front)
            }

            // Wall-mounted items: snap to nearest wall and elevate
            if (root.metadata?.mountType === 'wall') {
                snapToNearestWall(root, false);
            }

            updateObjectCollider(root);
            applyRoomBoundaries(root);
            updateObjectCollider(root);

            if (!isApplyingState) {
                (window as any).selectMeshFromOutside?.(root);
                saveToHistory();
            }

            return root;
        })
        .catch(err => {
            console.error('Failed to load model', err);
        });
}

currentScene = createScene();
setupUI();
saveToHistory(); // Save initial state
loadFromLocalStorage(); // Try to load saved project


engine.runRenderLoop(() => {
    currentScene.render();
});

// Global Keyboard Shortcut for Object Deletion
document.addEventListener('keydown', (e) => {
    // Check if user is typing in an input or textarea
    const isTyping = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
    if (isTyping) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (is2DMode) {
            // In 2D mode, behave exactly as before
            deleteSelectedObject();
        } else if (selectedMesh) {
            // In 3D mode, only delete if NOT infrastructure (wall or floor)
            const root = getTopLevelMesh(selectedMesh);
            const isCustomWall = customWalls.some(w => w.mesh === root);

            if (!isInfrastructure(root) && !isCustomWall) {
                deleteSelectedObject();
            }
        }
        return;
    }

    // Escape handling for 2D mode is done within setup2DCanvasEvents
});

window.addEventListener('resize', () => {
    engine.resize();
});