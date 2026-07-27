import { describe, expect, it } from 'vitest';
import {
  RUN_EVENT_CATEGORIES,
  RUN_EVENT_TYPES,
  RunEventSchema,
  categoryOfEventType,
  validateEventStream,
  type RunEvent,
} from '../src/events.js';

/**
 * RunEvent 是唯一事实来源（产品原则 §1）。这组测试锁住三件事：
 * 1. 类型清单不许悄悄增删——它是 M0 冻结物之一；
 * 2. 事件不许承载原始大 payload，只能存摘要与引用（技术选型 §10）；
 * 3. 对话 / 事件 / 产物三视图共用同一条流，所以流本身的不变量必须在契约层验。
 */

const baseEvent = {
  id: 'ev_1',
  runId: 'run_1',
  seq: 1,
  ts: '2026-07-27T04:00:00.000Z',
  type: 'run.started',
  actor: 'engine',
  summary: '运行开始',
  sensitivity: 'internal',
  schemaVer: 1,
} satisfies Record<string, unknown>;

describe('事件分类清单', () => {
  it('恰好九类，且顺序稳定（UI 筛选器依赖此顺序）', () => {
    expect(RUN_EVENT_CATEGORIES).toEqual([
      'run',
      'node',
      'conversation',
      'reasoning',
      'tool',
      'script',
      'approval',
      'artifact',
      'system',
    ]);
  });

  it('每个事件类型都能归入九类之一，没有孤儿类型', () => {
    for (const type of RUN_EVENT_TYPES) {
      const category = categoryOfEventType(type);
      expect(RUN_EVENT_CATEGORIES).toContain(category);
    }
  });

  it('事件类型的命名前缀即其分类，避免 UI 侧再维护一张映射表', () => {
    expect(categoryOfEventType('node.failed')).toBe('node');
    expect(categoryOfEventType('approval.requested')).toBe('approval');
    expect(categoryOfEventType('system.model_downgraded')).toBe('system');
  });

  it('覆盖了产品文档点名的关键事件', () => {
    // 「任何运行都能回答：用了哪个版本、哪些提示词版本、哪个模型、注入了哪些记忆、
    //   谁在什么时候批准了什么」——这些都必须有对应事件才可追溯。
    for (const required of [
      'run.started',
      'node.retried',
      'approval.requested',
      'approval.decided',
      'system.memory_injected',
      'system.prompt_resolved',
      'system.model_downgraded',
      'artifact.created',
    ] as const) {
      expect(RUN_EVENT_TYPES).toContain(required);
    }
  });
});

describe('RunEvent 结构校验', () => {
  it('接受一条最小合法事件', () => {
    expect(RunEventSchema.parse(baseEvent)).toMatchObject({ seq: 1, type: 'run.started' });
  });

  it('拒绝未登记的事件类型', () => {
    expect(() => RunEventSchema.parse({ ...baseEvent, type: 'run.exploded' })).toThrow();
  });

  it('seq 从 1 起且为整数', () => {
    expect(() => RunEventSchema.parse({ ...baseEvent, seq: 0 })).toThrow();
    expect(() => RunEventSchema.parse({ ...baseEvent, seq: 1.5 })).toThrow();
  });

  it('node.* 事件必须带 nodeId 与 attempt', () => {
    expect(() =>
      RunEventSchema.parse({ ...baseEvent, type: 'node.started', summary: '节点开始' }),
    ).toThrow(/nodeId/);
    expect(
      RunEventSchema.parse({
        ...baseEvent,
        type: 'node.started',
        nodeId: 'n1',
        attempt: 1,
        summary: '节点开始',
      }),
    ).toMatchObject({ nodeId: 'n1' });
  });

  it('summary 有长度上限，大内容只能落 artifact 后用引用', () => {
    expect(() => RunEventSchema.parse({ ...baseEvent, summary: 'x'.repeat(2001) })).toThrow();
  });

  it('不接受内联原始 payload —— 只接受 payloadRef', () => {
    const withInlinePayload = { ...baseEvent, payload: { huge: 'x'.repeat(100) } };
    const parsed = RunEventSchema.parse(withInlinePayload) as Record<string, unknown>;
    expect(parsed.payload).toBeUndefined();
    expect(RunEventSchema.parse({ ...baseEvent, payloadRef: 'artifact_9' })).toMatchObject({
      payloadRef: 'artifact_9',
    });
  });

  it('敏感级别限定三档，供导出与预览决定可见性', () => {
    for (const s of ['public', 'internal', 'sensitive'] as const) {
      expect(RunEventSchema.parse({ ...baseEvent, sensitivity: s }).sensitivity).toBe(s);
    }
    expect(() => RunEventSchema.parse({ ...baseEvent, sensitivity: 'secret' })).toThrow();
  });
});

describe('事件流不变量', () => {
  const ev = (seq: number, patch: Partial<RunEvent> = {}): RunEvent =>
    RunEventSchema.parse({ ...baseEvent, id: `ev_${seq}`, seq, ...patch });

  it('同一 run 内 seq 必须连续递增', () => {
    expect(validateEventStream([ev(1), ev(2), ev(3)])).toEqual([]);
    const issues = validateEventStream([ev(1), ev(3)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('SEQ_GAP');
  });

  it('拒绝重复 seq（写入串行化被破坏的信号）', () => {
    const issues = validateEventStream([ev(1), ev(2), ev(2)]);
    expect(issues.map((i) => i.code)).toContain('SEQ_DUPLICATE');
  });

  it('拒绝跨 run 混流', () => {
    const issues = validateEventStream([ev(1), ev(2, { runId: 'run_2' })]);
    expect(issues.map((i) => i.code)).toContain('RUN_MISMATCH');
  });

  it('parentEventId 必须指向流内更早的事件', () => {
    const issues = validateEventStream([ev(1), ev(2, { parentEventId: 'ev_99' })]);
    expect(issues.map((i) => i.code)).toContain('DANGLING_PARENT');
  });

  it('允许从任意 fromSeq 开始的分页片段（游标分页不算断流）', () => {
    expect(validateEventStream([ev(41), ev(42)], { fromSeq: 41 })).toEqual([]);
  });
});

describe('节点标题随事件一起记下', () => {
  const nodeEvent = (extra: Record<string, unknown> = {}) => ({
    id: 'ev_1',
    runId: 'run_1',
    seq: 1,
    ts: '2026-07-28T10:00:00.000Z',
    type: 'node.failed',
    nodeId: 'script_shell_2',
    attempt: 1,
    actor: 'engine',
    summary: '脚本以退出码 7 结束',
    sensitivity: 'internal',
    schemaVer: 1,
    ...extra,
  });

  it('node.* 事件可以带节点标题', () => {
    const parsed = RunEventSchema.safeParse(nodeEvent({ nodeLabel: '解析日志' }));
    expect(parsed.success).toBe(true);
  });

  it('标题缺席也合法 —— 老事件没有它，不能因此读不出来', () => {
    // 事件是不可变的历史，加字段时必须向后兼容：
    // 设成必填的话，这个改动之前写下的每一条运行记录都会读不出来
    expect(RunEventSchema.safeParse(nodeEvent()).success).toBe(true);
  });

  it('标题记在事件里而不是现查图 —— 草稿改了历史也不该跟着变', () => {
    // 这条用例记的是决定本身：节点标题可以在事件之后被改掉，
    // 那时再去读图会显示新标题，而运行记录说的是「当时」发生了什么
    const parsed = RunEventSchema.parse(nodeEvent({ nodeLabel: '解析日志' }));
    expect(parsed.nodeLabel).toBe('解析日志');
  });
});
