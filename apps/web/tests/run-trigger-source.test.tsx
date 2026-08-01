import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { RunSchema } from '@aiwf/contracts';

/**
 * 运行详情要说清这一条是谁发起的。
 *
 * 定时触发上线之后，用户早上打开应用会看到一条自己没点过的运行。
 * 界面上没有任何痕迹的话，他无从判断那是调度器干的、
 * 还是别人动了他的机器 —— 而两者的处置方式完全不同。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { RunsPage } = await import('../src/runs/RunsPage.js');
const { useRuns } = await import('../src/runs/runsStore.js');

const NOW = '2026-08-02T09:00:00.000Z';

/**
 * 夹具**先过一遍 RunSchema**。
 *
 * 这一屏的既有用例直接给 store 播种（`runs-page.test.tsx` 也是），
 * 于是绕过了 `_contractClient` 那道出参校验 —— 夹具可以写一个后端
 * 永远不会返回的形状，而照着它写的界面判断在真实数据上不成立。
 */
function run(trigger: string) {
  const item = {
    id: 'run_1',
    workflowId: 'wf_1',
    workflowName: '每天跑一次',
    draftRev: 0,
    status: 'succeeded',
    inputs: {},
    envSnapshot: {},
    startedAt: NOW,
    endedAt: NOW,
    trigger,
    permissionPreset: 'human_approval',
  };
  const parsed = RunSchema.safeParse(item);
  if (!parsed.success) {
    throw new Error(
      `夹具不合 RunSchema：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

function seed(trigger: string) {
  useRuns.setState({
    items: [run(trigger)] as never,
    selectedId: 'run_1',
    events: [],
    nextSeq: 0,
    loading: false,
    error: null,
    filter: 'all',
    query: '',
  });
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ items: [], events: [], nextSeq: 0, hasMore: false });
});

const view = () =>
  render(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>,
  );

describe('运行记录上的触发来源', () => {
  it('定时跑出来的说清是定时', () => {
    seed('schedule');
    view();
    expect(screen.getByText(/定时触发|自动触发/u)).toBeTruthy();
  });

  it('间隔触发也标出来', () => {
    seed('interval');
    view();
    expect(screen.getByText(/定时触发|自动触发|间隔/u)).toBeTruthy();
  });

  it('手动跑的不标 —— 那是默认，标了只是噪声', () => {
    seed('manual');
    view();
    expect(screen.queryByText(/定时触发|自动触发/u)).toBeNull();
  });

  it('契约认得 trigger 字段 —— 否则后端发过来会被 strip 掉', () => {
    expect(run('schedule').trigger).toBe('schedule');
    // 缺字段时按契约的默认值走，老数据不会因此崩
    expect(RunSchema.parse({ ...run('manual'), trigger: undefined }).trigger).toBe('manual');
  });
});
