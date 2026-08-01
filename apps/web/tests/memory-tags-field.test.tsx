import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 记忆的标签：列表里显示、搜索里能搜，就得能填。
 *
 * 第三方巡检 C-16 实测：内置 4 条都带标签（安全 / 工作方式），表头写着
 * 「更新 / 标签」，搜索框提示「搜索 key、内容或标签」—— 而新建与编辑
 * 表单**只有 Key / 作用域 / 内容三项**。用户建的记忆永远无标签，
 * 标签搜索对他自己的数据完全无效。
 *
 * 契约两侧都支持（`memory.create` 与 `memory.update` 都收 tags），
 * 缺的只是表单那一格。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { MemoryPage } = await import('../src/memory/MemoryPage.js');

const 已有 = {
  id: 'mem_1',
  scope: 'workspace',
  key: 'build.command',
  value: 'pnpm verify',
  source: 'user',
  createdBy: 'user',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  ver: 1,
  tags: ['工作方式'],
  enabled: true,
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'memory.list': () => ({ items: [已有], total: 1 }),
    'memory.create': () => ({ id: 'mem_2' }),
    'memory.update': () => ({ ver: 2 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('记忆表单要能填标签', () => {
  it('新建表单有标签一格', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await user.click(await screen.findByRole('button', { name: /新建记忆/u }));

    expect(
      screen.getByRole('textbox', { name: /标签/u }),
      '列表有标签列、搜索能搜标签，而表单填不了',
    ).toBeTruthy();
  });

  it('填的标签真的发出去', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await user.click(await screen.findByRole('button', { name: /新建记忆/u }));

    await user.type(screen.getByRole('textbox', { name: /Key/u }), 'k1');
    await user.type(screen.getByRole('textbox', { name: /内容/u }), 'v1');
    await user.type(screen.getByRole('textbox', { name: /标签/u }), '安全, 工作方式');
    await user.click(screen.getByRole('button', { name: /保存|创建/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'memory.create',
        expect.objectContaining({ tags: ['安全', '工作方式'] }),
      );
    });
  });

  it('编辑时回填已有的标签 —— 不回填等于每次编辑都清空它们', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await user.click(await screen.findAllByRole('button', { name: /编辑/u }).then((b) => b[0]!));

    await waitFor(() => {
      expect((screen.getByRole('textbox', { name: /标签/u }) as HTMLInputElement).value).toContain(
        '工作方式',
      );
    });
  });

  it('编辑时改标签会一起提交', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await user.click(await screen.findAllByRole('button', { name: /编辑/u }).then((b) => b[0]!));

    const tags = screen.getByRole('textbox', { name: /标签/u });
    await user.clear(tags);
    await user.type(tags, '安全');
    await user.click(screen.getByRole('button', { name: /保存/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'memory.update',
        expect.objectContaining({ tags: ['安全'] }),
      );
    });
  });

  it('空标签不发一个含空串的数组', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await user.click(await screen.findByRole('button', { name: /新建记忆/u }));
    await user.type(screen.getByRole('textbox', { name: /Key/u }), 'k1');
    await user.type(screen.getByRole('textbox', { name: /内容/u }), 'v1');
    await user.click(screen.getByRole('button', { name: /保存|创建/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.create', expect.objectContaining({ tags: [] }));
    });
  });
});
