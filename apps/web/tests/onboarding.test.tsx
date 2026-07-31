import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type * as RouterModule from 'react-router';

/**
 * 首次配置 —— **产品原则那一部分**。
 *
 * 这个文件原本逐条对着图纸的文案断言（「查看要执行的命令（2 项）」
 * 之类）。界面形态以实现为准之后那些条目全部过时，而它们里面
 * 混着几条**不随形态变化**的东西：
 *
 * - 应用不替用户下载任何东西
 * - 给命令，而且命令里不能有 sudo
 * - 写完设置才跳走，写失败就留下
 *
 * 留的是那几条。目录选择、权限申请、门禁在 `onboarding-gate.test.tsx`。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

vi.mock('../src/onboarding/platform.js', () => ({
  pickDirectory: async () => '/Users/luca/aiwf',
  readNotificationPermission: async () => 'granted',
  requestNotificationPermission: async () => 'granted',
  canPickDirectory: () => true,
  NOTIFICATION_SETTINGS_URL: 'x-apple.systempreferences:com.apple.preference.notifications',
}));

const { createContractCall } = await import('./_contractClient.js');
const { OnboardingPage } = await import('../src/onboarding/OnboardingPage.js');

const HEALTH = {
  ready: false,
  items: [
    {
      capability: 'git',
      label: 'Git',
      version: '2.50.1',
      path: '/usr/bin/git',
      source: 'system',
      status: 'ready',
    },
    {
      capability: 'gh',
      label: 'GitHub CLI',
      source: 'missing',
      status: 'missing',
      detail: 'Push 与 PR 节点需要它',
      installHint: { command: 'brew install gh', source: 'Homebrew' },
    },
  ],
};

const 好目录 = {
  resolved: '/Users/luca/aiwf',
  exists: true,
  writable: true,
  isGitRepo: false,
  tccProtected: false,
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'env.health': () => HEALTH,
    'env.checkDirectory': () => 好目录,
    'workspace.updateSettings': () => ({ ok: true }),
    'env.diagnostics': () => ({ path: '/tmp/aiwf/diagnostics/env-diagnostics.json', bytes: 2048 }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

let navigated: string[] = [];
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>();
  return { ...actual, useNavigate: () => (to: string) => navigated.push(to) };
});

beforeEach(() => {
  call.mockReset();
  respond();
  navigated = [];
});

const view = () =>
  render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );

describe('环境检测', () => {
  it('列出每项能力的状态与版本', async () => {
    view();
    const row = (await screen.findByText('Git')).closest('[data-capability]')!;
    expect(row.textContent).toContain('2.50.1');
    expect(row.textContent).toContain('/usr/bin/git');
  });

  it('可以重新检查', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '重新检查' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('env.health', { recheck: true });
    });
  });
});

describe('应用不替你装东西', () => {
  it('缺的给可复制命令，而不是一个「安装」按钮', async () => {
    view();
    // 名字在两处出现：能力行与底部命令清单。取带 data-capability 的那个
    const rows = await screen.findAllByText('GitHub CLI');
    const row = rows.map((el) => el.closest('[data-capability]')).find(Boolean)!;
    expect(row.textContent).toContain('brew install gh');
    // 「安装」按钮意味着应用要替用户下载解压 —— 那就要为「从哪下、
    // 怎么验签、装坏了怎么回滚」全都做决定，每个决定都是新的攻击面
    expect(screen.queryByRole('button', { name: /^安装$/u })).toBeNull();
  });

  it('说明为什么不代劳 —— 否则看起来像功能没做完', async () => {
    view();
    expect(await screen.findByText(/应用不替你下载任何东西/u)).toBeTruthy();
  });

  it('命令里不能出现 sudo —— 那是写死的产品原则', async () => {
    view();
    await screen.findAllByText('GitHub CLI');
    const 全文 = document.body.textContent ?? '';
    expect(全文.includes('sudo ')).toBe(false);
  });

  it('把一键脚本指出来 —— 一条条粘贴太容易漏', async () => {
    view();
    expect(await screen.findByText(/install-deps\.sh/u)).toBeTruthy();
  });

  it('那句产品原则常驻 —— 它是这一屏存在的理由', async () => {
    view();
    expect(
      await screen.findByText(/不使用 sudo，不改动 shell profile，也不把 App 工具写入全局 PATH/u),
    ).toBeTruthy();
  });
});

describe('配置真的落地', () => {
  it('写完才回首页 —— 提前跳的话用户看到的还是旧状态', async () => {
    respond({ 'env.health': () => ({ ready: true, items: [HEALTH.items[0]] }) });
    const user = userEvent.setup();
    view();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /开始使用/u }));

    await waitFor(() => {
      // 三件事一起写：少写一样，顶栏或侧栏会继续显示「尚未…」
      expect(call).toHaveBeenCalledWith(
        'workspace.updateSettings',
        expect.objectContaining({
          workdir: expect.any(String),
          permissionPreset: expect.any(String),
          envCheckedAt: expect.any(String),
        }),
      );
    });
    expect(navigated).toContain('/');
  });

  it('写失败时留在这一屏并说明原因 —— 别假装配好了', async () => {
    respond({
      'env.health': () => ({ ready: true, items: [HEALTH.items[0]] }),
      'workspace.updateSettings': () => {
        throw new Error('磁盘只读');
      },
    });
    const user = userEvent.setup();
    view();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /开始使用/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘只读');
    expect(navigated).toEqual([]);
  });
});

describe('诊断报告', () => {
  it('导出之后说清落在哪 —— 用户要自己去取', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /导出脱敏诊断报告/u }));

    expect(await screen.findByText(/env-diagnostics\.json/u)).toBeTruthy();
  });
});
