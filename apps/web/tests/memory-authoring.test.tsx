import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 「记忆管理」这一屏只能停用与删除 —— 没有新建，也没有编辑。
 *
 * 契约里 memory.create / memory.update 都在，MCP 也开着它们：
 * 用户能通过 AI 间接写入，却不能自己写一条「构建命令是 pnpm verify」。
 * 一屏叫「管理」的页面只提供删除，是把能力锁在了界面外面。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { MemoryPage } = await import('../src/memory/MemoryPage.js');

const item = {
  id: 'mem_1',
  scope: 'workspace',
  key: '构建命令',
  value: 'pnpm verify',
  source: 'user',
  createdBy: 'luca',
  createdAt: '2026-07-27T10:00:00Z',
  updatedAt: '2026-07-27T10:00:00Z',
  sensitivity: 'internal',
  ver: 1,
  tags: [],
  enabled: true,
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'memory.list': () => ({ items: [item], total: 1 }),
    'memory.create': () => ({ id: 'mem_new' }),
    'memory.update': () => ({ ver: 2 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

describe('新建记忆', () => {
  it('有入口，填完发出去的是合契约的 payload', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);

    await user.click(await screen.findByRole('button', { name: /新建记忆/u }));
    await user.type(screen.getByLabelText('Key'), '部署命令');
    await user.type(screen.getByLabelText('内容'), 'pnpm release');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const created = call.mock.calls.find(([m]) => m === 'memory.create');
      expect(created).toBeTruthy();
      expect(created![1]).toMatchObject({ key: '部署命令', value: 'pnpm release' });
    });
  });

  it('key 与内容是必填 —— 空记忆注入进去只会占上下文', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    await user.click(await screen.findByRole('button', { name: /新建记忆/u }));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});

describe('编辑记忆', () => {
  it('改内容后带上 ver 发出去 —— update 是乐观锁接口', async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);

    await user.click(await screen.findByRole('button', { name: /编辑 构建命令/u }));
    const value = screen.getByLabelText('内容');
    await user.clear(value);
    await user.type(value, 'pnpm verify --fix');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const updated = call.mock.calls.find(([m]) => m === 'memory.update');
      expect(updated).toBeTruthy();
      expect(updated![1]).toMatchObject({ id: 'mem_1', ver: 1, value: 'pnpm verify --fix' });
    });
  });
});
