import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 审批的两个按钮。
 *
 * 它们此前是裸调后端：点下去按钮不变灰、没有 spinner，界面要等到下一次
 * 1.2s 轮询才有反应 —— 中间用户会再点一次，而 `approval.decide` 不幂等，
 * 于是发出两条决定。同一个文件里 resume/rewind/rerun 早就用上了
 * `useAsyncAction`，注释还专门写着「后端不幂等，连点两次就是两条」。
 *
 * 「拒绝」还不可撤销，却和「批准」一样是中性灰按钮、没有确认 ——
 * 规范 §5.4：危险操作只用红色文字 + 确认。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');

function makeRun(id: string, status = 'waiting_approval') {
  return {
    id,
    workflowId: 'wf_1',
    workflowName: '示例工作流',
    versionId: 'v1',
    status,
    inputs: {},
    startedAt: '2026-07-28T10:00:00Z',
    currentNode: 'approve',
  };
}

const run = makeRun('run_1');

function approvalEventOf(runId: string) {
  return {
    id: `e-${runId}`,
    runId,
    seq: 1,
    ts: '2026-07-28T10:00:01Z',
    type: 'approval.requested',
    summary: '检查 Diff',
    nodeId: 'approve',
    nodeLabel: '审批 · 检查 Diff',
  };
}

const approvalEvent = approvalEventOf('run_1');

/** 决定要等这个 resolve —— 用它把「请求进行中」那一段拉长，才测得到中间态。 */
let pendingDecide: (() => void) | null = null;

beforeEach(() => {
  call.mockReset();
  pendingDecide = null;
  const checked = createContractCall({
    'run.list': () => ({ items: [run], total: 1 }),
    'run.events': () => ({ events: [approvalEvent], nextSeq: 2 }),
    'approval.decide': () =>
      new Promise((resolve) => {
        pendingDecide = () => resolve({ ok: true });
      }),
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
});

async function openWaitingRun() {
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
  await screen.findByRole('button', { name: '批准' });
  return { user, container };
}

describe('批准', () => {
  it('点下去立刻进中间态，连点不会发出两条决定', async () => {
    const { user } = await openWaitingRun();
    const approve = screen.getByRole('button', { name: '批准' });

    await user.click(approve);

    // 请求还没回来时按钮必须已经不可点 —— 否则用户看不到任何反馈会再点一次
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /批准/u })).toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /批准/u }));
    expect(call.mock.calls.filter(([m]) => m === 'approval.decide')).toHaveLength(1);

    pendingDecide?.();
  });
});

describe('拒绝', () => {
  it('是危险操作：红色文字 + 二次确认，第一次点不发请求', async () => {
    const { user } = await openWaitingRun();

    await user.click(screen.getByRole('button', { name: '拒绝' }));
    expect(
      call.mock.calls.filter(([m]) => m === 'approval.decide'),
      '第一次点「拒绝」就把决定发出去了 —— 它不可撤销，必须先确认',
    ).toHaveLength(0);

    const confirm = await screen.findByRole('button', { name: /确认拒绝/u });
    // §5.4：危险操作用红色文字表达，不做红色实心按钮
    expect(confirm.getAttribute('data-danger')).toBe('true');

    await user.click(confirm);
    await waitFor(() => {
      expect(call.mock.calls.filter(([m]) => m === 'approval.decide')).toHaveLength(1);
    });
    pendingDecide?.();
  });

  it('确认态不跨运行残留 —— 换一条运行后按钮回到「拒绝」', async () => {
    // 在 run_1 上点出确认态，再切到 run_2：如果确认态留着，
    // 用户在 run_2 上点的第一下就直接把它拒了。
    const checked = createContractCall({
      'run.list': () => ({ items: [makeRun('run_1'), makeRun('run_2')], total: 2 }),
      'run.events': (input: unknown) => ({
        events: [approvalEventOf((input as { runId: string }).runId)],
        nextSeq: 2,
      }),
      'approval.decide': () => ({ ok: true }),
    });
    call.mockImplementation((method: string, input: unknown) => checked(method, input));

    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>,
    );
    const rows = await waitFor(() => {
      const list = container.querySelectorAll<HTMLElement>('.runs__item');
      expect(list).toHaveLength(2);
      return list;
    });

    await user.click(rows[0]!);
    await user.click(await screen.findByRole('button', { name: '拒绝' }));
    await screen.findByRole('button', { name: /确认拒绝/u });

    await user.click(rows[1]!);
    await screen.findByRole('button', { name: '拒绝' });
    expect(screen.queryByRole('button', { name: /确认拒绝/u })).toBeNull();
    expect(call.mock.calls.filter(([m]) => m === 'approval.decide')).toHaveLength(0);
  });
});

describe('取消运行', () => {
  it('确认态不跨运行残留 —— 换一条运行后按钮回到「取消运行」', async () => {
    const checked = createContractCall({
      'run.list': () => ({
        items: [makeRun('run_1', 'running'), makeRun('run_2', 'running')],
        total: 2,
      }),
      'run.events': () => ({ events: [], nextSeq: 1 }),
      'run.cancel': () => ({ ok: true }),
    });
    call.mockImplementation((method: string, input: unknown) => checked(method, input));

    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>,
    );
    const rows = await waitFor(() => {
      const list = container.querySelectorAll<HTMLElement>('.runs__item');
      expect(list).toHaveLength(2);
      return list;
    });

    await user.click(rows[0]!);
    await user.click(await screen.findByRole('button', { name: '取消运行' }));
    await screen.findByRole('button', { name: /确认取消运行/u });

    await user.click(rows[1]!);
    await screen.findByRole('button', { name: '取消运行' });
    expect(screen.queryByRole('button', { name: /确认取消运行/u })).toBeNull();
    expect(call.mock.calls.filter(([m]) => m === 'run.cancel')).toHaveLength(0);
  });
});
