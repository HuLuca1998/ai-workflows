import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ui',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
  },
});
