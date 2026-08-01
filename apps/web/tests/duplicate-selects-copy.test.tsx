import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 点「复制」之后，详情面板要切到副本。
 *
 * 第三方巡检 C-09 实测：打开内置「决策者」→ 点「复制」→ 左侧列表出现
 * 「决策者 副本 v1」，而**右侧详情仍停在只读的内置决策者**（只读横幅
 * 还在、「保存新版本」仍是灰的）。看起来像什么都没发生，
 * 用户会以为复制失败而连点几次，攒出一堆副本。
 *
 * 复制的意图就是「我要改一份」——落点应该是那份能改的。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const 内置 = {
  id: 'builtin:review',
  name: 'Diff 审查',
  group: '审查',
  sections: [{ title: 'ROLE', body: '你是审查者' }],
  vars: [],
  ver: 1,
  builtin: true,
  updatedAt: '2026-08-01T00:00:00Z',
};

const 副本 = { ...内置, id: 'prompt_copy', name: 'Diff 审查 副本', builtin: false };

beforeEach(() => {
  call.mockReset();
  let 有副本 = false;
  const checked = createContractCall({
    'prompt.list': () => ({
      items: 有副本 ? [内置, 副本] : [内置],
      total: 有副本 ? 2 : 1,
    }),
    'prompt.versions': () => ({ items: [] }),
    'prompt.duplicate': () => {
      有副本 = true;
      return { id: 副本.id };
    },
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('复制之后落在副本上', () => {
  it('详情面板切到新副本，而不是停在被复制的那条', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PromptsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /Diff 审查/u }));
    await user.click(await screen.findByRole('button', { name: '复制' }));

    await waitFor(() => {
      // 副本可编辑：「保存新版本」不再是灰的
      expect(screen.getByRole('button', { name: '保存新版本' })).not.toBeDisabled();
    });
  });

  it('只读横幅跟着消失 —— 它是「你改不了这条」的信号', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PromptsPage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /Diff 审查/u }));
    await screen.findByText(/内置提示词不能删除|先复制一份/u);

    await user.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => {
      expect(screen.queryByText(/内置提示词不能删除/u)).toBeNull();
    });
  });
});
