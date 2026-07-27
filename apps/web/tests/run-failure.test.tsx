import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 失败运行的详情 —— 图纸「03 执行记录」的失败横幅。
 *
 * 图纸原文是「节点 3『解析日志』失败 · 错误分类：timeout」，
 * 右侧「attempt 2 / 2 · 48s」，下面四个按钮。
 *
 * 实现原来显示的是「节点『script_shell_2』失败」—— 内部 id。
 * 用户从没见过那个 id，他看到的是自己起的名字。
 *
 * 重试也一样：codex 数过，失败详情里「重试 / 重新运行 / 再次运行」
 * 按钮数量为 0，用户只能自己回编辑器重新填一遍运行表单。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');
const { useRuns } = await import('../src/runs/runsStore.js');

const RUN = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '错误日志归因',
  versionId: 'ver_7',
  status: 'failed',
  startedAt: '2026-07-28T09:12:00.000Z',
  endedAt: '2026-07-28T09:12:48.000Z',
  inputs: { issue: '#548' },
};

const event = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({
  id: `ev_${seq}`,
  runId: 'run_1',
  seq,
  ts: '2026-07-28T09:12:00.000Z',
  type,
  actor: 'engine',
  summary: '',
  sensitivity: 'internal',
  schemaVer: 1,
  ...extra,
});

const EVENTS = [
  event(1, 'run.created', { summary: '运行已创建' }),
  event(2, 'node.started', {
    nodeId: 'script_shell_2',
    nodeLabel: '解析日志',
    attempt: 1,
    summary: '解析日志 开始',
  }),
  event(3, 'node.failed', {
    nodeId: 'script_shell_2',
    nodeLabel: '解析日志',
    attempt: 1,
    summary: 'exitCode 124 · killed after 30s',
  }),
  event(4, 'run.failed', { summary: '节点「解析日志」失败' }),
];

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'run.list': () => ({ items: [RUN] }),
    'run.get': () => ({ run: RUN }),
    'run.events': () => ({ events: EVENTS, hasMore: false, nextSeq: 5 }),
    'run.artifacts': () => ({ items: [], root: '/tmp/run_1' }),
    'run.resume': () => ({ ok: true }),
    'run.start': () => ({ runId: 'run_2' }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

/** 直接注状态：load 的那条路径由 runs-store 自己的用例覆盖。 */
function seed(run = RUN, events = EVENTS) {
  useRuns.setState({
    items: [run] as never,
    selectedId: run.id,
    events: events as never,
    error: null,
    loading: false,
  });
}

async function openFailedRun() {
  const user = userEvent.setup();
  seed();
  render(
    <MemoryRouter initialEntries={['/runs/run_1']}>
      <RunsPage />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  return user;
}

describe('失败横幅', () => {
  it('用节点标题而不是内部 id —— 用户从没见过那个 id', async () => {
    await openFailedRun();
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('解析日志');
    expect(banner.textContent).not.toContain('script_shell_2');
  });

  it('带上 attempt 与耗时 —— 图纸写的是「attempt 2 / 2 · 48s」', async () => {
    await openFailedRun();
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('attempt 1');
    expect(banner.textContent).toContain('48s');
  });

  it('正文是失败原因', async () => {
    await openFailedRun();
    expect(screen.getByRole('alert').textContent).toContain('exitCode 124');
  });

  it('没有标题的老事件退回 id —— 也好过什么都不显示', async () => {
    const user = userEvent.setup();
    void user;
    seed(RUN, [
      event(1, 'node.failed', { nodeId: 'script_shell_2', attempt: 1, summary: '失败了' }),
    ]);
    render(
      <MemoryRouter initialEntries={['/runs/run_1']}>
        <RunsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('script_shell_2');
  });
});

describe('重试', () => {
  it('从失败节点重试 —— 已成功的节点不重跑', async () => {
    const user = await openFailedRun();
    await user.click(screen.getByRole('button', { name: '从失败节点重试' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('run.resume', { runId: 'run_1' });
    });
  });

  it('用相同参数重跑 —— 这是一次全新的运行，不动原来那条', async () => {
    const user = await openFailedRun();
    await user.click(screen.getByRole('button', { name: '用相同参数重跑' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('run.start', {
        workflowId: 'wf_1',
        // 沿用原来那个版本 —— 草稿可能已经改过
        versionId: 'ver_7',
        inputs: { issue: '#548' },
      });
    });
  });

  it('成功的运行不给重试按钮 —— 那没有意义', async () => {
    seed({ ...RUN, status: 'succeeded' }, [event(1, 'run.created', { summary: '运行已创建' })]);
    render(
      <MemoryRouter initialEntries={['/runs/run_1']}>
        <RunsPage />
      </MemoryRouter>,
    );
    // 列表与详情都会显示工作流名，等详情区那个
    await screen.findByRole('heading', { name: /错误日志归因/u });
    expect(screen.queryByRole('button', { name: '从失败节点重试' })).toBeNull();
  });
});

describe('内部 ID 不该出现在界面上', () => {
  const LABELED = [
    event(1, 'run.created', { summary: '运行已创建' }),
    event(2, 'node.started', {
      nodeId: 'internal_shell_77',
      nodeLabel: '用户看到的名字',
      attempt: 1,
      summary: '用户看到的名字 开始',
    }),
    event(3, 'node.succeeded', {
      nodeId: 'internal_shell_77',
      nodeLabel: '用户看到的名字',
      attempt: 1,
      summary: '完成',
    }),
  ];

  const open = () => {
    useRuns.setState({
      items: [{ ...RUN, status: 'succeeded' }] as never,
      selectedId: 'run_1',
      events: LABELED as never,
      error: null,
      loading: false,
    });
    render(
      <MemoryRouter initialEntries={['/runs/run_1']}>
        <RunsPage />
      </MemoryRouter>,
    );
  };

  it('节点进度显示标题 —— codex 复测时那一栏还是 internal_long_0', async () => {
    open();
    const progress = await screen.findByRole('region', { name: '节点进度' });
    expect(progress.textContent).toContain('用户看到的名字');
    expect(progress.textContent).not.toContain('internal_shell_77');
  });

  it('事件流也显示标题', async () => {
    open();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /事件/u }));

    const stream = await screen.findByRole('list');
    expect(stream.textContent).toContain('用户看到的名字');
    expect(stream.textContent).not.toContain('internal_shell_77');
  });

  it('老事件没有标题时退回 id —— 显示 id 也好过什么都不显示', async () => {
    useRuns.setState({
      items: [{ ...RUN, status: 'succeeded' }] as never,
      selectedId: 'run_1',
      events: [
        event(1, 'node.started', { nodeId: 'legacy_node', attempt: 1, summary: '开始' }),
      ] as never,
      error: null,
      loading: false,
    });
    render(
      <MemoryRouter initialEntries={['/runs/run_1']}>
        <RunsPage />
      </MemoryRouter>,
    );
    const progress = await screen.findByRole('region', { name: '节点进度' });
    expect(progress.textContent).toContain('legacy_node');
  });
});
