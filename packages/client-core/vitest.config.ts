import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'client-core',
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
