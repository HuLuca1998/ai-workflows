import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 「一条都没有」有两种，说的话必须不一样：
 *
 * - 库是空的 → 告诉他这里是干什么的、怎么建第一条
 * - 搜出来是空的 → 告诉他**是这个词没匹配上**，并给一个清空的出口
 *
 * 三页都只有前一种：搜「zzz」得到「还没有 Agent 角色」，
 * 用户会以为自己攒的十几个角色没了。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { AgentsPage } = await import('../src/agents/AgentsPage.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

/** 搜索是发给后端的，所以「有词就返回空」正是真实行为。 */
function respondEmptyOnQuery(listMethod: string, extra: Record<string, () => unknown> = {}) {
  const handlers: Record<string, (input: unknown) => unknown> = {
    [listMethod]: (input: unknown) =>
      (input as { query?: string }).query ? { items: [], total: 0 } : { items: [], total: 0 },
    ...extra,
  };
  const checked = createContractCall(handlers);
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
}

beforeEach(() => {
  call.mockReset();
});

async function searchAndExpectNoMatchCopy(ui: React.ReactElement, placeholder: RegExp) {
  const user = userEvent.setup();
  render(ui);
  await user.type(await screen.findByPlaceholderText(placeholder), 'zzz');
  await waitFor(
    () => {
      expect(screen.getByText(/没有匹配/u)).toBeTruthy();
    },
    { timeout: 3000 },
  );
  // 空库文案不能同时出现 —— 那两句话说的是两回事
  expect(screen.queryByText(/还没有/u)).toBeNull();
  // 给一个清空的出口，否则用户得自己把词删干净
  expect(screen.getByRole('button', { name: /清空搜索/u })).toBeTruthy();
}

describe('搜索无结果', () => {
  it('Agent 页说的是「没有匹配」，不是「还没有角色」', async () => {
    respondEmptyOnQuery('agent.list', { 'model.list': () => ({ items: [], total: 0 }) });
    await searchAndExpectNoMatchCopy(<AgentsPage />, /搜索|角色/u);
  });

  it('模型页同理', async () => {
    respondEmptyOnQuery('model.list');
    await searchAndExpectNoMatchCopy(<ModelsPage />, /搜索|模型/u);
  });

  it('提示词页同理', async () => {
    respondEmptyOnQuery('prompt.list');
    await searchAndExpectNoMatchCopy(<PromptsPage />, /搜索|提示词/u);
  });
});
