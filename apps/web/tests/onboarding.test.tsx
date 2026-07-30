import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type * as RouterModule from 'react-router';

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

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'env.health': () => HEALTH,
    'workspace.updateSettings': () => ({ ok: true }),
    'env.diagnostics': () => ({ path: '/tmp/aiwf/diagnostics/env-diagnostics.json', bytes: 2048 }),
    ...handlers,
  });
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

/** 记下跳转去了哪。写完设置才回首页是这一屏的关键行为。 */
let navigated: string[] = [];
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>();
  return {
    ...actual,
    useNavigate: () => (to: string) => navigated.push(to),
  };
});

const view = () => {
  navigated = [];
  return render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );
};

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

describe('底部动作照图纸', () => {
  /**
   * 图纸「06 首次安装与检测」底部是三个按钮：
   *「查看要执行的命令（2 项）」「仅检测，不安装」「导出脱敏诊断报告」。
   *
   * 图纸原文是「确认并安装」，但那个按钮不安装任何东西 —— 它只是展开
   * 一段要用户自己去终端粘贴的命令，而同屏两段说明都写着「应用不替你
   * 下载任何东西」。文案已按纪律二改成实话，断言跟着改。
   * 右边一句「下一步：授权工作目录并运行内置示例」。
   *
   * 之前这里只有一个我自己加的「跳过配置，用默认目录开始」——
   * 图纸上没有那个按钮，而且它只写了个 localStorage 就走人，
   * 顶栏仍写「尚未授权工作目录」。codex 复测的原话：
   *「按钮承诺『用默认目录开始』，实际状态没有落地」。
   */
  it('三个按钮都在，文案照图纸', async () => {
    view();
    expect(await screen.findByRole('button', { name: /^查看要执行的命令/u })).toBeTruthy();
    expect(screen.getByRole('button', { name: '仅检测，不安装' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出脱敏诊断报告' })).toBeTruthy();
  });

  it('按钮标出还差几项 —— 图纸写的是「（2 项）」', async () => {
    view();
    // mock 里 gh 是 missing；acp.codex 是 optional，不催人装 ——
    // 「可选」的东西写进「还差几项」会让用户以为不装就不能用
    expect(await screen.findByRole('button', { name: '查看要执行的命令（1 项）' })).toBeTruthy();
  });

  it('全都就绪时不再劝人安装，改成「授权工作目录并开始」', async () => {
    respond({
      'env.health': () => ({
        ready: true,
        items: [
          {
            capability: 'git',
            label: 'Git',
            source: 'system',
            status: 'ready',
            version: '2.45.1',
            path: '/usr/bin/git',
          },
        ],
      }),
    });
    view();
    expect(await screen.findByRole('button', { name: '授权工作目录并开始' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /查看要执行的命令/u })).toBeNull();
  });

  it('右边那句「下一步」照图纸', async () => {
    view();
    expect(await screen.findByText('下一步：授权工作目录并运行内置示例')).toBeTruthy();
  });
});

describe('缺东西时给可复制的命令，不代劳安装', () => {
  /**
   * 图纸底部第一个按钮写的是「确认并安装（2 项）」，但**应用自己不下载
   * 任何东西**（图纸自己的产品原则：不用 sudo、不改 shell profile、
   * 不把工具写进全局 PATH）。
   *
   * 替用户执行下载与解压意味着要为「从哪下载、怎么校验签名、
   * 装坏了怎么回滚」全都做决定，而每个决定都是新的攻击面。
   * 给命令，用户自己看、自己跑。
   */
  it('点主按钮展开命令清单，而不是开始下载 —— 文案也如实这么写', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));

    const 区 = await screen.findByRole('region', { name: '要执行的命令' });
    expect(区.textContent).toContain('brew install gh');
    // 没有发起安装
    expect(call.mock.calls.some((args) => args[0] === 'env.install')).toBe(false);
  });

  it('把一键脚本指出来 —— 一条条粘贴太容易漏', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));

    expect(await screen.findByText(/scripts\/install-deps\.sh/u)).toBeTruthy();
  });

  it('说明为什么不代劳 —— 否则看起来像功能没做完', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));

    const 区 = await screen.findByRole('region', { name: '要执行的命令' });
    expect(区.textContent).toMatch(/不使用 sudo|自己看|攻击面/u);
  });

  it('命令里不能出现 sudo —— 那是图纸写死的产品原则', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));

    const 区 = await screen.findByRole('region', { name: '要执行的命令' });
    const 命令 = [...区.querySelectorAll('code')].map((el) => el.textContent ?? '');
    expect(命令.some((text) => text.includes('sudo'))).toBe(false);
  });

  it('展开之后还能继续往下走 —— 装不装是用户的事', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));

    expect(await screen.findByRole('button', { name: '装好了，继续' })).toBeTruthy();
  });

  it('全就绪时按钮直接是「授权工作目录并开始」，不绕这一步', async () => {
    respond({
      'env.health': () => ({
        ready: true,
        items: [
          {
            capability: 'git',
            label: 'Git',
            source: 'system',
            status: 'ready',
            version: '2.45.1',
            path: '/usr/bin/git',
          },
        ],
      }),
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '授权工作目录并开始' }));

    await waitFor(() => {
      expect(call.mock.calls.some((args) => args[0] === 'workspace.updateSettings')).toBe(true);
    });
  });
});

describe('配置真的落地', () => {
  /**
   * codex 复测的原话：点了按钮回到首页后「顶栏仍写『尚未授权工作目录』，
   * 侧栏仍写『未设置权限档』『环境尚未检查』」。
   *
   * 那三处在这一版之前根本没有数据源。现在它们读 workspace.settings，
   * 所以这一屏要真的把三项写进去。
   */
  it('授权目录时写工作目录、权限档和检查时间 —— 三处提示一起消失', async () => {
    const user = userEvent.setup();
    view();
    // 有缺失项时第一下展开命令清单，「装好了，继续」才真的往下走
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));
    await user.click(await screen.findByRole('button', { name: '装好了，继续' }));

    await waitFor(() => {
      const 写入 = call.mock.calls.filter((args) => args[0] === 'workspace.updateSettings');
      expect(写入.length, '一次都没写').toBeGreaterThan(0);
      const 入参 = 写入[写入.length - 1]![1] as Record<string, unknown>;
      expect(入参['workdir'], '没授权工作目录').toBeTruthy();
      // 默认给最保守的一档：用户还没表达过信任程度
      expect(入参['permissionPreset']).toBe('review_every_change');
      expect(入参['envCheckedAt'], '没记环境检查时间').toBeTruthy();
    });
  });

  it('写完才回首页 —— 提前跳的话用户看到的还是旧状态', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));
    await user.click(await screen.findByRole('button', { name: '装好了，继续' }));

    await waitFor(() => {
      expect(navigated).toContain('/');
    });
    expect(call.mock.calls.some((args) => args[0] === 'workspace.updateSettings')).toBe(true);
  });

  it('写失败时留在这一屏并说明原因 —— 别假装配好了', async () => {
    respond({
      'workspace.updateSettings': () => {
        throw new Error('数据库忙');
      },
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /查看要执行的命令/u }));
    await user.click(await screen.findByRole('button', { name: '装好了，继续' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库忙');
    expect(navigated).not.toContain('/');
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
