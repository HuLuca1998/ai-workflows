import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * 「等待审批 3」这种卡片，用户的第一反应是点进去看是哪三个。
 *
 * 第三方巡检 A-12 实测：四张统计卡全是死的 —— `cursor: auto`、无 role、
 * 不可点。用户点「等待审批」什么都不会发生。
 *
 * 有对应视图的才做成可点（等待审批 → 执行记录的待审批筛选；
 * 今日运行 → 执行记录）。「Token 用量」与「活跃 worktree」没有对应的屏，
 * 做成可点反而是另一个假承诺。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { OverviewPage } = await import('../src/pages/OverviewPage.js');

const STATS = {
  workflows: 0,
  runsActive: 0,
  runsTotal: 0,
  pendingApprovals: 3,
  runsToday: 5,
  runsTodaySucceeded: 4,
  activeWorktrees: 0,
  worktreeBytes: 0,
};

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'workspace.stats': () => STATS,
    'workflow.list': () => ({ items: [], total: 0 }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

function view() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/runs" element={<p>执行记录页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('有对应视图的统计卡可以点进去', () => {
  it('「等待审批」点进执行记录的待审批筛选', async () => {
    const user = userEvent.setup();
    view();

    const card = await screen.findByRole('link', { name: /等待审批/u });
    expect(card.getAttribute('href')).toMatch(/\/runs/u);
    await user.click(card);
    expect(await screen.findByText('执行记录页')).toBeTruthy();
  });

  it('「今日运行」点进执行记录', async () => {
    view();
    const card = await screen.findByRole('link', { name: /今日运行/u });
    expect(card.getAttribute('href')).toMatch(/\/runs/u);
  });

  it('没有对应视图的卡不做成可点 —— 那是另一个假承诺', async () => {
    view();
    await screen.findByRole('link', { name: /等待审批/u });
    expect(screen.queryByRole('link', { name: /Token 用量/u })).toBeNull();
    expect(screen.queryByRole('link', { name: /活跃 worktree/u })).toBeNull();
  });

  it('数字为 0 时不再是链接 —— 点进去只会看到一个空列表', async () => {
    call.mockReset();
    const checked = createContractCall({
      'workspace.stats': () => ({ ...STATS, pendingApprovals: 0 }),
      'workflow.list': () => ({ items: [], total: 0 }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    view();

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /等待审批/u })).toBeNull();
    });
  });
});
