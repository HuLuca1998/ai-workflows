import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 三个管理页的分页。
 *
 * codex 复测的原话：「模型和 Agent 都固定显示 50 条且无分页；
 * 同一时刻数据库分别为模型 56 条、Agent 97 条。用户没有任何办法
 * 从这两个页面访问其余条目。」
 *
 * 后端早就分页了 —— 缺的是界面上那个控件，于是超出一页的部分被静默吃掉。
 * 静默截断比报错更糟：用户以为那就是全部。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const model = (i: number) => ({
  id: `model_${i}`,
  name: `模型 ${i}`,
  runtime: 'acp.claude',
  modelId: 'claude-opus-5',
  effort: 'high',
  contextWindow: 200_000,
  capabilities: [],
  enabled: true,
});

const agent = (i: number) => ({
  id: `agent_${i}`,
  name: `角色 ${i}`,
  role: '分析',
  goal: '',
  persona: '',
  runtime: 'acp.claude',
  modelRef: 'model_1',
  tools: [],
  capabilities: {},
  outputContract: '',
  turnLimit: 12,
  timeoutMs: 900_000,
  ver: 1,
  builtin: false,
});

const prompt = (i: number) => ({
  id: `prompt_${i}`,
  group: '分析',
  name: `提示 ${i}`,
  sections: [{ title: 'Role', body: '正文' }],
  vars: [],
  ver: 1,
  builtin: false,
  updatedAt: '2026-07-28T10:00:00Z',
});

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'model.list': () => ({ items: [model(1)], total: 56 }),
    'agent.list': () => ({ items: [agent(1)], total: 97 }),
    'prompt.list': () => ({ items: [prompt(1)], total: 120 }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const CASES = [
  { name: '模型', Page: ModelsPage, method: 'model.list', anchor: '模型 1' },
  { name: 'Agent', Page: AgentsPage, method: 'agent.list', anchor: '角色 1' },
  { name: '提示词', Page: PromptsPage, method: 'prompt.list', anchor: '提示 1' },
] as const;

describe.each(CASES)('$name 页', ({ Page, method, anchor }) => {
  it('总数超过一页时显示分页控件', async () => {
    render(<Page />);
    await screen.findByText(anchor);
    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();
  });

  it('翻页把 offset 发给后端 —— 而不是在前端切片', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await screen.findByText(anchor);

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(method, expect.objectContaining({ offset: 50 }));
    });
  });

  it('翻页带着搜索词 —— 否则第二页悄悄变成全量', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await screen.findByText(anchor);

    // 输入搜索词（三页共用同一个 useDebouncedSearch，300ms 防抖）
    const box = screen.getByRole('searchbox');
    await user.type(box, 'review');
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(method, expect.objectContaining({ query: 'review' }));
    });

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      // 之前翻页写的是 load(next)，query 整段消失：用户搜到 60 条，
      // 点下一页变成全部 120 条的第 51–100 条，而搜索框里还写着 review
      expect(call).toHaveBeenCalledWith(
        method,
        expect.objectContaining({ query: 'review', offset: 50 }),
      );
    });
  });

  it('搜索回到第一页 —— 停在第 3 页搜完可能一片空白', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await screen.findByText(anchor);

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(method, expect.objectContaining({ offset: 50 }));
    });

    await user.type(screen.getByRole('searchbox'), 'x');
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(method, expect.objectContaining({ query: 'x', offset: 0 }));
    });
  });

  it('一页装得下时不显示分页 —— 那时它只是噪音', async () => {
    respond({ [method]: () => ({ items: [], total: 3 }) });
    render(<Page />);
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: '分页' })).toBeNull();
    });
  });
});
