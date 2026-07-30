import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
          type: 'node.succeeded',
          nodeId: 'a',
          actor: 'engine',
          summary: 'a',
        },
        {
          id: 'e2',
          seq: 2,
          ts: 't',
          type: 'node.started',
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
          type: 'run.created',
          actor: 'engine',
          summary: '运行已创建',
        },
        {
          id: 'e2',
          seq: 2,
          ts: '2026-07-27T10:00:01Z',
          type: 'node.started',
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
          type: 'node.failed',
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
          type: 'approval.requested',
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

describe('产物 tab', () => {
  /** 按方法分派：run.list 与 run.artifacts 的形状不同，一把梭会互相污染。 */
  function mockArtifacts(items: unknown[], root: string) {
    call.mockImplementation((method: string) => {
      if (method === 'run.artifacts') return Promise.resolve({ items, root });
      if (method === 'run.list') return Promise.resolve({ items: [RUN] });
      return Promise.resolve({ events: [], nextSeq: 0, hasMore: false });
    });
  }

  const ARTIFACT = {
    nodeId: 'fix',
    kind: 'log',
    name: 'stdout.log',
    path: '/tmp/x/stdout.log',
    bytes: 1240,
    sha256: 'abc',
  };

  it('切到产物会拉取这次运行的产物列表', async () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    mockArtifacts([ARTIFACT], '/tmp/x');
    const user = (await import('@testing-library/user-event')).default.setup();
    view();
    await user.click(screen.getByRole('tab', { name: '产物' }));

    await screen.findByText('stdout.log');
    expect(call).toHaveBeenCalledWith('run.artifacts', { runId: 'run_1' });
  });

  it('产物条目显示大小与所属节点', async () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    mockArtifacts([ARTIFACT], '/tmp/x');
    const user = (await import('@testing-library/user-event')).default.setup();
    view();
    await user.click(screen.getByRole('tab', { name: '产物' }));

    const row = (await screen.findByText('stdout.log')).closest('li');
    expect(row?.textContent).toContain('1.2 KB');
    expect(row?.textContent).toContain('fix');
  });

  it('没有产物时说明为什么空，并给出产物目录', async () => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    mockArtifacts([], '/tmp/runs/run_1');
    const user = (await import('@testing-library/user-event')).default.setup();
    view();
    await user.click(screen.getByRole('tab', { name: '产物' }));

    expect(await screen.findByText(/这次运行还没有产物/u)).toBeTruthy();
    expect(screen.getByText('/tmp/runs/run_1')).toBeTruthy();
  });
});

describe('审批面板认得出待决定的节点', () => {
  /** 挂载时的 load() 会拉列表；不给它正确的返回值，选中的运行会被清掉。 */
  function keepWaitingRun() {
    call.mockImplementation((method: string) => {
      if (method === 'run.list')
        return Promise.resolve({ items: [{ ...RUN, status: 'waiting_approval' }] });
      return Promise.resolve({ events: [], nextSeq: 0, hasMore: false });
    });
  }

  const approvalEvents = [
    {
      id: 'e1',
      runId: 'run_1',
      seq: 1,
      ts: 't',
      type: 'approval.requested',
      nodeId: 'ap',
      actor: 'engine',
      summary: '选择修复方案',
      sensitivity: 'internal',
      schemaVer: 1,
    },
  ];

  it('审批面板标题显示的是请求里的说明，不是空白', () => {
    keepWaitingRun();
    reset({
      items: [{ ...RUN, status: 'waiting_approval' }] as never,
      selectedId: 'run_1',
      events: approvalEvents as never,
    });
    view();
    // 事件流里也有这段文本，所以按面板标题的角色定位
    const title = document.querySelector('.runs__approval-title');
    expect(title?.textContent).toContain('选择修复方案');
  });

  it('已决定过的审批不再显示决定入口', () => {
    keepWaitingRun();
    reset({
      items: [{ ...RUN, status: 'waiting_approval' }] as never,
      selectedId: 'run_1',
      events: [
        ...approvalEvents,
        {
          id: 'e2',
          runId: 'run_1',
          seq: 2,
          ts: 't',
          type: 'approval.decided',
          nodeId: 'ap',
          actor: 'user',
          summary: '决定：approved',
          sensitivity: 'internal',
          schemaVer: 1,
        },
      ] as never,
    });
    view();
    // 面板还在（状态仍是 waiting_approval），但已经找不到未决定的节点
    const title = document.querySelector('.runs__approval-title');
    expect(title?.textContent).not.toContain('选择修复方案');
  });
});

describe('节点行可选中（图纸「03 执行记录」）', () => {
  /** 两个节点、四条事件的运行 —— 够验证「选中后只剩这个节点的事件」。 */
  const 打开一条运行 = () => {
    const 事件 = (seq: number, type: string, nodeId: string) => ({
      id: `e${seq}`,
      runId: 'run_1',
      seq,
      ts: '2026-07-28T10:00:00Z',
      type,
      nodeId,
      nodeLabel: nodeId === 'a' ? '第一个节点' : '第二个节点',
      actor: 'engine',
      summary: `${nodeId} 的事件`,
      sensitivity: 'normal',
      schemaVer: 1,
    });
    reset({
      items: [RUN] as never,
      selectedId: 'run_1',
      events: [
        事件(1, 'node.started', 'a'),
        事件(2, 'node.succeeded', 'a'),
        事件(3, 'node.started', 'b'),
        事件(4, 'node.succeeded', 'b'),
      ] as never,
    });
    view();
  };

  /**
   * 第 5 轮审查（动态）：「执行记录节点行点不动（图纸有 onClick）」。
   *
   * 图纸的节点进度栏每一行都带 `onClick: () => setState({ nodeSel: n.id })`，
   * 选中的行有紫色边框与背景；选中之后详情区显示**那个节点的**运行细节，
   * 而不是整条运行的。
   *
   * 不能点的话，一条 20 个节点的运行只能在事件流里自己数 ——
   * 而节点进度栏摆在那里，看起来就该能点。
   */
  it('点节点行把它选中', () => {
    打开一条运行();

    const 行 = document.querySelector('.runs__node');
    expect(行, '没有节点行').toBeTruthy();
    fireEvent.click(行 as Element);

    expect((行 as HTMLElement).dataset.selected).toBe('true');
  });

  it('选中之后换成那个节点的专属面板 —— 那才是「看这个节点发生了什么」', () => {
    // 原先是把同一张事件表按 nodeId 筛一遍。筛完仍然是一串
    // `node.started / tool.call_finished / …`，用户还得自己认哪几行有用 ——
    // 一次 AI 分析有几十条工具调用，结论那一条淹在中间。
    // 现在按节点类型分发到各自的视图（脚本看命令与退出码、AI 看对话、
    // worktree 看分支），见 NodeDetail
    打开一条运行();

    expect(document.querySelectorAll('.runs__event').length).toBeGreaterThan(0);
    fireEvent.click(document.querySelector('.runs__node') as Element);

    expect(document.querySelector('.ndetail'), '没换成节点详情面板').toBeTruthy();
    expect(document.querySelectorAll('.runs__event').length, '整条运行的事件流还留在那儿').toBe(0);
  });

  it('再点一次取消选中 —— 回到整条运行的视图', () => {
    打开一条运行();

    const 行 = document.querySelector('.runs__node') as Element;
    fireEvent.click(行);
    fireEvent.click(行);

    expect((行 as HTMLElement).dataset.selected).toBeUndefined();
  });

  it('节点行是按钮 —— 键盘也要能选', () => {
    打开一条运行();
    const 行 = document.querySelector('.runs__node');
    expect(行?.tagName.toLowerCase(), '节点行不是按钮，键盘用户点不到').toBe('button');
  });
});

describe('状态穷尽性 —— 已经这么栽过一次', () => {
  /**
   * 第 5 轮审查 B1（第 10 条）：`runStatus()` 用 `as` 断言绕开类型检查，
   * 不认识的状态**静默渲染成「已创建」**。第 23 条说的是同一件事：
   * 「已经这么栽过一次的状态穷尽性没有测试压着」。
   *
   * 契约有 11 个状态，而这条链上有三份副本：
   * `RunStatusName`（packages/ui）、`STATUS_META`（同上）、
   * `KNOWN_STATUSES`（RunsPage）。
   *
   * `packages/ui` 不依赖 contracts 是有意的（组件库要能独立用），
   * 所以类型没法直接派生 —— 那就用测试把三边钉在一起。
   * 契约加第 12 个状态时，这条会红。
   */
  it('契约的每个状态，徽章都认得', async () => {
    const { RUN_STATUSES } = await import('@aiwf/contracts');
    const { statusLabel } = await import('@aiwf/ui');

    for (const status of RUN_STATUSES) {
      // statusLabel 对未知状态返回状态名本身（见下一条），
      // 所以「返回值等于输入」就说明它不认识
      const label = statusLabel(status as never);
      expect(label, `徽章不认识状态 ${status}，它会显示成兜底值`).not.toBe(status);
    }
  });

  it('RunsPage 不把未知状态伪装成「已创建」', async () => {
    const { runStatusForTest } = await import('../src/runs/RunsPage.js');

    // 兜底仍要有（后端可能比前端新），但不能装成一个具体的已知状态：
    // 一条正在跑的运行显示成「已创建」，用户会以为它还没开始
    expect(runStatusForTest('从未见过的状态')).toBe('从未见过的状态');
  });

  it('契约的每个状态在 RunsPage 里都原样通过', async () => {
    const { RUN_STATUSES } = await import('@aiwf/contracts');
    const { runStatusForTest } = await import('../src/runs/RunsPage.js');

    for (const status of RUN_STATUSES) {
      expect(runStatusForTest(status), `${status} 被改写了`).toBe(status);
    }
  });
});

/**
 * 从别处跳进这一屏时，URL 里带的东西要真的被读。
 *
 * 首页失败行的「重试」用的是**路径**参数 `/runs/<id>`，而这里只读
 * **查询**参数 `?run=`。路由注册的是 `/runs/*` 所以不会 404 ——
 * 页面照常渲染，只是什么都没选中：用户看到的是
 * 「选一次运行，这里会显示它的完整记录。」，他刚点的那次既没被选中
 * 也没被重试，得自己回列表里重新找。
 *
 * 同类第二处：审批横幅的「查看 Diff」带了 `&tab=artifacts`，
 * 而 tab 是纯 useState，从不读 URL。
 */
describe('从 URL 进来', () => {
  const 从 = (entry: string) => {
    reset({ items: [RUN] as never, selectedId: 'run_1' });
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <RunsPage />
      </MemoryRouter>,
    );
  };

  it('带 tab 参数进来时打开的是那个 tab', () => {
    从('/runs?run=run_1&tab=artifacts');
    expect(screen.getByRole('tab', { name: '产物' }).getAttribute('aria-selected')).toBe('true');
  });

  it('没带 tab 时默认事件流', () => {
    从('/runs?run=run_1');
    expect(screen.getByRole('tab', { name: '事件流' }).getAttribute('aria-selected')).toBe('true');
  });

  it('认不出的 tab 值退回事件流，而不是三个都不选', () => {
    从('/runs?run=run_1&tab=瞎写的');
    expect(screen.getByRole('tab', { name: '事件流' }).getAttribute('aria-selected')).toBe('true');
  });
});

/**
 * 失败页那三个主操作要防连点。
 *
 * 它们原本是裸 `<button>`：没有 disabled、没有 loading，store 里也没有
 * ref 锁。而后端 `run.start` 不幂等 —— 连点两次就是两条运行、
 * 两个执行线程、同一个 workdir。第二条的 worktree 节点会撞
 * 「分支已存在。换一个分支名」，一句完全指错方向的提示。
 *
 * 仓库里已经有做对的写法（`OverviewPage` 的 `creatingRef` 配
 * 「连点五次只建一条」）—— 那是全仓唯一一条连点测试，没有推广到别处。
 */
describe('失败页防连点', () => {
  /**
   * 让某个方法的请求**悬着**不返回 —— 连点的窗口正是「上一次还没回来」那段。
   * 其余方法照常应答：页面加载时的 run.list 会重设列表，
   * 不给它那条失败运行的话，失败横幅连同这几个按钮会当场从 DOM 上消失。
   */
  const 挂起 = (方法: string) => {
    const 失败运行 = { ...RUN, status: 'failed' };
    call.mockImplementation((method: string) => {
      if (method === 方法) return new Promise(() => {});
      if (method === 'run.list') return Promise.resolve({ items: [失败运行], total: 1 });
      return Promise.resolve({ items: [], events: [], nextSeq: 0, hasMore: false });
    });
  };

  const 失败态 = () =>
    reset({
      items: [{ ...RUN, status: 'failed' }] as never,
      selectedId: 'run_1',
      events: [
        {
          id: 'e1',
          seq: 1,
          ts: 't',
          type: 'node.failed',
          nodeId: '解析日志',
          actor: 'engine',
          summary: 'exitCode 1',
        },
      ] as never,
    });

  for (const [名字, 方法] of [
    ['从失败节点重试', 'run.resume'],
    ['回到最近审批点改选择', 'run.rewindToApproval'],
  ] as const) {
    it(`连点五次「${名字}」只发一次请求`, async () => {
      const user = userEvent.setup();
      挂起(方法);
      失败态();
      view();

      const 按钮 = screen.getByRole('button', { name: new RegExp(名字, 'u') });
      for (let i = 0; i < 5; i += 1) await user.click(按钮);

      expect(call.mock.calls.filter(([m]) => m === 方法)).toHaveLength(1);
    });

    it(`「${名字}」进行中时自己是禁用的`, async () => {
      const user = userEvent.setup();
      挂起(方法);
      失败态();
      view();

      const 按钮 = screen.getByRole('button', { name: new RegExp(名字, 'u') });
      await user.click(按钮);

      // 禁用是给人看的那一半：没有它，用户不知道自己那一下算没算数
      expect(按钮).toBeDisabled();
    });
  }
});
