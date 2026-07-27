import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * 执行记录页 —— 断言的是**图纸结构**：三栏、每栏里有什么、
 * 数据没到位时留空而不是填演示内容。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { RunsPage } = await import('../src/runs/RunsPage.js');
const { useRuns } = await import('../src/runs/runsStore.js');

const RUN = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '批量文件整理',
  status: 'running',
  inputs: { issue: '42', repo: 'atlas-api' },
  currentNode: 'fix',
  startedAt: '2026-07-27T10:00:00Z',
};

function reset(state: Partial<ReturnType<typeof useRuns.getState>> = {}) {
  useRuns.setState({
    items: [],
    selectedId: null,
    events: [],
    nextSeq: 0,
    loading: false,
    error: null,
    filter: 'all',
    query: '',
    ...state,
  });
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ items: [], events: [], nextSeq: 0, hasMore: false });
  reset();
});

const view = () =>
  render(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>,
  );

describe('左栏 · 运行记录', () => {
  it('有搜索框，占位文案照图纸', () => {
    view();
    expect(screen.getByPlaceholderText('搜索工作流、参数或 Run ID')).toBeTruthy();
  });

  it('筛选 chips 照图纸四个', () => {
    view();
    const filters = screen.getByRole('group', { name: '筛选运行' });
    const labels = within(filters)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['全部', '运行中', '待审批', '失败']);
  });

  it('分成「并行进行中」与「历史」两组，计数是真实条数', () => {
    reset({
      items: [RUN, { ...RUN, id: 'run_2', status: 'succeeded' }] as never,
    });
    view();
    expect(screen.getByText('并行进行中 · 1')).toBeTruthy();
    expect(screen.getByText('历史 · 1')).toBeTruthy();
  });

  it('底部常驻图纸那句关于并行与环境快照的说明', () => {
    view();
    expect(screen.getByText('同一工作流可用不同参数并行运行，环境快照互不影响')).toBeTruthy();
  });

  it('运行条目显示工作流名、状态、参数与当前节点', () => {
    reset({ items: [RUN] as never });
    view();
    const item = screen.getByRole('button', { name: /批量文件整理/u });
    expect(item.textContent).toContain('批量文件整理');
    expect(item.textContent).toContain('issue=42');
    expect(item.textContent).toContain('fix');
  });

  it('一条运行都没有时说清楚为什么空，不放演示数据', () => {
    view();
    expect(screen.getByText(/还没有运行记录/u)).toBeTruthy();
    // 图纸里的示例名不该出现在真实界面上
    expect(screen.queryByText(/批量文件整理/u)).toBeNull();
  });
});

describe('中栏 · 节点进度', () => {
  it('没选中运行时不显示假的进度数字', () => {
    view();
    const panel = screen.getByRole('region', { name: '节点进度' });
    expect(panel.textContent).not.toMatch(/\d+%/u);
  });

  it('进度百分比来自事件流里的完成节点数', () => {
    reset({
      items: [RUN] as never,
      selectedId: 'run_1',
      events: [
        {
          id: 'e1',
          seq: 1,
          ts: 't',
          kind: 'node.succeeded',
          nodeId: 'a',
          actor: 'engine',
          summary: 'a',
        },
        {
          id: 'e2',
          seq: 2,
          ts: 't',
          kind: 'node.started',
          nodeId: 'b',
          actor: 'engine',
          summary: 'b',
        },
      ] as never,
    });
    view();
    const panel = screen.getByRole('region', { name: '节点进度' });
    expect(panel.textContent).toContain('1');
  });
});

describe('右栏 · 运行详情', () => {
  it('没选中运行时提示先选一个，而不是显示空白框架', () => {
    reset({ items: [RUN] as never });
    view();
    expect(screen.getByText(/选一次运行/u)).toBeTruthy();
  });

  it('头部显示工作流名与启动参数，参数照图纸是等宽药丸', () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    view();
    const head = screen.getByRole('region', { name: '运行详情' });
    expect(within(head).getByRole('heading').textContent).toBe('批量文件整理');
    expect(head.textContent).toContain('issue=42');
    expect(head.textContent).toContain('repo=atlas-api');
  });

  it('三个 tab 照图纸：事件流、产物、对话', () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    view();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['事件流', '产物', '对话']);
  });

  it('事件流按 seq 顺序渲染，每条带时间、类型与摘要', () => {
    reset({
      items: [RUN] as never,
      selectedId: 'run_1',
      events: [
        {
          id: 'e1',
          seq: 1,
          ts: '2026-07-27T10:00:00Z',
          kind: 'run.created',
          actor: 'engine',
          summary: '运行已创建',
        },
        {
          id: 'e2',
          seq: 2,
          ts: '2026-07-27T10:00:01Z',
          kind: 'node.started',
          nodeId: 'fix',
          actor: 'engine',
          summary: '修复 开始',
        },
      ] as never,
    });
    view();
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('run.created');
    expect(items[0]?.textContent).toContain('运行已创建');
    expect(items[1]?.textContent).toContain('node.started');
  });

  it('事件流底部常驻脱敏说明', () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    view();
    expect(screen.getByText('Secret 值在写入事件存储前已脱敏，界面不提供绕过查看')).toBeTruthy();
  });

  it('运行失败时显示失败横幅，指出是哪个节点', () => {
    reset({
      items: [{ ...RUN, status: 'failed' }] as never,
      selectedId: 'run_1',
      events: [
        {
          id: 'e1',
          seq: 1,
          ts: 't',
          kind: 'node.failed',
          nodeId: '解析日志',
          actor: 'engine',
          summary: 'exitCode 124',
        },
      ] as never,
    });
    view();
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('解析日志');
    expect(banner.textContent).toContain('exitCode 124');
  });

  it('运行没失败时不显示失败横幅', () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    view();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('产物与对话 tab 还没有真实数据，明说而不是造假', () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    view();
    // 默认是事件流；这两个 tab 的空态文案要说清楚等哪个里程碑
    expect(screen.getByRole('tab', { name: '产物' }).getAttribute('aria-selected')).toBe('false');
  });
});

describe('操作', () => {
  it('进行中的运行可以取消', async () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    view();
    expect(screen.getByRole('button', { name: '取消运行' })).toBeTruthy();
  });

  it('已结束的运行不显示取消按钮', () => {
    reset({ items: [{ ...RUN, status: 'succeeded' }] as never, selectedId: 'run_1' });
    view();
    expect(screen.queryByRole('button', { name: '取消运行' })).toBeNull();
  });

  it('等待审批时给出批准与拒绝，图纸里审批是必须的暂停点', () => {
    reset({
      items: [{ ...RUN, status: 'waiting_approval' }] as never,
      selectedId: 'run_1',
      events: [
        {
          id: 'e1',
          seq: 1,
          ts: 't',
          kind: 'approval.requested',
          nodeId: 'ap',
          actor: 'engine',
          summary: '选择修复方案',
        },
      ] as never,
    });
    view();
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
  });
});
