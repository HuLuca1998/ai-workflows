import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 这份配置本身不产出构建物——业务应用在 apps/ 下各自构建。
 * 它的作用是让 Preview.js（以及 `pnpm --filter @aiwf/ui preview`）
 * 有一个能解析 TSX 与 CSS 的 React 环境，从而单独预览组件。
 */
export default defineConfig({
  plugins: [react()],
});
