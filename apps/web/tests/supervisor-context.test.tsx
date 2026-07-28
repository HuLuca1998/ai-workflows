import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * 主管 AI 的上下文从各屏接上来。
 *
 * 抽屉原来收的是一个空对象 `{}` —— 那句「上下文是显式的」于是成了空话：
 * 头部一个 chip 都没有，AI 也不知道你正在看哪条工作流，
 * 提出来的操作引用的 nodeId 全是它编的。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async () => {
  // 概览页要用 useWorkspace，所以保留原实现，只换 coreClient
  const actual = await vi.importActual('../src/data/workspace.js');
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

const { createContractCall } = await import('./_contractClient.js');
const { AppShell } = await import('../src/AppShell.js');
const { useEditor } = await import('../src/editor/editorStore.js');

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(
    createContractCall({
      'model.list': () => ({ items: [], total: 0 }),
      'workflow.list': () => ({ items: [], total: 0 }),
      'workspace.stats': () => ({
        pendingApprovals: 0,
        runsToday: 0,
        runsTodaySucceeded: 0,
        activeWorktrees: 0,
        worktreeBytes: 0,
      }),
    }),
  );
  useEditor.setState({
    workflowId: 'wf_1',
    rev: 7,
    graph: { nodes: [], edges: [], groups: [] },
    selection: ['n1', 'n2'],
  });
});

/**
 * 从概览路由打开。
 *
 * 不走 /editor/wf_1：EditorPage 挂载时会 load()，而 load 里会清空
 * selection —— 那样测的就成了「load 之后还剩什么」，
 * 而这里要测的是「AppShell 有没有把 store 里的东西接给抽屉」。
 */
const openDrawer = async () => {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppShell />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: /询问 AI/u }));
  return user;
};

describe('上下文接通', () => {
  it('在编辑器里打开时带上草稿 rev', async () => {
    await openDrawer();
    expect(screen.getByText('草稿 rev7')).toBeTruthy();
  });

  it('带上选中的节点数', async () => {
    await openDrawer();
    expect(screen.getByText('选中节点 2')).toBeTruthy();
  });

  it('不在编辑器时不编造草稿 rev', async () => {
    useEditor.setState({
      workflowId: null,
      rev: 0,
      graph: { nodes: [], edges: [], groups: [] },
      selection: [],
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /询问 AI/u }));

    const region = screen.getByLabelText('上下文');
    expect(region.textContent?.trim()).toBe('上下文');
  });
});
