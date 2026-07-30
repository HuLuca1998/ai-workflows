import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

/**
 * 一条 AI 密集的运行有几百条事件，而这一栏没有筛选、没有「跳到失败处」，
 * 也不显示 seq —— 用户要回答「它在哪一步崩的」只能一行行往下读，
 * 而失败那一条与成功的长得一模一样（语气着色是另一条修好的）。
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
  status: 'failed',
  inputs: {},
  startedAt: '2026-07-30T11:30:00Z',
};

function event(seq: number, type: string, summary: string) {
  return {
    id: `e${seq}`,
    runId: 'run_1',
    seq,
    ts: '2026-07-30T11:30:00Z',
    type,
    summary,
    nodeId: 'n1',
    actor: 'engine' as const,
    sensitivity: 'internal' as const,
    schemaVer: 1,
    ...(type.startsWith('node.') ? { attempt: 1 } : {}),
  };
}

const events = [
  event(1, 'node.started', '开始读 Issue'),
  event(2, 'node.succeeded', '读 Issue 完成'),
  event(3, 'conversation.agent_message', '我看了一下…'),
  event(4, 'node.failed', '补丁应用失败'),
];

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'run.list': () => ({ items: [run], total: 1 }),
    'run.events': () => ({ events, nextSeq: 5, hasMore: false }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function openEvents(expected = 4) {
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
  await waitFor(() => {
    expect(container.querySelectorAll('.runs__event').length).toBe(expected);
  });
  return { user, container };
}

describe('事件流', () => {
  it('每行显示 seq —— 报问题时要引用「第几条」', async () => {
    const { container } = await openEvents();
    const first = container.querySelector<HTMLElement>('.runs__event')!;
    expect(within(first).getByText('#1')).toBeTruthy();
  });

  it('能只看出问题的那些', async () => {
    const { user, container } = await openEvents();
    await user.click(screen.getByRole('button', { name: /只看异常/u }));
    await waitFor(() => {
      expect(container.querySelectorAll('.runs__event').length).toBe(1);
    });
    // 中栏的节点进度行也显示同一句 summary，所以只在事件流里找
    const list = container.querySelector<HTMLElement>('.runs__events')!;
    expect(within(list).getByText('补丁应用失败')).toBeTruthy();
  });

  it('「跳到失败处」把失败那条选出来 —— 几百条事件里找不到它', async () => {
    const { user, container } = await openEvents();
    await user.click(screen.getByRole('button', { name: /跳到失败处/u }));
    await waitFor(() => {
      const marked = container.querySelector<HTMLElement>('.runs__event[data-jumped="true"]');
      expect(marked).not.toBeNull();
      expect(marked!.textContent).toContain('补丁应用失败');
    });
  });

  it('没有失败时不显示那个按钮 —— 点了没反应的按钮比没有更糟', async () => {
    const checked = createContractCall({
      'run.list': () => ({ items: [{ ...run, status: 'succeeded' }], total: 1 }),
      'run.events': () => ({ events: events.slice(0, 3), nextSeq: 4, hasMore: false }),
    });
    call.mockImplementation((m: string, i: unknown) => checked(m, i));
    await openEvents(3);
    expect(screen.queryByRole('button', { name: /跳到失败处/u })).toBeNull();
  });
});
