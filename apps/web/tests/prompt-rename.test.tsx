import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 提示词副本要能改名。
 *
 * 第三方巡检 C-08 实测：复制出来的永远叫「X 副本」，标题是个 `<h4>`，
 * 全页只有搜索框一个 input，没有名称字段。复制两次就是两个同名条目，
 * 列表里分不清。
 *
 * 对照：Agent 角色的副本有「角色名称」textbox 可以改名 ——
 * 同一套主从布局，两个页面行为不一致。契约的 `prompt.update` 一直收 name。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

const 副本 = {
  id: 'prompt_copy',
  name: 'Diff 审查 副本',
  group: '审查',
  sections: [{ title: 'ROLE', body: '你是审查者' }],
  vars: [],
  ver: 1,
  builtin: false,
  updatedAt: '2026-08-01T00:00:00Z',
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'prompt.list': () => ({ items: [副本], total: 1 }),
    'prompt.versions': () => ({ items: [] }),
    'prompt.update': () => ({ ver: 2 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function 打开(builtin = false) {
  if (builtin) {
    const checked = createContractCall({
      'prompt.list': () => ({ items: [{ ...副本, builtin: true }], total: 1 }),
      'prompt.versions': () => ({ items: [] }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
  }
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <PromptsPage />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /Diff 审查 副本/u }));
  return user;
}

describe('提示词能改名', () => {
  it('可编辑的提示词有名称输入框', async () => {
    await 打开();
    expect(
      await screen.findByRole('textbox', { name: /提示词名称/u }),
      '复制两次就是两个同名条目，列表里分不清',
    ).toBeTruthy();
  });

  it('改完保存时把新名字发出去', async () => {
    const user = await 打开();
    const input = await screen.findByRole('textbox', { name: /提示词名称/u });
    await user.clear(input);
    await user.type(input, 'PR 描述审查');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'prompt.update',
        expect.objectContaining({ name: 'PR 描述审查' }),
      );
    });
  });

  it('内置的不给改名框 —— 它整体是只读的', async () => {
    await 打开(true);
    await screen.findByText(/你是审查者/u);
    expect(screen.queryByRole('textbox', { name: /提示词名称/u })).toBeNull();
  });

  it('名字清空时不发一个空名 —— 那会让列表里出现一条没名字的', async () => {
    const user = await 打开();
    const input = await screen.findByRole('textbox', { name: /提示词名称/u });
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    // 清空 = 没改名（退回原名），于是这次保存没有任何改动。
    // 不管走哪条路，**空名绝不能发出去**
    await waitFor(() => {
      const 发过的名字 = call.mock.calls
        .filter(([method]) => method === 'prompt.update')
        .map(([, input]) => (input as { name?: string }).name);
      expect(发过的名字.every((name) => (name ?? '').trim() !== '')).toBe(true);
    });
  });
});
