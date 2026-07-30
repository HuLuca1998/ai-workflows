import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 事件流此前把最多 5000 条全部铺成 DOM，而这一屏还挂着 1.2 秒一次的轮询 ——
 * 每 1.2 秒 5000 个节点参与一次 diff，滚动与输入都会掉帧（规范 §8：
 * 超过 300 行要虚拟滚动）。
 *
 * 这里用「默认只渲染最近 N 条 + 加载更早」：比虚拟滚动简单得多，
 * 而且它顺带回答了「我要看的通常是最后发生的事」。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');

const run = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '示例工作流',
  versionId: 'v1',
  status: 'succeeded',
  inputs: {},
  startedAt: '2026-07-30T11:30:00Z',
};

const events = Array.from({ length: 260 }, (_unused, index) => ({
  id: `e${index + 1}`,
  runId: 'run_1',
  seq: index + 1,
  ts: '2026-07-30T11:30:00Z',
  type: 'conversation.agent_message',
  summary: `第 ${index + 1} 条`,
  actor: 'agent' as const,
  sensitivity: 'internal' as const,
  schemaVer: 1,
}));

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'run.list': () => ({ items: [run], total: 1 }),
    'run.events': () => ({ events, nextSeq: 261, hasMore: false }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function openEvents() {
  const user = userEvent.setup();
  const { container } = render(
    <MemoryRouter>
      <RunsPage />
    </MemoryRouter>,
  );
  const row = await waitFor(() => {
    const el = container.querySelector<HTMLElement>('.runs__item');
    expect(el).not.toBeNull();
    return el!;
  });
  await user.click(row);
  await screen.findByRole('tab', { name: '事件流' });
  return { user, container };
}

describe('事件流的窗口', () => {
  it('默认只铺最近的一段，并说清楚还有多少没显示', async () => {
    const { container } = await openEvents();
    await waitFor(() => {
      const shown = container.querySelectorAll('.runs__event').length;
      expect(shown).toBeGreaterThan(0);
      expect(shown, '260 条全铺出来了').toBeLessThanOrEqual(200);
    });
    // 最后一条要在 —— 用户看的通常是最后发生的事
    expect(screen.getByText('第 260 条')).toBeTruthy();
    expect(screen.getByRole('button', { name: /更早/u })).toBeTruthy();
  });

  it('点「加载更早」把余下的补上', async () => {
    const { user, container } = await openEvents();
    await user.click(await screen.findByRole('button', { name: /更早/u }));
    await waitFor(() => {
      expect(container.querySelectorAll('.runs__event').length).toBe(260);
    });
    expect(screen.getByText('第 1 条')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /更早/u })).toBeNull();
  });

  it('条数没超过窗口时不显示那个按钮', async () => {
    const checked = createContractCall({
      'run.list': () => ({ items: [run], total: 1 }),
      'run.events': () => ({ events: events.slice(0, 10), nextSeq: 11, hasMore: false }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    await openEvents();
    expect(screen.queryByRole('button', { name: /更早/u })).toBeNull();
  });
});
