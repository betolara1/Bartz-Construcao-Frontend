# Bartz Construção - Frontend 3D

Plataforma interativa para design de interiores e simulação de construção em 3D, desenvolvida com **Babylon.js** e **Vite**.

## 🚀 Funcionalidades Principais

### 🏗️ Sistema de Construção 2D/3D
- **Editor de Plantas 2D**: Desenho intuitivo de paredes com sistema de *snapping* (horizontal, vertical e 45°).
- **Geração 3D em Tempo Real**: Conversão instantânea da planta 2D para modelos 3D volumétricos.
- **Acabamentos Automáticos**: Inclusão automática de **rodapés** e **sancas** (molduras superiores) em todas as paredes.
- **Sincronização Perfeita**: Alinhamento de eixos entre 2D e 3D para uma construção sem erros de espelhamento.

### 🛋️ Mobiliário e Interação
- **Móveis de Chão e Parede**: Suporte a diferentes tipos de montagem.
- **Snap de Parede Inteligente**: Móveis suspensos (como armários superiores) "grudam" automaticamente na parede mais próxima, com a frente voltada para o cômodo.
- **Altura Ajustável**: Móveis de parede podem ser movidos verticalmente entre o piso e o teto.
- **Marcadores de Dimensão**: Réguas dinâmicas que mostram distâncias em tempo real para as paredes e superfícies ao selecionar um objeto.

### ⌨️ Atalhos e UX
- **Tecla Delete/Backspace**: Exclusão rápida de móveis e paredes selecionadas.
- **Sistema de Desfazer/Refazer (Undo/Redo)**: Suporte completo a `Ctrl+Z` e `Ctrl+Y`.
- **Câmera Panorâmica Livre**: Movimentação sem restrições em todos os eixos para inspeção detalhada.
- **Zoom de Alta Precisão**: Aproximação permitida até 10cm dos objetos.

## 🛠️ Tecnologias Utilizadas

- **Engine 3D**: [Babylon.js](https://www.babylonjs.com/)
- **Linguagem**: TypeScript
- **Bundler**: Vite
- **Estilização**: Vanilla CSS (Moderno/Premium)

## 📦 Como Executar o Projeto

1. **Instalar dependências**:
   ```bash
   npm install
   ```

2. **Executar em modo de desenvolvimento**:
   ```bash
   npm run dev
   ```

3. **Gerar build de produção**:
   ```bash
   npm run build
   ```

## 📁 Estrutura do Projeto

- `src/main.ts`: Lógica principal da aplicação, cena 3D e manipuladores de eventos.
- `index.html`: Estrutura base da UI e dashboards.
- `style.css`: Estilização premium da interface.
- `public/glb/`: Diretório para os modelos 3D dos móveis.

---
Desenvolvido para **Bartz Construção**.
