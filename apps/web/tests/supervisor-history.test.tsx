import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 主管 AI 的历史会话 —— 图纸：「左侧可折叠历史会话列表
 *（按关联的工作流 / 运行 / 记忆 / 模型标注）」。
 *
 * 不存的话每次关掉抽屉对话就没了，而用户常常是隔天回来接着问：
 * 「上次它说那个节点为什么会失败来着」。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

const SESSIONS = [
  {
    id: 'sess_1',
    title: '这条流程为什么失败',
    startedAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:05:00.000Z',
    messageCount: 4,
    workflowId: 'wf_1',
  },
  {
    id: 'sess_2',
    title: '这个应用怎么用',
    startedAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:02:00.000Z',
    messageCount: 2,
  },
];

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'model.list': () => ({ items: [] }),
    'supervisor.sessions': () => ({ items: SESSIONS }),
    'supervisor.session': () => ({
      session: SESSIONS[0]!,
      messages: [
        { role: 'user', text: '这条为什么失败', at: '2026-07-28T10:00:00.000Z' },
        { role: 'agent', text: '第 3 个节点超时了', at: '2026-07-28T10:00:30.000Z' },
      ],
    }),
    'supervisor.ask': () => ({ text: '好的', toolCalls: 0, sessionId: 'sess_new' }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = () => render(<SupervisorDrawer open context={{}} onClose={vi.fn()} />);

describe('历史列表', () => {
  it('打开抽屉时不自动展开 —— 图纸说的是「可折叠」，默认是对话', async () => {
    view();
    await screen.findByText('主管 AI');
    expect(screen.queryByRole('region', { name: '历史会话' })).toBeNull();
  });

  it('点历史按钮才展开', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '历史会话' }));

    const list = await screen.findByRole('region', { name: '历史会话' });
    expect(within(list).getByText('这条流程为什么失败')).toBeTruthy();
    expect(within(list).getByText('这个应用怎么用')).toBeTruthy();
  });

  it('标注关联的工作流 —— 图纸要求「按关联的对象标注」', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '历史会话' }));

    const item = (await screen.findByText('这条流程为什么失败')).closest('[data-session]')!;
    expect(item.textContent).toContain('工作流');
  });

  it('显示消息条数 —— 用户据此判断哪条是「聊了很久那次」', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '历史会话' }));

    const item = (await screen.findByText('这条流程为什么失败')).closest('[data-session]')!;
    expect(item.textContent).toContain('4');
  });

  it('一条历史都没有时说明会话是怎么来的', async () => {
    respond({ 'supervisor.sessions': () => ({ items: [] }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '历史会话' }));

    expect(await screen.findByText(/还没有历史会话/u)).toBeTruthy();
  });
});

describe('恢复会话', () => {
  it('点一条历史把消息读回对话区', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '历史会话' }));
    await user.click(await screen.findByText('这条流程为什么失败'));

    expect(await screen.findByText('第 3 个节点超时了')).toBeTruthy();
  });

  it('恢复后继续问会接到同一条会话，而不是新开', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '历史会话' }));
    await user.click(await screen.findByText('这条流程为什么失败'));
    await screen.findByText('第 3 个节点超时了');

    await user.type(screen.getByLabelText('问主管 AI'), '那怎么改');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'supervisor.ask',
        expect.objectContaining({ sessionId: 'sess_1' }),
      );
    });
  });

  it('新对话的第一问不带 sessionId —— 那时还没有会话', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('主管 AI');

    await user.type(screen.getByLabelText('问主管 AI'), '新问题');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      const ask = call.mock.calls.find(([m]) => m === 'supervisor.ask');
      expect(ask?.[1]).not.toHaveProperty('sessionId');
    });
  });

  it('第二问带上后端给的 sessionId —— 同一次对话不该散成两条', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('主管 AI');

    await user.type(screen.getByLabelText('问主管 AI'), '第一问');
    await user.keyboard('{Enter}');
    await screen.findByText('好的');

    await user.type(screen.getByLabelText('问主管 AI'), '第二问');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'supervisor.ask',
        expect.objectContaining({ sessionId: 'sess_new' }),
      );
    });
  });

  it('「新对话」清空当前会话', async () => {
    const user = userEvent.setup();
    view();
    await user.type(await screen.findByLabelText('问主管 AI'), '第一问');
    await user.keyboard('{Enter}');
    await screen.findByText('好的');

    await user.click(screen.getByRole('button', { name: '新对话' }));
    expect(screen.queryByText('好的')).toBeNull();

    await user.type(screen.getByLabelText('问主管 AI'), '重新开始');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      const asks = call.mock.calls.filter(([m]) => m === 'supervisor.ask');
      expect(asks.at(-1)?.[1]).not.toHaveProperty('sessionId');
    });
  });
});
