import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 残缺的提示词不能静默入库。
 *
 * 第三方巡检 C-12 实测两条：
 *
 * - 点两次「插入变量」留下两个 `${input.}`（**空变量名**），保存成功、
 *   无警告，而列表摘要写「6 段 · 2 变量」把畸形占位符不计数 ——
 *   同一份数据两处计数不一致
 * - 新建提示词只填名称就能存下 5 段全空的提示词
 *
 * 运行时才炸：`${input.}` 在引擎里解析成一个空引用，
 * 报「未定义的引用」并让那个节点失败。
 *
 * 拦在保存那一刻，而不是拦在编辑中途 —— 编辑过程里有半截占位符是正常的。
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
  sections: [{ title: 'ROLE', body: '你是审查者' }],
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

describe('空变量名拦在保存那一刻', () => {
  it('正文里留着 ${input.} 时保存被拦下并说明', async () => {
    const user = await 打开();
    const body = screen.getByLabelText('ROLE');
    await user.clear(body);
    await user.type(body, '审查 ${{input.} 这个');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent, '空变量名静默入库，运行时才报「未定义的引用」').toMatch(
      /变量名|占位符|\$\{input\.\}/u,
    );
    expect(call).not.toHaveBeenCalledWith('prompt.update', expect.anything());
  });

  it('填好变量名之后就能存', async () => {
    const user = await 打开();
    const body = screen.getByLabelText('ROLE');
    await user.clear(body);
    await user.type(body, '审查 ${{input.target} 这个');
    await user.click(screen.getByRole('button', { name: '保存新版本' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('prompt.update', expect.anything());
    });
  });

  it('编辑中途不拦 —— 打字打到一半必然出现半截占位符', async () => {
    const user = await 打开();
    const body = screen.getByLabelText('ROLE');
    await user.clear(body);
    await user.type(body, '审查 ${{input.');

    // 没点保存就不该有任何报错
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
