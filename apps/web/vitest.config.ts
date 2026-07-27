import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // 两种后缀都要收：只写 .test.tsx 会让纯逻辑测试静默不执行
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
