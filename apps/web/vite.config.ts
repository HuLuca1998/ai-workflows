import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: {
    // 路由级代码分割：首屏只加载工作流列表（性能预算 < 1.2s 到可交互）
    target: 'es2022',
  },
});
