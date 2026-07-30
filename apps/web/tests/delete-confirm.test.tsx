import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 三页的「删除 → 确认删除」都是原位替换 + 一个布尔状态，两个后果：
 *
 * 1. **双击即删**：第一下把按钮换成「确认删除」，第二下落在同一个坐标上
 *    —— 用户以为自己双击了「删除」，实际已经删掉了
 * 2. **确认态跨条目残留**：在 A 上点出确认态、切到 B，按钮还停在
 *    「确认删除」，在 B 上点的第一下就把 B 删了
 *
 * 记忆页早就把状态写成 `string | null`（记住是哪一条），三页没跟上。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

function agent(id: string, name: string) {
  return {
    id,
    name,
    role: '分析师',
    goal: '定位根因',
    persona: '先读代码再下结论',
    runtime: 'acp.codex',
    modelRef: 'model_1',
    tools: ['read'],
    capabilities: { file: 'read', command: 'none', network: 'none', memory: 'none', secret: [] },
    outputContract: '结构化 JSON',
    turnLimit: 12,
    timeoutMs: 900_000,
    ver: 1,
    builtin: false,
  };
}

function model(id: string, name: string) {
  return {
    id,
    name,
    runtime: 'acp.codex',
    modelId: 'gpt-x',
    effort: 'medium',
    contextWindow: 200000,
    capabilities: ['结构化输出'],
    enabled: true,
  };
}

function prompt(id: string, name: string) {
  return {
    id,
    group: '系统内建 · 节点',
    name,
    sections: [{ title: 'Role', body: '正文' }],
    vars: [],
    ver: 1,
    builtin: false,
    updatedAt: '2026-07-27T10:00:00Z',
  };
}

beforeEach(() => {
  call.mockReset();
});

/** 点第一条的删除进确认态，再点第二条，断言确认态没跟过去。 */
async function expectConfirmDoesNotLeak(
  ui: React.ReactElement,
  firstLabel: string,
  secondLabel: string,
  deleteMethod: string,
) {
  const user = userEvent.setup();
  render(<MemoryRouter>{ui}</MemoryRouter>);

  await user.click(await screen.findByText(firstLabel));
  await user.click(await screen.findByRole('button', { name: '删除' }));
  await screen.findByRole('button', { name: /确认删除/u });

  await user.click(await screen.findByText(secondLabel));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /确认删除/u })).toBeNull();
  });
  await screen.findByRole('button', { name: '删除' });
  expect(call.mock.calls.filter(([m]) => m === deleteMethod)).toHaveLength(0);
}

describe('确认删除不跨条目残留', () => {
  it('Agent 页', async () => {
    const checked = createContractCall({
      'agent.list': () => ({ items: [agent('a1', '角色甲'), agent('a2', '角色乙')], total: 2 }),
      'model.list': () => ({ items: [model('model_1', '模型甲')], total: 1 }),
      'agent.delete': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    await expectConfirmDoesNotLeak(<AgentsPage />, '角色甲', '角色乙', 'agent.delete');
  });

  it('模型页', async () => {
    const checked = createContractCall({
      'model.list': () => ({ items: [model('m1', '模型甲'), model('m2', '模型乙')], total: 2 }),
      'model.delete': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    await expectConfirmDoesNotLeak(<ModelsPage />, '模型甲', '模型乙', 'model.delete');
  });

  it('提示词页', async () => {
    const checked = createContractCall({
      'prompt.list': () => ({ items: [prompt('p1', '提示甲'), prompt('p2', '提示乙')], total: 2 }),
      'prompt.delete': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    await expectConfirmDoesNotLeak(<PromptsPage />, '提示甲', '提示乙', 'prompt.delete');
  });
});

describe('确认删除不在原位', () => {
  it('Agent 页：第一下点完，同一个坐标上不能再是「删除掉数据」的那个按钮', async () => {
    const checked = createContractCall({
      'agent.list': () => ({ items: [agent('a1', '角色甲')], total: 1 }),
      'model.list': () => ({ items: [model('model_1', '模型甲')], total: 1 }),
      'agent.delete': () => ({ ok: true }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await user.click(await screen.findByText('角色甲'));

    const before = await screen.findByRole('button', { name: '删除' });
    const actions = before.parentElement!;
    const indexBefore = [...actions.children].indexOf(before);

    await user.click(before);
    const confirm = await screen.findByRole('button', { name: /确认删除/u });
    const indexAfter = [...actions.children].indexOf(confirm);
    expect(
      indexAfter,
      '「确认删除」长在原来「删除」的位置上 —— 用户双击「删除」就直接删了',
    ).not.toBe(indexBefore);

    // 原位上现在应该是一个撤销出口
    const inPlace = actions.children[indexBefore] as HTMLElement;
    expect(inPlace.textContent).toContain('取消');
  });
});
