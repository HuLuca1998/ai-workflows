import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { RunEvent } from '../src/runs/runsStore.js';

/**
 * AI 节点跑的时候，运行面板要**边跑边显示**。
 *
 * 在这之前：一个跑五分钟的 AI 节点，对话那一栏一直是空的，
 * 只有几条工具调用事件在动 —— agent 说的话要等节点结束、
 * `conversation.agent_message` 落库之后才一次性出现。
 * 用户没法判断它是在想，还是已经卡死。
 *
 * 两件事要压住：
 * 1. 帧落到**对应那个节点**上（同一次运行里可能好几个节点在跑）；
 * 2. 节点结束、事件落库之后，**不能既显示事件又显示残留的帧** ——
 *    那会让同一段话出现两次。
 *
 * **断言「不该出现」的那两条都配了同步点**（先发一帧自己的、等它渲染出来）。
 * 没有同步点的话，`waitFor(() => expect(queryByText(x)).toBeNull())`
 * 在第一次检查时就通过了 —— 那时 React 还没渲染任何东西，
 * 于是把过滤逻辑整个删掉它也是绿的。实测过：删掉 nodeId 过滤，四条全过。
 */

/** Tauri 事件通道替身：把监听器抓在手里，测试自己发帧。 */
let 发帧: ((payload: unknown) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    发帧 = (payload) => handler({ payload });
    return Promise.resolve(() => {
      发帧 = null;
    });
  },
}));

// 流式只在桌面形态挂
vi.mock('../src/updater/useAppVersion.js', () => ({
  isDesktopRuntime: () => true,
  useAppVersion: () => null,
}));

const { NodeDetail } = await import('../src/runs/NodeDetail.js');

let seq = 0;
const 事件 = (type: string, extra: Partial<RunEvent> = {}): RunEvent =>
  ({
    id: `e${(seq += 1)}`,
    runId: 'run_1',
    seq,
    type,
    actor: 'agent',
    summary: '',
    ts: '2026-07-28T12:03:41.000Z',
    sensitivity: 'internal',
    schemaVer: 1,
    artifactRefs: [],
    nodeId: 'think',
    ...extra,
  }) as RunEvent;

beforeEach(() => {
  发帧 = null;
});

const 渲染 = (events: RunEvent[], running = true) =>
  render(
    <NodeDetail
      nodeId="think"
      nodeType="ai.analyze"
      nodeLabel="分析"
      runId="run_1"
      running={running}
      events={events}
    />,
  );

describe('AI 节点的实时帧', () => {
  it('边跑边显示 agent 说的话', async () => {
    渲染([事件('node.started')]);
    await waitFor(() => expect(发帧).not.toBeNull());

    发帧?.({ kind: 'text', text: '先看缓存层', runId: 'run_1', nodeId: 'think' });
    expect(await screen.findByText(/先看缓存层/u)).toBeTruthy();

    // 后一帧接在前一帧后面，而不是替换
    发帧?.({ kind: 'text', text: '，那里有个竞态', runId: 'run_1', nodeId: 'think' });
    expect(await screen.findByText(/先看缓存层，那里有个竞态/u)).toBeTruthy();
  });

  it('别的节点的帧不显示在这里', async () => {
    渲染([事件('node.started')]);
    await waitFor(() => expect(发帧).not.toBeNull());

    // 同一次运行里可能有好几个 AI 节点在跑
    发帧?.({ kind: 'text', text: '这是另一个节点说的', runId: 'run_1', nodeId: '别的节点' });
    // 先证明这条通道确实是活的 —— 否则「没显示」可能只是帧根本没到
    发帧?.({ kind: 'text', text: '自己的帧', runId: 'run_1', nodeId: 'think' });
    await screen.findByText(/自己的帧/u);

    await waitFor(() => {
      expect(screen.queryByText(/这是另一个节点说的/u)).toBeNull();
    });
  });

  it('别的运行的帧也不显示', async () => {
    渲染([事件('node.started')]);
    await waitFor(() => expect(发帧).not.toBeNull());

    发帧?.({ kind: 'text', text: '别的运行', runId: 'run_9', nodeId: 'think' });
    // 同上：先等一件**该发生**的事，证明通道是活的
    发帧?.({ kind: 'text', text: '本运行的帧', runId: 'run_1', nodeId: 'think' });
    await screen.findByText(/本运行的帧/u);

    await waitFor(() => {
      expect(screen.queryByText(/别的运行/u)).toBeNull();
    });
  });

  it('节点跑完之后不再显示残留的帧 —— 否则同一段话出现两次', async () => {
    const { rerender } = 渲染([事件('node.started')]);
    await waitFor(() => expect(发帧).not.toBeNull());
    发帧?.({ kind: 'text', text: '分析结论是这样', runId: 'run_1', nodeId: 'think' });
    await screen.findByText(/分析结论是这样/u);

    // 节点结束：回答已经落库成事件，running 变 false
    rerender(
      <NodeDetail
        nodeId="think"
        nodeType="ai.analyze"
        nodeLabel="分析"
        runId="run_1"
        running={false}
        events={[
          事件('node.started'),
          事件('conversation.agent_message', { summary: '分析结论是这样' }),
        ]}
      />,
    );

    // 只剩事件那一份
    await waitFor(() => {
      expect(screen.getAllByText(/分析结论是这样/u)).toHaveLength(1);
    });
  });
});
