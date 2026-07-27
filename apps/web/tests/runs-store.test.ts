import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 执行记录的数据层。
 *
 * 事件流是唯一事实来源，界面上的一切（进度、当前节点、失败原因）
 * 都从事件推出来——另存一份状态就多一处会不一致的地方。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { useRuns } = await import('../src/runs/runsStore.js');

const RUN = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '批量文件整理',
  status: 'running',
  inputs: { issue: '42' },
  currentNode: 'fix',
  startedAt: '2026-07-27T10:00:00Z',
};

beforeEach(() => {
  call.mockReset();
  useRuns.setState({
    items: [],
    selectedId: null,
    events: [],
    nextSeq: 0,
    loading: false,
    error: null,
    filter: 'all',
    query: '',
  });
});

describe('运行列表', () => {
  it('加载后按图纸分成进行中与历史两组', async () => {
    call.mockResolvedValueOnce({
      items: [
        RUN,
        { ...RUN, id: 'run_2', status: 'succeeded' },
        { ...RUN, id: 'run_3', status: 'waiting_approval' },
      ],
    });
    await useRuns.getState().load();

    const { active, past } = useRuns.getState().grouped();
    // 等待审批也是「进行中」：它没结束，只是在等人
    expect(active.map((r) => r.id)).toEqual(['run_1', 'run_3']);
    expect(past.map((r) => r.id)).toEqual(['run_2']);
  });

  it('筛选条件与搜索一起发给后端，不在前端过滤', async () => {
    // 前端过滤只能过滤已加载的那一页，用户搜三个月前的运行会搜不到
    call.mockResolvedValue({ items: [] });
    useRuns.setState({ filter: 'failed', query: 'atlas' });
    await useRuns.getState().load();

    expect(call).toHaveBeenCalledWith('run.list', {
      status: ['failed'],
      query: 'atlas',
    });
  });

  it('筛选为全部时不发 status，让后端返回所有状态', async () => {
    call.mockResolvedValue({ items: [] });
    await useRuns.getState().load();
    expect(call).toHaveBeenCalledWith('run.list', {});
  });

  it('加载失败时保留已有列表并显示原因', async () => {
    useRuns.setState({ items: [RUN] as never });
    call.mockRejectedValueOnce(new Error('数据库锁住了'));
    await useRuns.getState().load();

    expect(useRuns.getState().items).toHaveLength(1);
    expect(useRuns.getState().error).toContain('数据库锁住了');
  });
});

describe('事件流', () => {
  it('选中运行会拉它的事件', async () => {
    call.mockResolvedValueOnce({
      events: [
        { id: 'ev_1', seq: 1, ts: 't', kind: 'run.created', actor: 'engine', summary: '已创建' },
      ],
      nextSeq: 1,
      hasMore: false,
    });
    await useRuns.getState().select('run_1');

    expect(call).toHaveBeenCalledWith('run.events', { runId: 'run_1', fromSeq: 0, limit: 200 });
    expect(useRuns.getState().events).toHaveLength(1);
    expect(useRuns.getState().nextSeq).toBe(1);
  });

  it('增量拉取从 nextSeq 开始，不重复读已有的部分', async () => {
    useRuns.setState({
      selectedId: 'run_1',
      events: [{ id: 'ev_1', seq: 1, ts: 't', kind: 'run.created', actor: 'engine', summary: 'x' }],
      nextSeq: 1,
    });
    call.mockResolvedValueOnce({
      events: [{ id: 'ev_2', seq: 2, ts: 't', kind: 'run.started', actor: 'engine', summary: 'y' }],
      nextSeq: 2,
      hasMore: false,
    });
    await useRuns.getState().pollEvents();

    expect(call).toHaveBeenCalledWith('run.events', { runId: 'run_1', fromSeq: 1, limit: 200 });
    expect(useRuns.getState().events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('切换运行会清空上一个运行的事件', async () => {
    useRuns.setState({
      selectedId: 'run_1',
      events: [{ id: 'ev_1', seq: 9, ts: 't', kind: 'run.created', actor: 'engine', summary: 'x' }],
      nextSeq: 9,
    });
    call.mockResolvedValueOnce({ events: [], nextSeq: 0, hasMore: false });
    await useRuns.getState().select('run_2');

    // 留着上一个运行的事件会让用户看到别的运行的记录
    expect(useRuns.getState().events).toEqual([]);
    expect(useRuns.getState().nextSeq).toBe(0);
  });
});

describe('从事件推出进度', () => {
  const events = (kinds: [string, string | undefined][]) =>
    kinds.map(([kind, nodeId], index) => ({
      id: `ev_${index}`,
      seq: index + 1,
      ts: '2026-07-27T10:00:00Z',
      kind,
      ...(nodeId ? { nodeId } : {}),
      actor: 'engine',
      summary: kind,
    }));

  it('已完成节点数来自 node.succeeded 事件', () => {
    useRuns.setState({
      events: events([
        ['run.started', undefined],
        ['node.started', 'a'],
        ['node.succeeded', 'a'],
        ['node.started', 'b'],
      ]) as never,
    });
    const progress = useRuns.getState().progress();
    expect(progress.done).toBe(1);
    expect(progress.current).toBe('b');
  });

  it('同一节点重试两次只算一次完成', () => {
    useRuns.setState({
      events: events([
        ['node.succeeded', 'a'],
        ['node.failed', 'a'],
        ['node.succeeded', 'a'],
      ]) as never,
    });
    expect(useRuns.getState().progress().done).toBe(1);
  });

  it('没有事件时进度是零而不是崩掉', () => {
    expect(useRuns.getState().progress()).toEqual({ done: 0, current: null, failed: null });
  });

  it('失败节点被单独指出来，供失败横幅显示', () => {
    useRuns.setState({
      events: events([
        ['node.succeeded', 'a'],
        ['node.failed', 'b'],
      ]) as never,
    });
    expect(useRuns.getState().progress().failed).toBe('b');
  });

  it('失败后重试成功就不再算失败', () => {
    useRuns.setState({
      events: events([
        ['node.failed', 'b'],
        ['node.succeeded', 'b'],
      ]) as never,
    });
    expect(useRuns.getState().progress().failed).toBeNull();
  });
});

describe('操作', () => {
  it('取消后重新加载列表，让状态立刻反映出来', async () => {
    call.mockResolvedValue({ items: [] });
    await useRuns.getState().cancel('run_1');

    expect(call).toHaveBeenNthCalledWith(1, 'run.cancel', { runId: 'run_1' });
    expect(call).toHaveBeenNthCalledWith(2, 'run.list', {});
  });

  it('审批决定带上运行与节点', async () => {
    call.mockResolvedValue({ ok: true });
    useRuns.setState({ selectedId: 'run_1' });
    await useRuns.getState().decide('ap', 'approved');

    expect(call).toHaveBeenNthCalledWith(1, 'approval.decide', {
      runId: 'run_1',
      nodeId: 'ap',
      decision: 'approved',
    });
  });

  it('没选中运行时审批不发请求', async () => {
    await useRuns.getState().decide('ap', 'approved');
    expect(call).not.toHaveBeenCalled();
  });
});
