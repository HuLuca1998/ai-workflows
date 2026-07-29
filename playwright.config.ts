import { defineConfig, devices } from '@playwright/test';

/**
 * 浏览器端到端。
 *
 * 测的是「点下去引擎真的动了」——所以连的是 aiwf-devserver（真实引擎），
 * 不是 mock。跑之前要先起 devserver 与 web：
 *
 *   pnpm dev:server -- --port 5177 --db /tmp/aiwf-ui-e2e/aiwf.sqlite
 *   VITE_AIWF_SERVER=http://127.0.0.1:5177 pnpm dev
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // 界面测试之间会共享同一个数据库，串行跑避免互相看到对方建的工作流
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: '.playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
