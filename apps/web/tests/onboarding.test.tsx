import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 首次配置 —— 图纸「06 首次安装与检测」。
 *
 * codex 两轮都报它是死路：「只有阶段占位文案，没有任何控件；
 * 设置与环境也只有说明、空表头和版本文字。用户无法完成页面要求的
 * 目录授权、权限档选择和环境检查。」而顶部三个提醒一直悬着。
 *
 * 图纸的四步：设备与磁盘 · 工具与运行时 · ACP 探测 · 目录授权与示例。
 * 底部按钮里**图纸自己就有「仅检测，不安装」**——
 * 与我们「应用不自己下载任何东西」的决定一致。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
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
      capability: 'acp.codex',
      label: 'Codex（ACP）',
      source: 'missing',
      status: 'optional',
      detail: 'AI 节点与主管 AI 需要它',
      installHint: {
        command: 'pnpm --filter @aiwf/acp-sidecar add @agentclientprotocol/codex-acp',
        source: 'ACP 官方 adapter',
      },
    },
  ],
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({ 'env.health': () => HEALTH, ...handlers });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

/** jsdom 自带的 localStorage 在某些环境下缺方法，也会在用例之间串。 */
let store: Record<string, string> = {};
beforeEach(() => {
  call.mockReset();
  respond();
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

const view = () =>
  render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );

describe('四步照图纸', () => {
  it('步骤条列出图纸的四步', async () => {
    view();
    const steps = await screen.findByRole('list', { name: '配置步骤' });
    const labels = within(steps)
      .getAllByRole('listitem')
      .map((el) => el.textContent);
    expect(labels).toEqual(['1 设备与磁盘', '2 工具与运行时', '3 ACP 探测', '4 目录授权与示例']);
  });

  it('那句产品原则常驻 —— 它是这一屏存在的理由', async () => {
    view();
    expect(
      await screen.findByText(/不使用 sudo，不改动 shell profile，也不把 App 工具写入全局 PATH/u),
    ).toBeTruthy();
  });
});

describe('环境检测', () => {
  it('列出每项能力的状态与版本', async () => {
    view();
    const row = (await screen.findByText('Git')).closest('[data-capability]')!;
    expect(row.textContent).toContain('2.50.1');
    expect(row.textContent).toContain('/usr/bin/git');
  });

  it('缺的给可复制命令，而不是一个「安装」按钮', async () => {
    // 应用不自己下载任何东西 —— 图纸底部那个「仅检测，不安装」就是这个意思
    view();
    const row = (await screen.findByText('Codex（ACP）')).closest('[data-capability]')!;
    expect(row.textContent).toContain('pnpm --filter @aiwf/acp-sidecar add');
  });

  it('可以重新检查', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('Git');
    call.mockClear();

    await user.click(screen.getByRole('button', { name: '重新检查' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('env.health', { recheck: true });
    });
  });
});

describe('不是死路', () => {
  it('有「跳过配置，用默认目录开始」—— codex 卡住的正是这里', async () => {
    view();
    expect(await screen.findByRole('button', { name: /跳过配置/u })).toBeTruthy();
  });

  it('跳过之后记下来，不再拦人', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /跳过配置/u }));

    expect(store['aiwf.onboarding.skipped']).toBe('1');
  });

  it('说清跳过之后会用哪个目录 —— 不说的话用户不知道东西写去哪了', async () => {
    view();
    expect(await screen.findByText(/Application Support/u)).toBeTruthy();
  });
});

describe('将写入的位置', () => {
  it('逐条列出，并写明 Secret 不在其中', async () => {
    view();
    const region = await screen.findByRole('region', { name: '将写入的位置' });
    expect(region.textContent).toContain('runs');
    expect(region.textContent).toContain('artifacts');
    expect(region.textContent).toMatch(/Secret 只保存在 Keychain/u);
  });
});
