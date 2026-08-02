import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { RunSchema } from '@aiwf/contracts';

/**
 * 同一条工作流并行跑多个，以及子运行 —— 列表上要分得清。
 *
 * 两个真实场景，现在的平铺列表都表达不了：
 *
 * **一、同一条工作流同时有好几个 run。** 「Issue 修复」可能同时在修
 * 三个 issue。平铺之后是三行一模一样的工作流名，只有参数不同 ——
 * 用户要逐行读 `issue=42` 才能分辨，而「现在有几个在跑」这个
 * 最该一眼看到的数字，没有任何地方写着。
 *
 * **二、子运行与父运行平级。** 子工作流调用起的那条 Run
 * （`parentRunId` 指着父运行）在列表里跟别人长得一样，
 * 于是用户看到一条自己没启动过的运行，无从判断它是谁叫起来的。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (method: string, input: unknown) => call(method, input) },
}));

const { RunsPage } = await import('../src/runs/RunsPage.js');
const { useRuns } = await import('../src/runs/runsStore.js');

const NOW = '2026-08-02T09:00:00.000Z';

function run(over: Record<string, unknown>) {
  const item = {
    id: 'run_1',
    workflowId: 'wf_fix',
    workflowName: 'Issue 修复',
    draftRev: 0,
    status: 'running',
    inputs: {},
    envSnapshot: {},
    startedAt: NOW,
    trigger: 'manual',
    permissionPreset: 'human_approval',
    ...over,
  };
  const parsed = RunSchema.safeParse(item);
  if (!parsed.success) {
    throw new Error(
      `夹具不合 RunSchema：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

function seed(items: ReturnType<typeof run>[]) {
  useRuns.setState({
    items: items as never,
    selectedId: null,
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

/**
 * 左栏列表。用 testid 而不是 role=list：行本身是 `button`，
 * 套一个 role=list 会让它们变成「列表里没有列表项」的无障碍违规。
 */
const 列表 = () => within(screen.getByTestId('runs-list-body'));

describe('同一条工作流的多个并行运行', () => {
  it('并行跑三个时，把「几个在跑」写出来', () => {
    seed([
      run({ id: 'run_1', inputs: { issue: '42' } }),
      run({ id: 'run_2', inputs: { issue: '43' } }),
      run({ id: 'run_3', inputs: { issue: '44' } }),
    ]);
    view();

    // 三行一模一样的工作流名，用户只能逐行读参数才分得清
    expect(列表().getByText(/3 个在跑|3 个运行中/u)).toBeTruthy();
  });

  it('只有一个在跑时不写 —— 常驻的计数是噪声', () => {
    seed([run({ id: 'run_1', inputs: { issue: '42' } })]);
    view();

    expect(列表().queryByText(/个在跑|个运行中/u)).toBeNull();
  });

  it('已经结束的不算进「在跑」', () => {
    seed([
      run({ id: 'run_1', status: 'running' }),
      run({ id: 'run_2', status: 'succeeded', endedAt: NOW }),
      run({ id: 'run_3', status: 'failed', endedAt: NOW }),
    ]);
    view();

    expect(列表().queryByText(/个在跑|个运行中/u)).toBeNull();
  });

  it('等审批的算在跑 —— 它占着一个执行位', () => {
    seed([
      run({ id: 'run_1', status: 'running' }),
      run({ id: 'run_2', status: 'waiting_approval' }),
    ]);
    view();

    expect(列表().getByText(/2 个在跑|2 个运行中/u)).toBeTruthy();
  });

  it('不同工作流各算各的', () => {
    seed([
      run({ id: 'run_1', workflowId: 'wf_fix', workflowName: 'Issue 修复' }),
      run({ id: 'run_2', workflowId: 'wf_digest', workflowName: '仓库动态' }),
    ]);
    view();

    expect(列表().queryByText(/个在跑|个运行中/u)).toBeNull();
  });
});

describe('分组里那一行显示什么', () => {
  it('优先显示参数 —— 那才是用户用来区分三个并行运行的东西', () => {
    /*
     * 分组标题已经写了工作流名，行内那一格空出来了。
     * 放 run id 尾号的话，最没用的东西占了最显眼的位置 ——
     * 用户区分「同时在修的三个 issue」靠的是 issue=42，不是 a3f19c2b。
     */
    seed([
      run({ id: 'run_aaaaaaaa1111', inputs: { issue: '42' } }),
      run({ id: 'run_bbbbbbbb2222', inputs: { issue: '43' } }),
    ]);
    view();

    /*
     * 只断言**名字那一格**，不是整行的 textContent ——
     * 参数本来就在下面那行渲染，整行必然包含 42，
     * 那样断言的话实现改成显示 id 尾号它照样绿（第一版就是这么假绿的）。
     */
    const 名字格 = () =>
      [...document.querySelectorAll('.runs__item-name')].map((el) => el.textContent);
    expect(名字格()).toEqual(['issue=42', 'issue=43']);
  });

  it('参数不重复显示两遍', () => {
    // 名字格搬来参数之后，下面那行原样保留的话同一份东西写两遍
    seed([
      run({ id: 'run_a', inputs: { issue: '42' } }),
      run({ id: 'run_b', inputs: { issue: '43' } }),
    ]);
    view();

    const 行 = 列表().getAllByRole('button');
    const 出现次数 = (行[0]!.textContent?.match(/issue=42/gu) ?? []).length;
    expect(出现次数, '同一份参数在一行里出现了两次').toBe(1);
  });

  it('没有参数时退回 run id 尾号 —— 总得有个能指认的东西', () => {
    seed([run({ id: 'run_aaaaaaaa1111' }), run({ id: 'run_bbbbbbbb2222' })]);
    view();

    const 名字格 = [...document.querySelectorAll('.runs__item-name')].map((el) => el.textContent);
    expect(名字格).toEqual(['aaaa1111', 'bbbb2222']);
  });
});

describe('子运行', () => {
  it('标出「子运行」，不与父运行混在一起', () => {
    /*
     * 子工作流调用起的那条 Run 在列表里跟别人长得一样，
     * 用户看到一条自己没启动过的运行，无从判断是谁叫起来的。
     */
    seed([
      run({ id: 'run_parent', workflowName: '父流程' }),
      run({
        id: 'run_child',
        workflowId: 'wf_sub',
        workflowName: '子流程',
        parentRunId: 'run_parent',
      }),
    ]);
    view();

    const 子行 = screen.getByText('子流程').closest('button');
    expect(子行, '找不到子运行那一行').toBeTruthy();
    expect(within(子行!).getByText(/子运行/u)).toBeTruthy();
  });

  it('顶层运行不标', () => {
    seed([run({ id: 'run_1' })]);
    view();
    expect(列表().queryByText(/子运行/u)).toBeNull();
  });
});
