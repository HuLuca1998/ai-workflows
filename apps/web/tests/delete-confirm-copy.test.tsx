import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 删除确认要说清删了会怎样。
 *
 * 第三方巡检 C-10 实测：提示词的删除只是把右上角的按钮换成
 * 「取消 / 确认删除」，**一句话说明都没有**；而模型（「还有 Agent 角色
 * 在用它的话删不掉 —— 会告诉你是哪几个」）与角色（「删除后引用它的
 * 节点会失效」）都写得很好。三个页面里唯独提示词是空白。
 *
 * 右上角悄悄换出两个按钮很容易误点，而提示词被节点引用着 ——
 * 删掉之后那些节点拿不到提示词。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const PROMPT = {
  id: 'prompt_1',
  name: '我的提示词',
  group: '审查',
  sections: [{ title: 'ROLE', body: '你是一个审查者' }],
  vars: [],
  ver: 1,
  builtin: false,
  updatedAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'prompt.list': () => ({ items: [PROMPT], total: 1 }),
    'prompt.versions': () => ({ items: [] }),
    'prompt.delete': () => ({ ok: true }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('提示词的删除确认要说清后果', () => {
  it('进入确认态时给出一句说明，不只是换两个按钮', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PromptsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /我的提示词/u }));
    await user.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
    });
    // 与模型/角色一致：说清「引用它的东西会怎样」
    const 说明 = screen.getByRole('status');
    expect(说明.textContent, '删除确认没有任何说明 —— 右上角悄悄换出两个按钮很容易误点').toMatch(
      /节点|引用|不可/u,
    );
  });

  it('取消之后说明也跟着消失', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PromptsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /我的提示词/u }));
    await user.click(await screen.findByRole('button', { name: '删除' }));
    await user.click(await screen.findByRole('button', { name: '取消' }));

    expect(screen.queryByRole('status')).toBeNull();
  });
});
