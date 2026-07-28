import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 运行环境健康 —— 图纸「05 设置与环境」。
 *
 * 图纸头一句话就是产品原则：
 * 「所有依赖由 App 管理，安装在 Application Support 下，
 * 不写入全局 PATH，也不修改 shell profile。」
 *
 * 表格五列：能力 · 版本 · 路径/来源 · 状态 · 操作。
 * 「路径」那一列不是装饰 —— 用户要能自己确认它用的是哪一个 git，
 * 而不是只被告知「已就绪」。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { EnvHealth } = await import('../src/settings/EnvHealth.js');

const REPORT = {
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
      capability: 'acp.claude',
      label: 'Claude Code（ACP）',
      path: 'services/acp-sidecar/node_modules/.bin/claude-agent-acp',
      source: 'app_managed',
      status: 'ready',
    },
    {
      capability: 'docker',
      label: 'Docker / OrbStack',
      source: 'missing',
      status: 'optional',
      detail: '只有容器工作流需要',
    },
    {
      capability: 'node',
      label: 'Node.js',
      source: 'missing',
      status: 'missing',
      detail: 'ACP adapter 跑在它上面',
    },
  ],
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({ 'env.health': () => REPORT, ...handlers });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = async () => {
  const user = userEvent.setup();
  render(<EnvHealth />);
  await screen.findByText('Git');
  return user;
};

describe('健康表', () => {
  it('那句「不写入全局 PATH」照图纸常驻', async () => {
    await view();
    expect(screen.getByText(/不写入全局 PATH，也不修改 shell profile/u)).toBeTruthy();
  });

  it('每一项都显示版本与路径 —— 用户要能自己确认用的是哪一个', async () => {
    await view();
    const row = screen.getByText('Git').closest('[data-capability]')!;
    expect(row.textContent).toContain('2.50.1');
    expect(row.textContent).toContain('/usr/bin/git');
  });

  it('app_managed 标出来 —— 那是「App 装的，不在你的 PATH 里」', async () => {
    await view();
    const row = screen.getByText('Claude Code（ACP）').closest('[data-capability]')!;
    expect(row.textContent).toContain('App Managed');
  });

  it('可选项标「可选」，并说明什么时候才需要', async () => {
    await view();
    const row = screen.getByText('Docker / OrbStack').closest('[data-capability]')!;
    expect(row.textContent).toContain('可选');
    expect(row.textContent).toContain('只有容器工作流需要');
  });

  it('缺失的必需项标出来，不和可选项混成一样', async () => {
    await view();
    const missing = screen.getByText('Node.js').closest('[data-capability]')!;
    const optional = screen.getByText('Docker / OrbStack').closest('[data-capability]')!;
    expect(missing.getAttribute('data-status')).toBe('missing');
    expect(optional.getAttribute('data-status')).toBe('optional');
  });
});

describe('整体状态', () => {
  it('有必需项缺失时说清楚缺几项', async () => {
    await view();
    expect(screen.getByText(/需要处理/u)).toBeTruthy();
  });

  it('全就绪时显示 Ready 与项数 —— 图纸写的是「Ready · 全部 8 项检查通过」', async () => {
    respond({
      'env.health': () => ({
        ready: true,
        items: REPORT.items.map((i) => ({ ...i, status: 'ready' })),
      }),
    });
    await view();
    expect(screen.getByText(/Ready/u)).toBeTruthy();
    expect(screen.getByText(/全部 4 项/u)).toBeTruthy();
  });

  it('「重新检查」重新探测', async () => {
    const user = await view();
    call.mockClear();
    await user.click(screen.getByRole('button', { name: '重新检查' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('env.health', { recheck: true });
    });
  });

  it('探测失败时报错，而不是显示一张空表', async () => {
    respond({
      'env.health': () => {
        throw new Error('探测超时');
      },
    });
    render(<EnvHealth />);
    expect(await screen.findByRole('alert')).toHaveTextContent('探测超时');
  });
});

describe('无障碍', () => {
  it('表格有可读的表头 —— 图纸五列', async () => {
    await view();
    const table = screen.getByRole('table', { name: '运行环境健康' });
    const heads = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    // 第五列是操作列，用 sr-only 给读屏一个名字 ——
    // 空表头会被读成「列 5」，用户不知道那一列是干什么的
    expect(heads).toEqual(['能力', '版本', '路径 / 来源', '状态', '操作']);
  });
});

describe('缺失时给可复制的命令', () => {
  const WITH_HINTS = {
    ready: false,
    items: [
      { ...REPORT.items[0]! },
      {
        capability: 'node',
        label: 'Node.js',
        source: 'missing',
        status: 'missing',
        detail: 'ACP adapter 跑在它上面',
        installHint: {
          command: 'brew install node@22',
          source: 'Homebrew',
          url: 'https://nodejs.org/en/download',
        },
      },
    ],
  };

  const view2 = async () => {
    respond({ 'env.health': () => WITH_HINTS });
    const user = userEvent.setup();
    render(<EnvHealth />);
    await screen.findByText('Node.js');
    return user;
  };

  it('缺失项给出安装命令与出处', async () => {
    await view2();
    const row = screen.getByText('Node.js').closest('[data-capability]')!;
    expect(row.textContent).toContain('brew install node@22');
    // 「复制这行到终端」是让用户执行我们给的代码 —— 得说清它哪来的
    expect(row.textContent).toContain('Homebrew');
  });

  it('有复制按钮 —— 手抄一行命令必然抄错', async () => {
    const user = await view2();
    const row = screen.getByText('Node.js').closest('[data-capability]')!;
    const copy = within(row as HTMLElement).getByRole('button', { name: /复制/u });

    const writeText = vi.fn().mockResolvedValue(undefined);
    // navigator.clipboard 在 jsdom 里只有 getter，赋值会抛
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith('brew install node@22');
  });

  it('已就绪的不给安装命令 —— 给了用户会以为该重装', async () => {
    await view2();
    const row = screen.getByText('Git').closest('[data-capability]')!;
    expect(within(row as HTMLElement).queryByRole('button', { name: /复制/u })).toBeNull();
  });

  it('顶部指向一键脚本 —— 一项项复制太啰嗦', async () => {
    await view2();
    expect(screen.getByText(/install-deps\.sh/u)).toBeTruthy();
  });

  it('全就绪时不显示那个脚本提示', async () => {
    respond({
      'env.health': () => ({ ready: true, items: [{ ...REPORT.items[0]! }] }),
    });
    render(<EnvHealth />);
    await screen.findByText('Git');
    expect(screen.queryByText(/install-deps\.sh/u)).toBeNull();
  });
});
