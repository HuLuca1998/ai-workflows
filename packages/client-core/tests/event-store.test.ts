import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@aiwf/contracts';
import { EventStore } from '../src/event-store.js';

/**
 * 「执行记录的三种视图（对话 / 事件 / 产物）都从同一事件流投影，禁止各自查库」
 * ——功能文档 §14。EventStore 就是那个唯一的流。
 *
 * 它还要扛住真实传输的脏情况：重复推送、乱序到达、断线重连后的重叠分页。
 */

let seqCounter = 0;

function ev(patch: Partial<RunEvent> & { type: RunEvent['type'] }): RunEvent {
  seqCounter += 1;
  return {
    id: `ev_${patch.seq ?? seqCounter}`,
    runId: 'run_1',
    seq: patch.seq ?? seqCounter,
    ts: '2026-07-27T04:00:00.000Z',
    actor: 'engine',
    summary: '',
    sensitivity: 'internal',
    schemaVer: 1,
    ...patch,
  } as RunEvent;
}

describe('归并与去重', () => {
  it('按 seq 排序，与到达顺序无关', () => {
    const store = new EventStore('run_1');
    store.ingest([ev({ type: 'node.started', seq: 3, nodeId: 'n1', attempt: 1 })]);
    store.ingest([ev({ type: 'run.started', seq: 1 })]);
    store.ingest([ev({ type: 'run.queued', seq: 2 })]);

    expect(store.all().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('同一 seq 重复推送只保留一条（断线重连会重发）', () => {
    const store = new EventStore('run_1');
    const event = ev({ type: 'run.started', seq: 1 });
    store.ingest([event]);
    store.ingest([event]);
    store.ingest([{ ...event, summary: '重发的同一条' }]);

    expect(store.all()).toHaveLength(1);
  });

  it('忽略不属于本 run 的事件，避免并行运行串流', () => {
    const store = new EventStore('run_1');
    store.ingest([ev({ type: 'run.started', seq: 1 })]);
    store.ingest([ev({ type: 'run.started', seq: 2, runId: 'run_2' })]);

    expect(store.all()).toHaveLength(1);
  });

  it('nextSeq 给出下次拉取的游标', () => {
    const store = new EventStore('run_1');
    expect(store.nextSeq()).toBe(0);
    store.ingest([ev({ type: 'run.started', seq: 1 }), ev({ type: 'run.queued', seq: 2 })]);
    expect(store.nextSeq()).toBe(2);
  });

  it('检测到空洞时报告出来，让调用方回补而不是装作完整', () => {
    const store = new EventStore('run_1');
    store.ingest([
      ev({ type: 'run.started', seq: 1 }),
      ev({ type: 'node.queued', seq: 5, nodeId: 'n1', attempt: 1 }),
    ]);
    expect(store.gaps()).toEqual([{ from: 2, to: 4 }]);
  });

  it('订阅者在每次摄入后被通知一次，而不是每条事件一次', () => {
    const store = new EventStore('run_1');
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.ingest([ev({ type: 'run.started', seq: 1 }), ev({ type: 'run.queued', seq: 2 })]);
    expect(notified).toBe(1);
  });

  it('没有新事件时不通知（避免画布空刷）', () => {
    const store = new EventStore('run_1');
    const event = ev({ type: 'run.started', seq: 1 });
    store.ingest([event]);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.ingest([event]);
    expect(notified).toBe(0);
  });
});

describe('三视图投影', () => {
  const build = () => {
    const store = new EventStore('run_1');
    store.ingest([
      ev({ type: 'run.started', seq: 1, summary: '运行开始' }),
      ev({ type: 'conversation.user_message', seq: 2, actor: 'user', summary: '读取 issue #548' }),
      ev({ type: 'node.started', seq: 3, nodeId: 'analyze', attempt: 1, summary: '分析开始' }),
      ev({ type: 'reasoning.summary', seq: 4, actor: 'agent', summary: '定位到 TTL 缓存' }),
      ev({ type: 'tool.call_finished', seq: 5, actor: 'agent', summary: '6 次读取，2 次搜索' }),
      ev({
        type: 'conversation.agent_message',
        seq: 6,
        actor: 'agent',
        summary: '根因是缓存未失效',
      }),
      ev({ type: 'node.succeeded', seq: 7, nodeId: 'analyze', attempt: 1, summary: '分析完成' }),
      ev({ type: 'artifact.created', seq: 8, summary: 'diff.patch', artifactRefs: ['art_1'] }),
      ev({
        type: 'approval.requested',
        seq: 9,
        nodeId: 'approve',
        attempt: 1,
        summary: '检查 Diff',
      }),
      ev({ type: 'script.stdout', seq: 10, nodeId: 'lint', attempt: 1, summary: 'all good' }),
    ]);
    return store;
  };

  it('对话视图只保留面向理解的时间线', () => {
    const items = build().conversation();
    const types = items.map((i) => i.type);
    expect(types).toContain('conversation.user_message');
    expect(types).toContain('reasoning.summary');
    expect(types).toContain('approval.requested');
    // 脚本 stdout 属于事件视图，不该混进对话
    expect(types).not.toContain('script.stdout');
  });

  it('事件视图可按九类筛选', () => {
    const store = build();
    expect(store.byCategory(['script']).map((e) => e.seq)).toEqual([10]);
    expect(store.byCategory(['node', 'approval']).map((e) => e.seq)).toEqual([3, 7, 9]);
    // 不给筛选条件就是全部
    expect(store.byCategory()).toHaveLength(10);
  });

  it('产物视图收集 artifact 引用', () => {
    expect(build().artifacts()).toEqual([{ seq: 8, label: 'diff.patch', refs: ['art_1'] }]);
  });

  it('节点进度按节点归并出状态与耗时轮次', () => {
    const progress = build().nodeProgress();
    const analyze = progress.find((p) => p.nodeId === 'analyze');
    expect(analyze).toMatchObject({ status: 'succeeded', attempt: 1 });
    const approve = progress.find((p) => p.nodeId === 'approve');
    expect(approve?.status).toBe('waiting');
  });

  it('重试时节点进度跟到最新一轮，不显示旧轮次', () => {
    const store = new EventStore('run_1');
    store.ingest([
      ev({ type: 'node.failed', seq: 1, nodeId: 'fix', attempt: 1 }),
      ev({ type: 'node.retried', seq: 2, nodeId: 'fix', attempt: 2 }),
      ev({ type: 'node.started', seq: 3, nodeId: 'fix', attempt: 2 }),
    ]);
    expect(store.nodeProgress()[0]).toMatchObject({ nodeId: 'fix', status: 'running', attempt: 2 });
  });

  it('运行状态由 run.* 事件推导，界面不需要自己拼', () => {
    const store = build();
    expect(store.runStatus()).toBe('waiting_approval');

    store.ingest([ev({ type: 'run.succeeded', seq: 11 })]);
    expect(store.runStatus()).toBe('succeeded');
  });

  it('可解释性：能回答「用了哪个模型、注入了哪些记忆、谁批准了什么」', () => {
    const store = new EventStore('run_1');
    store.ingest([
      ev({ type: 'system.model_resolved', seq: 1, summary: 'ACP · Codex 5.6 · high' }),
      ev({ type: 'system.memory_injected', seq: 2, summary: '保留 worktree 直到 PR 合并' }),
      ev({ type: 'system.prompt_resolved', seq: 3, summary: 'analyze/root-cause v4' }),
      ev({ type: 'approval.decided', seq: 4, actor: 'user', summary: '批准并推送' }),
    ]);
    const trace = store.provenance();
    expect(trace.models).toEqual(['ACP · Codex 5.6 · high']);
    expect(trace.memories).toEqual(['保留 worktree 直到 PR 合并']);
    expect(trace.prompts).toEqual(['analyze/root-cause v4']);
    expect(trace.approvals).toEqual([{ seq: 4, actor: 'user', summary: '批准并推送' }]);
  });
});
