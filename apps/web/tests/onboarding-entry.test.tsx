import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  return { permissionPreset: 'ai_assisted', environment: 'local' };
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
    expect(await screen.findByText('配置这台机器')).toBeTruthy();
  });

  it('配过了就不再拦人', async () => {
    respond({ ...freshWorkspace(), workdir: '/tmp/ws', envCheckedAt: '2026-07-01T00:00:00Z' });
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText('配置这台机器')).toBeNull();
    });
  });

  it('从任何一条路径进来都会被拦回配置屏', async () => {
    // 上一版只在 `pathname === '/'` 时拦 —— 于是从托盘、通知、
    // 深链进来的任何一条路径都绕过了它
    for (const 入口 of ['/', '/runs', '/settings', '/editor/wf_1']) {
      respond(freshWorkspace());
      const { unmount } = render(
        <MemoryRouter initialEntries={[入口]}>
          <AppShell />
        </MemoryRouter>,
      );
      expect(await screen.findByText('配置这台机器'), `${入口} 没被拦住`).toBeTruthy();
      unmount();
    }
  });
});

describe('配置完成后真的能进去', () => {
  it('点「开始使用」写完设置进首页 —— 不被门禁弹回配置屏', async () => {
    // 外壳的设置只在启动时读一次。配置屏写完设置跳首页时，
    // 外壳手里还是「未配置」，重定向守卫立刻把用户弹回来 ——
    // 于是「配置永远完不成」，正是用户报的「被配置页拦截进不去」
    const userEvent = (await import('@testing-library/user-event')).default;
    const 好目录 = {
      resolved: '/tmp/ws',
      exists: true,
      writable: true,
      isGitRepo: false,
      tccProtected: false,
    };
    const checked = createContractCall({
      'workspace.settings': () => freshWorkspace(),
      'env.health': () => HEALTH,
      'env.checkDirectory': () => 好目录,
      'run.list': () => ({ items: [], total: 0 }),
      'workflow.list': () => ({ items: [], total: 0 }),
      'workspace.stats': () => ({
        workflows: 0,
        runsActive: 0,
        runsTotal: 0,
        pendingApprovals: 0,
        runsToday: 0,
        runsTodaySucceeded: 0,
        activeWorktrees: 0,
        worktreeBytes: 0,
      }),
      'workspace.updateSettings': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <AppShell />
      </MemoryRouter>,
    );

    const start = await screen.findByRole('button', { name: /开始使用/u });
    await waitFor(() => {
      expect(start).not.toBeDisabled();
    });
    await user.click(start);

    // 真正的判据：配置屏消失了，而不是「navigate 被调用过」——
    // 弹回时 navigate 也被调用过
    await waitFor(() => {
      expect(screen.queryByText('配置这台机器')).toBeNull();
    });
    // 并且**保持**消失。弹回是异步的：waitFor 在「跳走了、还没弹回来」
    // 的窗口里首次成功就返回 —— 只断言一次会假性通过
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByText('配置这台机器'), '进去之后又被弹回配置屏').toBeNull();
  });
});

describe('首次配置这一屏', () => {
  it('没有跳过这个出口 —— 配完之前进不去', async () => {
    // 用户要求：「引导完成之前不允许进入 app」。
    // 上一版那个「跳过」只写了个 localStorage 就走人，
    // 而顶栏仍写着「尚未授权工作目录」—— 按钮承诺的事没有发生
    respond(freshWorkspace());
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /开始使用/u });
    expect(screen.queryByRole('button', { name: /跳过/u })).toBeNull();
  });

  it('步骤条不撒谎：判据就是那一块的真实状态', async () => {
    // 上一版第 3、4 步**恒为灰**（条件只写到 index === 1）——
    // ACP 探到了、目录也授权了，那两步照旧不亮。
    // 步骤条在说假话比没有步骤条更糟
    respond(freshWorkspace());
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage />
      </MemoryRouter>,
    );
    const steps = await screen.findByRole('list', { name: '配置步骤' });

    await waitFor(() => {
      // 工具都 ready，这一格该亮
      expect(
        (steps.children[2] as HTMLElement).dataset['done'],
        '工具都探到了，这一步还是灰的',
      ).toBe('true');
      // ACP 探到 codex，这一格也该亮
      expect(
        (steps.children[3] as HTMLElement).dataset['done'],
        'ACP 已经探到 codex，这一步还是灰的',
      ).toBe('true');
    });
  });
});
