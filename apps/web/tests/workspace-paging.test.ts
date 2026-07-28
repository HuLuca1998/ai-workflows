import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 工作区 store 的分页与筛选。
 *
 * 这一层负责「发什么请求」。页面那一层只管「点了 chip 就交给它」——
 * 两边分开测，因为页面里换不掉 store 内部的 coreClient
 *（它闭包捕获的是原模块那个实例）。
 */

const call = vi.fn();
vi.mock('../src/data/httpTransport.js', () => ({ createHttpTransport: () => ({}) }));

// coreClient 是模块内部构造的，改用直接替换它的 call
const { useWorkspace, coreClient } = await import('../src/data/workspace.js');
vi.spyOn(coreClient, 'call').mockImplementation((m: string, i: unknown) => call(m, i));

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ items: [], total: 0 });
  useWorkspace.setState({ workflows: [], total: 0, offset: 0, status: null, query: '' });
});

describe('分页', () => {
  it('load 带 limit 与 offset', async () => {
    await useWorkspace.getState().load();
    expect(call).toHaveBeenCalledWith(
      'workflow.list',
      expect.objectContaining({ limit: expect.any(Number), offset: 0 }),
    );
  });

  it('翻页只换 offset', async () => {
    await useWorkspace.getState().load(100);
    expect(call).toHaveBeenCalledWith('workflow.list', expect.objectContaining({ offset: 100 }));
  });

  it('记下总数 —— 分页控件与「N 个工作流」都靠它', async () => {
    call.mockResolvedValue({ items: [], total: 1424 });
    await useWorkspace.getState().load();
    expect(useWorkspace.getState().total).toBe(1424);
  });
});

describe('筛选与搜索', () => {
  it('状态发给后端 —— 前端过滤只能过滤当前页', async () => {
    await useWorkspace.getState().setFilter('failed', '');
    expect(call).toHaveBeenCalledWith(
      'workflow.list',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('搜索也发给后端', async () => {
    await useWorkspace.getState().setFilter(null, '归档');
    expect(call).toHaveBeenCalledWith('workflow.list', expect.objectContaining({ query: '归档' }));
  });

  it('换条件时回到第一页 —— 停在第 29 页筛完可能一条都没有', async () => {
    useWorkspace.setState({ offset: 1400 });
    await useWorkspace.getState().setFilter('failed', '');
    expect(useWorkspace.getState().offset).toBe(0);
    expect(call).toHaveBeenCalledWith('workflow.list', expect.objectContaining({ offset: 0 }));
  });

  it('「全部」不带 status —— 后端据此返回所有状态', async () => {
    await useWorkspace.getState().setFilter(null, '');
    const sent = call.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('status');
  });

  it('翻页时保持筛选条件', async () => {
    await useWorkspace.getState().setFilter('failed', 'atlas');
    call.mockClear();

    await useWorkspace.getState().load(50);
    expect(call).toHaveBeenCalledWith(
      'workflow.list',
      expect.objectContaining({ status: 'failed', query: 'atlas', offset: 50 }),
    );
  });
});
