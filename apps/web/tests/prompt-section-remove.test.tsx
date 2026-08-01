import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 加得进去的分段要删得掉。
 *
 * 第三方巡检 C-26 实测：「添加分段」→ 填标题 → 添加 → 新分段出现，
 * 但**没有任何移除按钮**。填错标题只能留着 ——
 * 而分段标题会被 CSS 强制大写显示，打错一个字就永久挂在那里。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const 可编辑的 = {
  id: 'prompt_1',
  name: '我的提示词',
  group: '审查',
  sections: [
    { title: 'ROLE', body: '你是审查者' },
    { title: 'TASK', body: '看这段 diff' },
  ],
  vars: [],
  ver: 1,
  builtin: false,
  updatedAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'prompt.list': () => ({ items: [可编辑的], total: 1 }),
    'prompt.versions': () => ({ items: [] }),
    'prompt.update': () => ({ ver: 2 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function 打开() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <PromptsPage />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /我的提示词/u }));
  return user;
}

describe('分段能删', () => {
  it('每个分段都有移除按钮', async () => {
    await 打开();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除分段 TASK' })).toBeTruthy();
    });
  });

  it('点了真的少一段', async () => {
    const user = await 打开();
    await user.click(await screen.findByRole('button', { name: '删除分段 TASK' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '删除分段 TASK' })).toBeNull();
    });
    // 另一段还在 —— 删的是点的那一段，不是清空
    expect(screen.getByRole('button', { name: '删除分段 ROLE' })).toBeTruthy();
  });

  it('内置条目上不给移除按钮 —— 它整体是只读的', async () => {
    call.mockReset();
    const checked = createContractCall({
      'prompt.list': () => ({ items: [{ ...可编辑的, builtin: true }], total: 1 }),
      'prompt.versions': () => ({ items: [] }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));

    await 打开();
    await screen.findByText(/你是审查者/u);
    expect(screen.queryByRole('button', { name: /删除分段/u })).toBeNull();
  });

  it('删到只剩一段还能删 —— 空提示词是合法草稿状态', async () => {
    const user = await 打开();
    await user.click(await screen.findByRole('button', { name: '删除分段 TASK' }));
    await user.click(await screen.findByRole('button', { name: '删除分段 ROLE' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /删除分段/u })).toBeNull();
    });
  });
});
