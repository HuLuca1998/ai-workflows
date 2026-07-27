import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 本包不产出构建物——业务应用在 apps/ 下各自构建。
 * 这份配置服务两件事：
 * 1. `pnpm --filter @aiwf/ui preview` 起组件画廊（preview/index.html）；
 * 2. 给 VSCode 的 Preview.js 插件一个能解析 TSX 与 CSS 的 React 环境。
 *
 * vite 版本刻意对齐 Preview.js 内置的 6.x：装 8.x 时插件 daemon 解析不了新结构。
 */
export default defineConfig({
  plugins: [react()],
  root: 'preview',
  server: { port: 5175, open: true },
});
