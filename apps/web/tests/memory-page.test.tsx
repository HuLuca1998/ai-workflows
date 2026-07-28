import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 记忆管理 —— 图纸「04 记忆管理」。
 *
 * 要压住的产品规则：
 * 1.「AI 提议写入 · 确认后才保存，并注入后续调用」
 * 2.「删除后不再注入未来调用」—— 停用是比删除更轻的一档
 * 3.「Token、密钥和敏感文件内容禁止写入记忆」
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { MemoryPage } = await import('../src/memory/MemoryPage.js');

const SAVED = {
  id: 'mem_1',
  scope: 'workspace',
  key: 'worktree.cleanup',
  value: 'PR 合并前保留 worktree',
  source: 'user',
  createdBy: '本地用户',
  createdAt: '2026-07-27T10:00:00Z',
  updatedAt: '2026-07-27T10:00:00Z',
  ver: 2,
  tags: ['worktree'],
  enabled: true,
};

const PROPOSED = {
  ...SAVED,
  id: 'mem_2',
  key: 'style.commit',
  value: '提交信息用中文，解释为什么',
  source: 'ai_proposed',
  createdBy: 'Analyze Agent',
  enabled: false,
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'memory.list': () => ({ items: [SAVED], total: 0 }),
    'memory.create': () => ({ id: 'mem_new' }),
    'memory.update': () => ({ ok: true }),
    'memory.toggle': () => ({ ok: true }),
    'memory.delete': () => ({ ok: true }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = () => render(<MemoryPage />);

describe('列表与筛选', () => {
  it('作用域 chips 照图纸', async () => {
    view();
    const group = await screen.findByRole('group', { name: '作用域' });
    const labels = [...group.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['全部', '全局', '工作区', '工作流', 'Agent', '会话']);
  });

  it('点作用域把筛选发给后端', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('worktree.cleanup');

    await user.click(screen.getByRole('button', { name: '全局' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.list', { scope: 'global' });
    });
  });

  it('搜索占位文案照图纸，且发给后端', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('worktree.cleanup');

    const search = screen.getByPlaceholderText('搜索 key、内容或标签');
    await user.type(search, 'worktree');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.list', { query: 'worktree' });
    });
  });

  it('底部常驻那句关于密钥与权限的说明', async () => {
    view();
    expect(await screen.findByText(/Token、密钥和敏感文件内容禁止写入记忆/u)).toBeTruthy();
  });

  it('一条都没有时说明记忆是怎么来的', async () => {
    respond({ 'memory.list': () => ({ items: [], total: 0 }) });
    view();
    expect(await screen.findByText(/还没有记忆/u)).toBeTruthy();
  });
});

describe('AI 提议', () => {
  it('提议单独占一块，并说明确认后才生效', async () => {
    respond({ 'memory.list': () => ({ items: [SAVED, PROPOSED], total: 0 }) });
    view();

    const region = await screen.findByRole('region', { name: 'AI 提议写入' });
    expect(region.textContent).toContain('确认后才保存，并注入后续调用');
    expect(region.textContent).toContain('style.commit');
    expect(region.textContent).toContain('Analyze Agent');
  });

  it('采纳后启用它 —— 那才开始注入', async () => {
    respond({ 'memory.list': () => ({ items: [PROPOSED], total: 0 }) });
    const user = userEvent.setup();
    view();

    await user.click(await screen.findByRole('button', { name: '采纳并保存' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.toggle', { id: 'mem_2', enabled: true });
    });
  });

  it('忽略就删掉，不留在列表里占位', async () => {
    respond({ 'memory.list': () => ({ items: [PROPOSED], total: 0 }) });
    const user = userEvent.setup();
    view();

    await user.click(await screen.findByRole('button', { name: '忽略' }));
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.delete', { id: 'mem_2' });
    });
  });

  it('没有提议时不显示那一块', async () => {
    view();
    await screen.findByText('worktree.cleanup');
    expect(screen.queryByRole('region', { name: 'AI 提议写入' })).toBeNull();
  });
});

describe('条目操作', () => {
  it('停用一条记忆', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '停用 worktree.cleanup' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.toggle', { id: 'mem_1', enabled: false });
    });
  });

  it('停用的条目仍在列表里，并标出来 —— 用户要知道它为什么不生效', async () => {
    respond({ 'memory.list': () => ({ items: [{ ...SAVED, enabled: false }], total: 1 }) });
    view();

    expect(await screen.findByText('worktree.cleanup')).toBeTruthy();
    expect(screen.getByText('已停用')).toBeTruthy();
  });

  it('过期的条目也标出来', async () => {
    respond({
      'memory.list': () => ({ items: [{ ...SAVED, expiresAt: '2020-01-01T00:00:00Z' }], total: 1 }),
    });
    view();
    expect(await screen.findByText('已过期')).toBeTruthy();
  });

  it('删除一条记忆', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '删除 worktree.cleanup' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('memory.delete', { id: 'mem_1' });
    });
  });

  it('显示版本号 —— 更新带乐观锁，用户要看得到自己在改第几版', async () => {
    view();
    expect(await screen.findByText(/v2/u)).toBeTruthy();
  });
});
