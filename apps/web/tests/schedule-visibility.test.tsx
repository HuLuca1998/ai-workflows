import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { WorkflowSchema } from '@aiwf/contracts';

/**
 * 定时状态要在工作流列表上看得见。
 *
 * 改这条之前，列表的「版本」列尾巴上钉着一个写死的
 * `<span> · 手动</span>` —— 每一行都这么写，不管入口节点设的是什么。
 * 那是 CLAUDE.md 第二条纪律的第三种形态：**界面文案承诺了一件事，
 * 实现里没有对应代码**。设了每天 09:00 的工作流，列表上照样写「手动」。
 *
 * 还有一条更隐蔽的：调度器只跑**已发布版本**。设了定时却没发布，
 * 画布上那行「每天 09:00」照写不误而它永远不会跑 ——
 * 列表必须把这条标出来（后端那半在
 * `crates/core-api/tests/schedule_visibility_test.rs`）。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async () => {
  const actual = await vi.importActual('../src/data/workspace.js');
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

const { useWorkspace } = await import('../src/data/workspace.js');
const { OverviewPage } = await import('../src/pages/OverviewPage.js');

const NOW = '2026-08-02T09:00:00.000Z';

/**
 * 夹具**先过一遍契约**再进 store。
 *
 * `useWorkspace.load` 的闭包抓的是原模块里的 coreClient，`vi.mock`
 * 替换不到它，所以列表数据只能直接注进 store（`overview-stats.test.tsx`
 * 也是这么做的）—— 代价是绕过了 `_contractClient` 那道出参校验。
 * 手动补上：否则夹具可以写一个后端永远不会返回的形状，
 * 而照着它写的界面判断在真实数据上不成立。
 */
function seed(rows: Array<Record<string, unknown>>) {
  const parsed = rows.map((row) => {
    const result = WorkflowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(
        `夹具不合 WorkflowSchema：${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    return result.data;
  });
  useWorkspace.setState({
    workflows: parsed as never,
    total: parsed.length,
    offset: 0,
    status: null,
    query: '',
    loading: false,
    error: null,
  });
}

const base = (over: Record<string, unknown>) => ({
  id: 'wf_1',
  name: '每天跑一次',
  createdAt: NOW,
  updatedAt: NOW,
  archived: false,
  ...over,
});

beforeEach(() => {
  call.mockReset();
  // 统计卡失败不该拖垮列表 —— 页面自己 catch 了，这里给个必然拒绝的
  call.mockRejectedValue(new Error('这条用例不看统计卡'));
});

const view = () =>
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );

const row = async (name: string) => {
  const cell = await screen.findByText(name);
  const tr = cell.closest('tr');
  if (!tr) throw new Error('找不到这一行');
  return within(tr);
};

describe('工作流列表上的定时状态', () => {
  it('已发布的定时显示成一句人话，而不是恒定的「手动」', async () => {
    seed([base({ latestVersion: 1, scheduleLabel: '每天 09:00' })]);
    view();

    expect((await row('每天跑一次')).getByText(/每天 09:00/u)).toBeTruthy();
  });

  it('手动触发的行不显示定时徽章', async () => {
    // 每行都挂一个徽章等于没有徽章 —— 真正有定时的那几条会淹掉
    seed([base({ name: '手动跑', latestVersion: 1 })]);
    view();

    expect((await row('手动跑')).queryByText(/每天|每 \d/u)).toBeNull();
  });

  it('草稿上设了定时却没发布时，说清它不会跑', async () => {
    /*
     * 最要紧的一条。用户设好每天 9 点、保存、关掉应用，第二天来看
     * 什么都没跑 —— 而画布上那行「每天 09:00」还写着。
     * 不在列表上说，他没有任何办法查出原因。
     */
    seed([base({ schedulePendingPublish: true })]);
    view();

    const hint = (await row('每天跑一次')).getByText(/发布/u);
    expect(`${hint.textContent} ${hint.getAttribute('title') ?? ''}`).toMatch(
      /不会|没.*生效|未生效/u,
    );
  });

  it('提示要说清下一步做什么', async () => {
    seed([base({ schedulePendingPublish: true })]);
    view();

    const hint = (await row('每天跑一次')).getByText(/发布/u);
    expect(`${hint.textContent} ${hint.getAttribute('title') ?? ''}`).toMatch(/发布/u);
  });

  it('已发布的定时不会同时挂「还没发布」', async () => {
    seed([base({ latestVersion: 1, scheduleLabel: '每天 09:00' })]);
    view();

    expect((await row('每天跑一次')).queryByText(/还没发布|未发布/u)).toBeNull();
  });

  it('契约认得这两个字段 —— 否则后端发过来也会被 strip 掉', () => {
    // 这条守的是「界面读了一个契约里没有的字段」：Zod 对未知键是 strip，
    // 于是后端明明发了 scheduleLabel，到界面手上是 undefined，
    // 而两侧的测试都绿
    const parsed = WorkflowSchema.parse(
      base({ latestVersion: 1, scheduleLabel: '每天 09:00', schedulePendingPublish: false }),
    );
    expect(parsed.scheduleLabel).toBe('每天 09:00');
    expect(parsed.schedulePendingPublish).toBe(false);
  });
});
