import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type * as WorkspaceModule from '../src/data/workspace.js';
import { APPROVAL_MODES, APPROVAL_MODE_LABELS } from '@aiwf/contracts';

/**
 * 顶栏的工作目录、侧栏的权限档与环境状态。
 *
 * codex 复测的原话：点「用默认目录开始」之后「顶栏仍写『尚未授权工作目录』，
 * 侧栏仍写『未设置权限档』『环境尚未检查』」。
 *
 * 根因不是那个按钮 —— 是这三处**根本没有数据源**。AppShell 没给
 * TitleBar 传 workdir，也没给 SideNav 传 permission / environment，
 * 于是界面上永远悬着三条「未配置」，而应用里没有任何东西能把它们改掉。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  // 只替 coreClient：useWorkspace 那些真实 store 还要用（概览页会读它）
  const actual = await importOriginal<typeof WorkspaceModule>();
  return {
    ...actual,
    coreClient: { call: (method: string, input: unknown) => call(method, input) },
  };
});

const { createContractCall } = await import('./_contractClient.js');
const { AppShell } = await import('../src/AppShell.js');

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'workspace.settings': () => ({}),
    'workspace.stats': () => ({
      pendingApprovals: 0,
      runsToday: 0,
      runsTodaySucceeded: 0,
      activeWorktrees: 0,
      worktreeBytes: 0,
    }),
    'workflow.list': () => ({ items: [], total: 0 }),
    'run.list': () => ({ items: [], total: 0 }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
  // 侧栏底部那两块只在展开时渲染（窄于 1360px 收成图标栏），
  // jsdom 默认 1024 会把它们收掉
  window.innerWidth = 1440;
  window.dispatchEvent(new Event('resize'));
});

const view = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppShell />
    </MemoryRouter>,
  );

describe('设置没配过时照实说', () => {
  it('没授权工作目录就说没授权', async () => {
    view();
    expect(await screen.findByText('尚未授权工作目录')).toBeTruthy();
  });

  it('没选权限档就说没选', async () => {
    view();
    expect(await screen.findByText('未设置权限档')).toBeTruthy();
  });

  it('没检查过环境就说没检查', async () => {
    view();
    expect(await screen.findByText('环境尚未检查')).toBeTruthy();
  });
});

describe('设置配过之后界面跟着变', () => {
  it('顶栏显示已授权的工作目录', async () => {
    respond({ 'workspace.settings': () => ({ workdir: '~/code/atlas-api' }) });
    view();

    expect(await screen.findByText('~/code/atlas-api')).toBeTruthy();
    expect(screen.queryByText('尚未授权工作目录')).toBeNull();
  });

  it('侧栏显示的是档位的名字，不是存的那个 ID', async () => {
    respond({ 'workspace.settings': () => ({ permissionPreset: 'ai_assisted' }) });
    view();

    expect(await screen.findByText(APPROVAL_MODE_LABELS.ai_assisted.name)).toBeTruthy();
  });



  it('三档的文案都照图纸', async () => {
    for (const [id, 文案] of APPROVAL_MODES.map(
      (mode) => [mode, APPROVAL_MODE_LABELS[mode].name] as const,
    )) {
      respond({ 'workspace.settings': () => ({ permissionPreset: id }) });
      const { unmount } = view();
      expect(await screen.findByText(文案)).toBeTruthy();
      unmount();
    }
  });

  it('检查过而且真的都就绪时才说环境正常', async () => {
    respond({
      'workspace.settings': () => ({ envCheckedAt: '2026-07-28T13:00:00Z' }),
      'env.health': () => ({ ready: true, items: [] }),
    });
    view();

    expect(await screen.findByText(/环境正常/u)).toBeTruthy();
  });

  it('有缺项时说清还差几项 —— 不是无条件报「环境正常」', async () => {
    // 原来这一行只看 envCheckedAt 存不存在，然后硬编码 ok: true。
    // 而首次配置在「还缺 N 项」时也会写那个时间戳（底部按钮变成
    // 「装好了，继续」，什么都没装也能按）—— 于是用户回到主界面
    // 看到的是「环境正常」，而设置页里还挂着「缺失 2 项」
    respond({
      'workspace.settings': () => ({ envCheckedAt: '2026-07-28T13:00:00Z' }),
      'env.health': () => ({
        ready: false,
        items: [
          { capability: 'git', label: 'Git', source: 'system', status: 'ready' },
          { capability: 'node', label: 'Node.js', source: 'missing', status: 'missing' },
          { capability: 'gh', label: 'GitHub CLI', source: 'missing', status: 'missing' },
        ],
      }),
    });
    view();

    expect(await screen.findByText(/2 项待处理/u)).toBeTruthy();
    expect(screen.queryByText(/环境正常/u)).toBeNull();
  });

  it('可选项缺失不算待处理 —— 一个不跑容器的人不该总被提醒', async () => {
    respond({
      'workspace.settings': () => ({ envCheckedAt: '2026-07-28T13:00:00Z' }),
      'env.health': () => ({
        ready: true,
        items: [
          { capability: 'git', label: 'Git', source: 'system', status: 'ready' },
          { capability: 'docker', label: 'Docker', source: 'missing', status: 'optional' },
        ],
      }),
    });
    view();

    expect(await screen.findByText(/环境正常/u)).toBeTruthy();
  });

  it('读设置失败不该把整个外壳弄崩 —— 那三条提示照旧显示', async () => {
    respond({
      'workspace.settings': () => {
        throw new Error('数据库忙');
      },
    });
    view();

    expect(await screen.findByText('尚未授权工作目录')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('未设置权限档')).toBeTruthy();
    });
  });
});
