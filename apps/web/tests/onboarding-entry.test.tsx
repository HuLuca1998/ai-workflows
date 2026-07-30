import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 首次配置那一屏：
 *
 * - 装完这个应用第一次打开，没有任何东西把用户带到它上面去 ——
 *   它只是设置页里的一档和一条谁都不会手输的 `/onboarding` 路由
 * - `SKIP_KEY` 写进 localStorage 之后**没有任何读者**，纯死代码
 * - 四步步骤条的第 3、4 步的 `data-done` 恒为 false：ACP 探到了、
 *   目录也授权了，那两步还是灰的
 */

const call = vi.fn();
// 只替 coreClient，其余（useWorkspace 等）保留原样 ——
// AppShell 这一层用到的东西比单页多
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AppShell } = await import('../src/AppShell.js');
const { OnboardingPage } = await import('../src/onboarding/OnboardingPage.js');
const { ONBOARDING_SKIP_KEY } = await import('../src/onboarding/skipMark.js');

const HEALTH = {
  ready: true,
  items: [
    {
      capability: 'git',
      label: 'Git',
      source: 'system',
      status: 'ready',
      detail: 'git 2.44',
      version: '2.44',
    },
    {
      capability: 'acp.codex',
      label: 'Codex（ACP）',
      source: 'system',
      status: 'ready',
      detail: 'codex 0.9',
      version: '0.9',
    },
  ],
};

/** 还没配过：后端没有 envCheckedAt，工作目录也是空的。 */
function freshWorkspace() {
  return { permissionPreset: 'workspace_safe', environment: 'local' };
}

function respond(settings: Record<string, unknown>) {
  const checked = createContractCall({
    'workspace.settings': () => settings,
    'env.health': () => HEALTH,
    'run.list': () => ({ items: [], total: 0 }),
    'workflow.list': () => ({ items: [], total: 0 }),
    'workspace.updateSettings': () => ({ ok: true }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

/** jsdom 的 localStorage 在这套环境里缺方法，也会在用例之间串。 */
let store: Record<string, string> = {};
beforeEach(() => {
  call.mockReset();
  store = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => delete store[key],
      clear: () => {
        store = {};
      },
    },
  });
});

describe('首次启动', () => {
  it('还没配过就把用户带到首次配置，而不是丢在一个空的概览页', async () => {
    respond(freshWorkspace());
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );
    expect(await screen.findByText('环境检测与依赖补齐')).toBeTruthy();
  });

  it('配过了就不再拦人', async () => {
    respond({ ...freshWorkspace(), workdir: '/tmp/ws', envCheckedAt: '2026-07-01T00:00:00Z' });
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText('环境检测与依赖补齐')).toBeNull();
    });
  });

  it('跳过之后不再拦 —— 那个标记要有读者', async () => {
    respond(freshWorkspace());
    window.localStorage.setItem(ONBOARDING_SKIP_KEY, '1');
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText('环境检测与依赖补齐')).toBeNull();
    });
  });
});

describe('首次配置这一屏', () => {
  it('可以跳过 —— 用户不该被一屏检查困住', async () => {
    respond(freshWorkspace());
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: /跳过/u }));
    expect(window.localStorage.getItem(ONBOARDING_SKIP_KEY)).toBe('1');
  });

  it('步骤条不撒谎：ACP 探到了那一步才算完成', async () => {
    respond(freshWorkspace());
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );
    const steps = await screen.findByRole('list', { name: '配置步骤' });
    await waitFor(() => {
      const acpStep = steps.children[2] as HTMLElement;
      expect(acpStep.dataset['done'], 'ACP 已经探到 codex，这一步还是灰的').toBe('true');
    });
    // 目录还没授权，第 4 步不能是已完成
    expect((steps.children[3] as HTMLElement).dataset['done']).not.toBe('true');
  });
});
