import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 三条「读得出来」的接线：
 *
 * 1. 事件流里失败的事件与成功的必须一眼分得开（此前都是中性灰的一行小字）
 * 2. 列表行要能看出「什么时候起的、跑了多久」（此前只有绝对时刻）
 * 3. 「导出诊断包」是裸调，无中间态、可连点 —— 后端每点一次真出一个包
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { RunsPage } = await import('../src/runs/RunsPage.js');

const NOW = new Date('2026-07-30T12:00:00Z');

const run = {
  id: 'run_1',
  workflowId: 'wf_1',
  workflowName: '示例工作流',
  versionId: 'v1',
  status: 'failed',
  inputs: {},
  startedAt: '2026-07-30T11:30:00Z',
  endedAt: '2026-07-30T11:32:00Z',
};

function event(seq: number, type: string, summary: string) {
  return {
    id: `e${seq}`,
    runId: 'run_1',
    seq,
    ts: '2026-07-30T11:30:0' + String(seq) + 'Z',
    type,
    summary,
    nodeId: 'n1',
    actor: 'engine' as const,
    sensitivity: 'internal' as const,
    schemaVer: 1,
    // node.* 事件必须带 attempt —— 重试历史靠它区分轮次
    ...(type.startsWith('node.') ? { attempt: 1 } : {}),
  };
}

const events = [
  event(1, 'node.succeeded', '读 Issue 完成'),
  event(2, 'node.failed', '补丁应用失败'),
  event(3, 'artifact.created', 'patch.diff'),
];

let pendingExport: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  call.mockReset();
  pendingExport = null;
  const checked = createContractCall({
    'run.list': () => ({ items: [run], total: 1 }),
    'run.events': () => ({ events, nextSeq: 4, hasMore: false }),
    'run.diagnostics': () =>
      new Promise((resolve) => {
        pendingExport = () => resolve({ path: '/tmp/diag.zip', bytes: 2048 });
      }),
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
});

async function openRun() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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

describe('事件流', () => {
  it('失败的事件与成功的带不同的语气标记', async () => {
    const { container } = await openRun();
    const rows = await waitFor(() => {
      const list = container.querySelectorAll<HTMLElement>('.runs__event');
      expect(list.length).toBe(3);
      return list;
    });
    expect(rows[0]!.dataset['tone']).toBe('succeeded');
    expect(rows[1]!.dataset['tone']).toBe('failed');
    expect(rows[2]!.dataset['tone']).toBe('neutral');
  });
});

describe('运行列表行', () => {
  it('看得出什么时候起的、跑了多久', async () => {
    const { container } = await openRun();
    const row = container.querySelector<HTMLElement>('.runs__item')!;
    expect(row.textContent).toContain('30 分钟前');
    expect(row.textContent).toContain('2 分');
  });
});

describe('导出诊断包', () => {
  it('点下去进中间态，连点不会导出两份', async () => {
    const { user } = await openRun();
    await user.click(screen.getByRole('button', { name: '导出诊断包' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /导出/u })).toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: /导出/u }));
    expect(call.mock.calls.filter(([m]) => m === 'run.diagnostics')).toHaveLength(1);
    pendingExport?.();
  });
});
