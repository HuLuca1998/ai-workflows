import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 首页的统计卡与列表状态 —— 图纸「01 工作流首页」。
 *
 * 这两块原本是空的：M0 时既没有引擎也没有运行数据，按「宁可留空，
 * 也不要做假的」先空着。现在引擎跑起来了，数据是真的了，就该填上。
 *
 * 唯一仍然空着的是 Token 用量 —— 事件流里目前不记 token。
 * 显示 0 会被读成「这周没花钱」，那比空着更糟。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async () => {
  // 只换 coreClient，useWorkspace store 保留真实实现
  const actual = await vi.importActual('../src/data/workspace.js');
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

const { createContractCall } = await import('./_contractClient.js');
const { useWorkspace } = await import('../src/data/workspace.js');
const { OverviewPage } = await import('../src/pages/OverviewPage.js');

/**
 * 列表数据直接注进 store。
 *
 * useWorkspace 的 load 闭包捕获的是**原模块**里的 coreClient，
 * vi.mock 替换不到它 —— 那条路径由 workspace 自己的用例覆盖，
 * 这里测的是页面拿到数据后怎么渲染。
 */
function seed(items: unknown[]) {
  // 只覆盖数据，**load 与 setFilter 都保留真实实现** ——
  // 换掉的话「筛选发给后端」就测不到了。
  // load 走的是被 mock 的 coreClient，所以不会真的打网络
  useWorkspace.setState({
    workflows: items as never,
    total: items.length,
    offset: 0,
    status: null,
    query: '',
    loading: false,
    error: null,
  });
}

const STATS = {
  pendingApprovals: 1,
  pendingApprovalHint: 'GitHub Issue 修复',
  runsToday: 12,
  runsTodaySucceeded: 10,
  activeWorktrees: 3,
  worktreeBytes: 432_013_312,
};

const BASE = {
  id: 'wf_1',
  name: 'GitHub Issue 修复',
  createdAt: '2026-07-27T10:00:00Z',
  updatedAt: '2026-07-28T10:00:00Z',
  archived: false,
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'workspace.stats': () => STATS,
    'workflow.list': () => ({ items: [BASE], total: 0 }),
    'workflow.create': () => ({ id: 'wf_new' }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
  seed([BASE]);
});

const view = () =>
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );

const card = async (label: string) => {
  const region = await screen.findByRole('region', { name: '概览统计' });
  const found = within(region)
    .getAllByRole('group')
    .find((el) => el.textContent?.startsWith(label));
  if (!found) throw new Error(`没有「${label}」这张卡`);
  return found;
};

describe('四张统计卡', () => {
  it('等待审批显示数量，副文本说清是哪条在等', async () => {
    view();
    const stat = await card('等待审批');
    expect(stat.textContent).toContain('1');
    expect(stat.textContent).toContain('GitHub Issue 修复');
  });

  it('今日运行显示总数与成功数 —— 图纸写的是「12 / 10 成功」', async () => {
    view();
    const stat = await card('今日运行');
    expect(stat.textContent).toContain('12');
    expect(stat.textContent).toContain('10 成功');
  });

  it('Token 用量没有数据源时显示「—」而不是 0', async () => {
    view();
    const stat = await card('Token 用量');
    expect(stat.textContent).toContain('—');
    expect(stat.textContent).not.toContain('0');
  });

  it('有数据时 Token 用量按 M 显示', async () => {
    respond({ 'workspace.stats': () => ({ ...STATS, tokensThisWeek: 1_240_000 }) });
    view();
    const stat = await card('Token 用量');
    expect(stat.textContent).toContain('1.24M');
  });

  it('worktree 显示数量与占用', async () => {
    view();
    const stat = await card('活跃 worktree');
    expect(stat.textContent).toContain('3');
    // 统一成一位小数：概览与执行记录曾经一个显示「412 MB」、
    // 一个显示「412.0 MB」，同一个数字两种写法
    expect(stat.textContent).toContain('412.0 MB');
  });

  it('统计取不到时卡片留空，不让整页报错', async () => {
    respond({
      'workspace.stats': () => {
        throw new Error('后端没起来');
      },
    });
    view();
    // 列表照常显示 —— 统计卡失败不该拖垮首页
    expect(await screen.findByText('GitHub Issue 修复')).toBeTruthy();
    const stat = await card('今日运行');
    expect(stat.textContent).toBe('今日运行');
  });
});

/** 工作流名同时出现在统计卡的副文本里，所以行只能在表格里找。 */
const row = async (name: string) => {
  const table = await screen.findByRole('table');
  const cell = await within(table).findByText(name);
  return cell.closest('tr')!;
};

describe('列表状态跟着运行走', () => {
  it('没跑过的显示草稿与「未运行」', async () => {
    view();
    const tr = await row('GitHub Issue 修复');
    expect(tr.textContent).toContain('未运行');
    expect(tr.textContent).toContain('草稿');
  });

  it('跑过的显示最近一次运行的状态与时长', async () => {
    seed([
      {
        ...BASE,
        latestVersion: 7,
        lastRun: {
          id: 'run_1',
          status: 'succeeded',
          startedAt: '2026-07-28T09:12:00Z',
          durationMs: 123_000,
          version: 7,
        },
      },
    ]);
    view();
    const tr = await row('GitHub Issue 修复');
    expect(tr.textContent).toContain('成功');
    expect(tr.textContent).toContain('2m03s');
    expect(tr.textContent).toContain('v7');
  });

  it('等待审批的行显示「等待审批」—— 与执行记录一致', async () => {
    seed([
      {
        ...BASE,
        lastRun: {
          id: 'run_1',
          status: 'waiting_approval',
          startedAt: '2026-07-28T09:12:00Z',
        },
      },
    ]);
    view();
    const tr = await row('GitHub Issue 修复');
    expect(tr.textContent).toContain('等待审批');
  });

  it('失败的行带上停在哪个节点，行尾给的是重试 —— 图纸就是这样', async () => {
    seed([
      {
        ...BASE,
        lastRun: {
          id: 'run_1',
          status: 'failed',
          startedAt: '2026-07-28T09:12:00Z',
          durationMs: 48_000,
          failedNodeLabel: '节点 3',
        },
      },
    ]);
    view();
    const tr = await row('GitHub Issue 修复');
    expect(tr.textContent).toContain('失败');
    expect(tr.textContent).toContain('节点 3');
    expect(within(tr).getByRole('button', { name: /重试/u })).toBeTruthy();
  });
});

describe('新建不能建出多条', () => {
  it('连点五次只建一条 —— state 更新是异步的，挡不住同一批事件', async () => {
    // 直接数 store 上的 createWorkflow：它才是真正落库的那一步，
    // 而 loading 状态挡不住同一批事件里的五个 handler
    const created: string[] = [];
    useWorkspace.setState({
      workflows: [BASE] as never,
      loading: false,
      error: null,
      load: async () => {},
      createWorkflow: async (name: string | null) => {
        created.push(name ?? '(由引擎编号)');
        // 真实的建流程要等一次 IPC 往返，同步返回会让这条用例失去意义
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'wf_new';
      },
    });

    const user = userEvent.setup();
    view();
    await row('GitHub Issue 修复');

    const button = screen.getByRole('button', { name: /新建工作流/u });
    await Promise.all(Array.from({ length: 5 }, () => user.click(button).catch(() => undefined)));

    await waitFor(() => expect(created).toHaveLength(1));
  });
});

describe('筛选与搜索交给后端', () => {
  /**
   * 页面这一层的责任是「点了 chip 就把条件交给 store」。
   *
   * store 真正发什么请求由它自己的用例覆盖（workspace-paging.test.ts）——
   * 这里换不掉 store 内部的 coreClient（它闭包捕获的是原模块那个），
   * 硬测的话只会打到真实网络。
   */
  it('点筛选 chip 把状态交给 store，而不是在前端过滤', async () => {
    // codex 复测：「停在第 29 页点『失败』，页码仍显示 1401–1424，
    // 页面只剩当前页内的一条失败记录」
    const setFilter = vi.fn().mockResolvedValue(undefined);
    seed([BASE]);
    useWorkspace.setState({ setFilter });

    const user = userEvent.setup();
    view();
    await row('GitHub Issue 修复');

    // 同上：状态筛选是 toggle 组，用 aria-pressed 表达选中
    await user.click(screen.getByRole('button', { name: '失败' }));
    expect(setFilter).toHaveBeenCalledWith('failed', '');
  });

  it('搜索按回车时把关键词交给 store', async () => {
    const setFilter = vi.fn().mockResolvedValue(undefined);
    seed([BASE]);
    useWorkspace.setState({ setFilter });

    const user = userEvent.setup();
    view();
    await row('GitHub Issue 修复');

    await user.type(screen.getByLabelText('搜索工作流、运行或产物'), '归档');
    await user.keyboard('{Enter}');
    expect(setFilter).toHaveBeenCalledWith(null, '归档');
  });

  it('占位文案照图纸 —— 不在里面解释交互', () => {
    // 图纸写的是「搜索工作流、运行或产物」。曾经加过「（回车搜索）」，
    // 去掉了：要在文案里解释交互，通常说明交互本身不对。
    // 现在是输入即搜（300ms 防抖），回车立刻搜，两处一致
    view();
    expect(screen.getByPlaceholderText('搜索工作流、运行或产物')).toBeTruthy();
  });

  it('输入停手之后自动搜，不用按回车', async () => {
    // 断言打到 setFilter 上：store 是模块级单例，同文件里前面的用例
    // 会在它的 query 上留下痕迹，拿状态做断言不可靠
    const setFilter = vi.fn(async () => {});
    useWorkspace.setState({ setFilter } as never);
    view();
    await screen.findByLabelText('搜索工作流、运行或产物');

    const input = screen.getByLabelText('搜索工作流、运行或产物') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'worktree' } });
    expect(input.value, '输入框的值没跟手').toBe('worktree');

    // 防抖 300ms。等它真的发出去，而不是猜一个时长
    await waitFor(() => expect(setFilter).toHaveBeenCalledWith(null, 'worktree'), {
      timeout: 2000,
    });
  });

  it('回车立刻搜，不等那 300ms', async () => {
    const setFilter = vi.fn(async () => {});
    useWorkspace.setState({ setFilter } as never);
    view();
    await screen.findByLabelText('搜索工作流、运行或产物');

    const input = screen.getByLabelText('搜索工作流、运行或产物');
    fireEvent.change(input, { target: { value: 'worktree' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setFilter).toHaveBeenCalledWith(null, 'worktree');
  });

  it('「N 个工作流」用总数，不是当前页的行数', async () => {
    // codex 复测：「翻到最后一页时标题变成『本地优先 · 24 个工作流』，
    // 而分页总数是 1,424」——这个文案看起来像全量统计
    seed([BASE]);
    useWorkspace.setState({ total: 1424 });
    view();
    expect(await screen.findByText(/本地优先 · 1,?424 个工作流/u)).toBeTruthy();
  });
});
