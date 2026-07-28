import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PatchOperation, WorkflowGraph } from '@aiwf/contracts';

/**
 * 主管 AI 的改动先出 Diff —— 图纸原话：
 * 「不会发布，也不会改动运行中的 v7」。
 *
 * 这条链路原来只有注释，没有实现：DraftStore.propose() 写好了，
 * 但界面里没有任何地方调它，抽屉只能问答。
 *
 * 三条不可退让：
 * 1. AI 的改动**先看 Diff**，用户点了确认才落草稿
 * 2. 拒绝就什么都不写 —— 不留半个已应用的操作
 * 3. 落草稿走 workflow.patch，那里有 baseRevision 守卫
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');

const MODEL = {
  id: 'model_1',
  name: 'Opus 5 · high',
  runtime: 'acp.claude',
  modelId: 'claude-opus-5',
  effort: 'high',
  contextWindow: 200_000,
  capabilities: [],
  enabled: true,
};

const GRAPH: WorkflowGraph = {
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
    },
  ],
  edges: [],
  groups: [],
};

const PROPOSAL: { summary: string; operations: PatchOperation[] } = {
  summary: '把入口改名为「开始」',
  operations: [{ op: 'renameNode', nodeId: 'entry', title: '开始' }],
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'model.list': () => ({ items: [MODEL], total: 0 }),
    'supervisor.ask': () => ({ text: '我改好了，你看下。', toolCalls: 1, proposal: PROPOSAL }),
    'workflow.patch': () => ({
      rev: 8,
      diff: { added: [], removed: [], changed: [] },
      validation: { ok: true, issues: [] },
    }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const onApply = vi.fn();

async function ask(question = '把入口改名') {
  const user = userEvent.setup();
  render(
    <SupervisorDrawer
      open
      context={{ workflowId: 'wf_1', draftRev: 7 }}
      graph={GRAPH}
      onApply={onApply}
      onClose={vi.fn()}
    />,
  );
  await user.type(screen.getByLabelText('问主管 AI'), question);
  await user.keyboard('{Enter}');
  return user;
}

beforeEach(() => onApply.mockReset());

describe('提议出 Diff', () => {
  it('回答里带提议时显示 Diff，而不是只显示一段文字', async () => {
    await ask();
    expect(await screen.findByRole('region', { name: 'AI 提议的改动' })).toBeTruthy();
    expect(screen.getByText('把入口改名为「开始」')).toBeTruthy();
  });

  it('Diff 用与版本抽屉相同的行格式', async () => {
    await ask();
    await screen.findByRole('region', { name: 'AI 提议的改动' });
    expect(screen.getByText(/~ .*入口/u)).toBeTruthy();
  });

  it('确认前不写任何东西 —— 提议只是提议', async () => {
    await ask();
    await screen.findByRole('region', { name: 'AI 提议的改动' });
    expect(call).not.toHaveBeenCalledWith('workflow.patch', expect.anything());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('点「应用到草稿」才落库，且带 baseRevision', async () => {
    const user = await ask();
    await screen.findByRole('region', { name: 'AI 提议的改动' });

    await user.click(screen.getByRole('button', { name: '应用到草稿' }));
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith(PROPOSAL.operations);
    });
  });

  it('拒绝后提议消失，什么都不写', async () => {
    const user = await ask();
    await screen.findByRole('region', { name: 'AI 提议的改动' });

    await user.click(screen.getByRole('button', { name: '不用了' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'AI 提议的改动' })).toBeNull();
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('纯问答不显示 Diff 区', async () => {
    respond({ 'supervisor.ask': () => ({ text: '上次失败是因为超时。', toolCalls: 0 }) });
    await ask('上次为什么失败');
    await screen.findByText('上次失败是因为超时。');
    expect(screen.queryByRole('region', { name: 'AI 提议的改动' })).toBeNull();
  });

  it('提议应用不上时说清楚，而不是给一个空 Diff', async () => {
    // AI 引用了一个不存在的节点 —— 图变了而它拿的是旧的
    respond({
      'supervisor.ask': () => ({
        text: '改好了',
        toolCalls: 0,
        proposal: {
          summary: '改一个不存在的节点',
          operations: [{ op: 'renameNode', nodeId: 'ghost', title: '幽灵' }],
        },
      }),
    });
    await ask();
    expect(await screen.findByRole('alert')).toHaveTextContent(/应用不上|找不到/u);
  });

  it('没有工作流上下文时不显示应用按钮 —— 没有草稿可落', async () => {
    const user = userEvent.setup();
    render(<SupervisorDrawer open context={{}} onApply={onApply} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('问主管 AI'), '改点什么');
    await user.keyboard('{Enter}');

    await screen.findByText('我改好了，你看下。');
    expect(screen.queryByRole('button', { name: '应用到草稿' })).toBeNull();
  });
});
