import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 作用域下拉不能承诺引擎不做的事。
 *
 * 第三方巡检 C-15 实测：新建记忆时作用域可以选「工作流 / Agent / 会话」，
 * 表单不问「是哪一个」，保存后条目挂着「工作流」徽章 —— 而页面顶部写着
 * 「记忆会注入后续每一次 AI 调用」。
 *
 * 实证下来比这更糟：`memories_for_injection` 的两个调用点
 * （`runner.rs:656` 与 `core-api/src/lib.rs:2167`）**都写死
 * `scope="workspace", scopeId=None`** —— 六档里只有「工作区」那一档
 * 真的会被注入，其余五档存进去就再也不会生效。
 *
 * 这是 DEBT B-5 那一类：填了不生效比报错更糟。
 * 在引擎按作用域取记忆之前，界面必须说清楚。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { MemoryPage } = await import('../src/memory/MemoryPage.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'memory.list': () => ({ items: [], total: 0 }),
    'memory.create': () => ({ id: 'mem_1' }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function 打开新建() {
  const user = userEvent.setup();
  render(<MemoryPage />);
  await user.click(await screen.findByRole('button', { name: /新建记忆/u }));
  return user;
}

describe('作用域要说清哪一档真的生效', () => {
  it('选了不会被注入的档位时当场说明', async () => {
    const user = await 打开新建();

    await user.selectOptions(screen.getByRole('combobox', { name: /作用域/u }), 'workflow');

    await waitFor(() => {
      const 说明 = screen.getByRole('status', { name: /作用域说明/u });
      expect(说明.textContent, '引擎只注入「工作区」那一档，其余五档存了不生效').toMatch(
        /不会注入|不生效|暂不/u,
      );
    });
  });

  it('选「工作区」时不出现那句警告 —— 常驻的提醒会被无视', async () => {
    const user = await 打开新建();
    await user.selectOptions(screen.getByRole('combobox', { name: /作用域/u }), 'workspace');

    expect(screen.queryByRole('status', { name: /作用域说明/u })).toBeNull();
  });

  it('仍然存得下去 —— 这一屏的职责是说清楚，不是拦住', async () => {
    // 引擎接上按作用域取记忆之后，这些条目就该自动生效。
    // 现在拦住的话，那一天到来时用户手上一条都没有
    const user = await 打开新建();
    await user.selectOptions(screen.getByRole('combobox', { name: /作用域/u }), 'agent');
    await user.type(screen.getByRole('textbox', { name: /Key/u }), 'k1');
    await user.type(screen.getByRole('textbox', { name: /内容/u }), 'v1');

    await user.click(screen.getByRole('button', { name: /保存|创建/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'memory.create',
        expect.objectContaining({ scope: 'agent' }),
      );
    });
  });
});
