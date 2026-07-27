import { defineConfig } from 'vitest/config';

// 根配置只负责聚合子项目；每个包自带 vitest.config.ts 声明自己的环境（node / jsdom）。
export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'apps/web'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // 基座阶段先立门槛，随功能补齐逐步抬高（见 docs/TESTING.md）
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
      exclude: ['**/dist/**', '**/*.config.ts', '**/generated/**', '**/*.test.ts'],
    },
  },
});
