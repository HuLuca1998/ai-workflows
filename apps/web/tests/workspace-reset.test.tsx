import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 一键初始化 —— 设置「高级」档。
 *
 * 图纸没画这一档的内容（右侧只画了「运行环境」那一档），所以视觉上
 * 沿用已有的 Nocturne 令牌与设置页既有的卡片结构，不自创样式。
 *
 * 行为上照这个应用一贯的做法：**先说清楚要删什么，再让点确认**。
 * 图纸「06 首次安装与检测」把「将写入的位置」逐条列出来才让你点安装，
 * 删东西没有理由更随意。
 *
 * 最要紧的一条是产物目录：它落在用户自己授权的工作目录下
 * （`<workdir>/.aiwf-artifacts`），不在 App 数据目录里。
 * 不把这条路径摆到眼前，用户不会知道自己的代码仓库里有东西要没。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

import type * as WorkspaceModule from '../src/data/workspace.js';

const { createContractCall } = await import('./_contractClient.js');
const { SettingsPage } = await import('../src/pages/SettingsPage.js');

const PREVIEW = {
  counts: { workflows: 3, runs: 12, memories: 4, agents: 4, prompts: 5, models: 2 },
  directories: [
    {
      path: '/Users/x/Library/Application Support/AI Workflows/runs',
      kind: 'runs',
      bytes: 4096,
      insideWorkdir: false,
    },
    {
      path: '/Users/x/code/.aiwf-artifacts',
      kind: 'artifacts',
      bytes: 1048576,
      insideWorkdir: true,
    },
  ],
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'env.health': () => ({ ready: true, items: [] }),
    'workspace.settings': () => ({ permissionPreset: 'ai_assisted' }),
    'workspace.resetPreview': () => PREVIEW,
    'workspace.reset': () => ({ ok: true, removedDirectories: [PREVIEW.directories[0]!.path] }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

/** 切到「高级」档。 */
async function 打开高级档(user: ReturnType<typeof userEvent.setup>) {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  await screen.findByRole('tablist', { name: '设置分组' });
  await user.click(screen.getByRole('tab', { name: '高级' }));
}

describe('入口', () => {
  it('「高级」档里有一键初始化，不再是一片「还没有可配置的项」', async () => {
    const user = userEvent.setup();
    await 打开高级档(user);

    expect(await screen.findByRole('button', { name: /一键初始化/u })).toBeTruthy();
  });

  it('入口旁边就说清这是不可逆的 —— 不能等点进去才说', async () => {
    const user = userEvent.setup();
    await 打开高级档(user);
    const 区域 = await screen.findByRole('region', { name: /一键初始化/u });

    expect(区域.textContent).toMatch(/不可逆|无法恢复|不能撤销/u);
  });

  it('说明白工作目录授权与权限档也会没 —— 重置后要重走首次配置', async () => {
    // 这是真·恢复出厂：设置存在库里，清库就一起没了。
    // 不说的话用户重置完看到「尚未授权工作目录」会以为界面坏了
    const user = userEvent.setup();
    await 打开高级档(user);
    const 区域 = await screen.findByRole('region', { name: /一键初始化/u });

    expect(区域.textContent).toMatch(/工作目录/u);
    expect(区域.textContent).toMatch(/首次配置|重新授权/u);
  });

  it('点了不会立刻删 —— 先出确认', async () => {
    const user = userEvent.setup();
    await 打开高级档(user);

    await user.click(await screen.findByRole('button', { name: /一键初始化/u }));

    await screen.findByRole('dialog', { name: /一键初始化/u });
    expect(call).not.toHaveBeenCalledWith('workspace.reset', expect.anything());
  });
});

describe('确认框把要删的东西摆出来', () => {
  async function 打开确认框(user: ReturnType<typeof userEvent.setup>) {
    await 打开高级档(user);
    await user.click(await screen.findByRole('button', { name: /一键初始化/u }));
    return screen.findByRole('dialog', { name: /一键初始化/u });
  }

  it('念出库里现在有多少东西', async () => {
    const user = userEvent.setup();
    const 框 = await 打开确认框(user);

    // 数字得是真的从预览来的，不是写死的样例
    expect(框.textContent).toContain('3');
    expect(框.textContent).toContain('12');
    expect(框.textContent).toMatch(/工作流/u);
    expect(框.textContent).toMatch(/运行/u);
  });

  it('逐条列出会被删的真实路径', async () => {
    const user = userEvent.setup();
    const 框 = await 打开确认框(user);

    expect(within(框).getByText(/Application Support\/AI Workflows\/runs/u)).toBeTruthy();
    expect(within(框).getByText(/code\/\.aiwf-artifacts/u)).toBeTruthy();
  });

  it('工作目录里的那条单独警告 —— 那是用户自己的代码仓库', async () => {
    const user = userEvent.setup();
    const 框 = await 打开确认框(user);

    const 产物 = within(框)
      .getByText(/code\/\.aiwf-artifacts/u)
      .closest('li');
    expect(产物?.textContent).toMatch(/工作目录|你的仓库|代码仓库/u);
  });

  it('产物默认不勾 —— 「没说」只能理解成「别碰」', async () => {
    const user = userEvent.setup();
    await 打开确认框(user);

    expect(screen.getByRole('checkbox', { name: /产物/u })).not.toBeChecked();
  });

  it('不勾时执行不带 includeArtifacts', async () => {
    const user = userEvent.setup();
    const 框 = await 打开确认框(user);

    await user.click(within(框).getByRole('button', { name: /^确认/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('workspace.reset', {
        confirm: true,
        includeArtifacts: false,
      });
    });
  });

  it('勾了才把产物一起删', async () => {
    const user = userEvent.setup();
    const 框 = await 打开确认框(user);

    await user.click(screen.getByRole('checkbox', { name: /产物/u }));
    await user.click(within(框).getByRole('button', { name: /^确认/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('workspace.reset', {
        confirm: true,
        includeArtifacts: true,
      });
    });
  });

  it('取消什么都不做', async () => {
    const user = userEvent.setup();
    const 框 = await 打开确认框(user);

    await user.click(within(框).getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(call).not.toHaveBeenCalledWith('workspace.reset', expect.anything());
  });

  it('Esc 也能退出去 —— 破坏性操作的逃生口不能只有一个', async () => {
    const user = userEvent.setup();
    await 打开确认框(user);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(call).not.toHaveBeenCalledWith('workspace.reset', expect.anything());
  });
});

describe('执行之后', () => {
  async function 执行(user: ReturnType<typeof userEvent.setup>) {
    await 打开高级档(user);
    await user.click(await screen.findByRole('button', { name: /一键初始化/u }));
    const 框 = await screen.findByRole('dialog', { name: /一键初始化/u });
    await user.click(within(框).getByRole('button', { name: /^确认/u }));
  }

  it('回显真的删掉的那些位置', async () => {
    const user = userEvent.setup();
    await 执行(user);

    const 结果 = await screen.findByRole('status');
    // 引擎回的是一条 runs，产物没删；界面不能照着请求参数说「都删了」
    expect(结果.textContent).toMatch(/runs/u);
    expect(结果.textContent).not.toMatch(/\.aiwf-artifacts/u);
  });

  it('失败时说明原因，而不是静静地什么都没发生', async () => {
    respond({
      'workspace.reset': () => {
        throw new Error('数据库忙');
      },
    });
    const user = userEvent.setup();
    await 执行(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库忙');
  });

  it('执行中把按钮锁住 —— 重置跑两遍不是幂等的事', async () => {
    // 包一层对象：直接用 let 的话 TS 的控制流分析看不到闭包里那次赋值，
    // 到下面就把它窄成 never 了
    const 挂起: { 放行: (() => void) | null } = { 放行: null };
    respond({
      'workspace.reset': () =>
        new Promise((resolve) => {
          挂起.放行 = () => resolve({ ok: true, removedDirectories: [] });
        }),
    });
    const user = userEvent.setup();
    await 打开高级档(user);
    await user.click(await screen.findByRole('button', { name: /一键初始化/u }));
    const 框 = await screen.findByRole('dialog', { name: /一键初始化/u });

    await user.click(within(框).getByRole('button', { name: /^确认/u }));

    await waitFor(() => {
      expect(within(框).getByRole('button', { name: /^确认|清除中/u })).toBeDisabled();
    });
    挂起.放行?.();
  });
});

describe('预览拿不到时', () => {
  it('照实说，而不是拿一份编的清单让人点确认', async () => {
    respond({
      'workspace.resetPreview': () => {
        throw new Error('数据库锁住了');
      },
    });
    const user = userEvent.setup();
    await 打开高级档(user);

    await user.click(await screen.findByRole('button', { name: /一键初始化/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库锁住了');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
