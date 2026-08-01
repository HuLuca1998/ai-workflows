import { z } from 'zod';

/**
 * RunEvent —— 唯一事实来源。
 *
 * 对话视图、事件视图、产物视图、Run Console 都是这条流的投影；任何界面都不得
 * 从消息文本里拼接状态字段，也不得各自查库（功能文档 §14）。
 *
 * 大 payload 与日志落 artifacts/ 目录，事件只保留摘要与引用（技术选型 §10）。
 */

export const RUN_EVENT_CATEGORIES = [
  'run',
  'node',
  'conversation',
  'reasoning',
  'tool',
  'script',
  'approval',
  'artifact',
  'system',
] as const;
export type RunEventCategory = (typeof RUN_EVENT_CATEGORIES)[number];

/**
 * 冻结的事件类型清单。前缀即分类，UI 不需要另维护映射表。
 * 新增类型不升 schemaVer（见 docs/adr/0011）：桌面形态前后端同包发布；
 * schemaVer 留给事件记录形状本身的破坏性变更。
 */
export const RUN_EVENT_TYPES = [
  // 运行生命周期
  'run.created',
  'run.preflight_passed',
  'run.preflight_failed',
  'run.queued',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.interrupted',
  'run.cancelled',
  'run.succeeded',
  'run.failed',

  // 节点执行
  'node.queued',
  'node.started',
  'node.waiting',
  'node.retried',
  'node.succeeded',
  'node.failed',
  'node.skipped',
  'node.cancelled',
  'node.output_emitted',

  // 面向理解的对话时间线
  'conversation.user_message',
  'conversation.agent_message',
  'conversation.agent_delta',

  // 面向用户的推理摘要（不含模型私有原始思维链，见首版非目标）
  'reasoning.summary',

  // Agent 工具活动
  'tool.call_started',
  'tool.call_finished',
  'tool.call_failed',

  // 脚本执行
  'script.started',
  'script.stdout',
  'script.stderr',
  'script.exited',

  // 人工审批
  'approval.requested',
  'approval.reminded',
  'approval.decided',
  'approval.expired',

  // 产物
  'artifact.created',
  'artifact.truncated',
  /**
   * `end.artifacts` 里声明了、而工作目录里没有那个文件。
   *
   * 必须是一条事件而不是静默跳过：用户在结束节点写了 `report.json`、
   * 运行绿着结束、报告抽屉里什么都没有 —— 没有这条，
   * 他没有任何办法知道是文件名写错了还是上游没生成。
   */
  'artifact.missing',
  /** 声明的产物指向工作目录之外，或存不下。产物会进导出物，这条边界要守。 */
  'artifact.rejected',

  // 系统：可解释性的关键证据都在这里
  'system.checkpoint_saved',
  'system.env_snapshot',
  'system.memory_injected',
  'system.memory_written',
  'system.prompt_resolved',
  'system.model_resolved',
  'system.model_downgraded',
  'system.permission_granted',
  'system.permission_denied',
  'system.notification_sent',
  'system.redaction_applied',
  'system.session_rebuilt',
  /**
   * 模型的回答在 token 上限处被截断。
   *
   * 那半句话是**有用的**，所以节点不失败；但下游必须知道它不完整 ——
   * 一份被砍掉一半的方案清单，看起来和一份完整的没有区别。
   */
  'system.output_truncated',
  'system.audit',
  /**
   * 运行结束时引擎按 `cleanupPolicy` 移除了 worktree。
   *
   * 删的是用户磁盘上的目录，必须留痕 —— 事后要能回答
   * 「那个 worktree 哪去了」。分支不删：提交在分支上。
   */
  'system.worktree_cleaned',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** 事件的产生者。审计要求每条事件都能回答「谁做的」。 */
export const RUN_EVENT_ACTORS = ['user', 'engine', 'agent', 'system', 'mcp'] as const;
export type RunEventActor = (typeof RUN_EVENT_ACTORS)[number];

/** 敏感级别决定导出、预览与通知里的可见性。 */
export const SENSITIVITY_LEVELS = ['public', 'internal', 'sensitive'] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** 摘要长度上限：越界内容必须落 artifact，再用 payloadRef 指过去。 */
export const EVENT_SUMMARY_MAX = 2000;

/** 事件**记录形状**的版本。字段增删改语义时递增；枚举值的增加不算（ADR-0011）。 */
export const RUN_EVENT_SCHEMA_VERSION = 1;

const NODE_EVENT_PREFIX = 'node.';

export function categoryOfEventType(type: string): RunEventCategory {
  const prefix = type.split('.')[0];
  const found = RUN_EVENT_CATEGORIES.find((c) => c === prefix);
  if (!found) {
    throw new Error(`未登记的事件分类：${type}`);
  }
  return found;
}

export const RunEventSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    /** 单调递增，从 1 起；(run_id, seq) 在存储层唯一。 */
    seq: z.number().int().min(1),
    ts: z.iso.datetime(),
    type: z.enum(RUN_EVENT_TYPES),
    nodeId: z.string().min(1).optional(),
    /**
     * 节点在**当时**的标题。
     *
     * 记在事件里而不是让界面现查图：草稿随时可能改名，
     * 而运行记录说的是当时发生了什么。没有它的话失败横幅只能显示
     * 内部 id（「节点『script_shell_2』失败」）—— 那对用户毫无意义。
     *
     * 可选是为了向后兼容：这个改动之前的事件没有它。
     */
    nodeLabel: z.string().min(1).optional(),
    /** 每次重试产生新 attempt，从 1 起。 */
    attempt: z.number().int().min(1).optional(),
    actor: z.enum(RUN_EVENT_ACTORS),
    status: z.string().min(1).optional(),
    summary: z.string().max(EVENT_SUMMARY_MAX),
    /** 指向 artifact 的引用；事件本身永不内联大对象。 */
    payloadRef: z.string().min(1).optional(),
    artifactRefs: z.array(z.string().min(1)).optional(),
    parentEventId: z.string().min(1).optional(),
    sensitivity: z.enum(SENSITIVITY_LEVELS),
    schemaVer: z.number().int().min(1),
  })
  .superRefine((event, ctx) => {
    if (event.type.startsWith(NODE_EVENT_PREFIX)) {
      if (!event.nodeId) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodeId'],
          message: 'node.* 事件必须携带 nodeId，否则无法在画布中定位',
        });
      }
      if (event.attempt === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'node.* 事件必须携带 attempt，重试历史依赖它区分轮次',
        });
      }
    }
  });

export type RunEvent = z.infer<typeof RunEventSchema>;

export const EVENT_STREAM_ISSUE_CODES = [
  'SEQ_GAP',
  'SEQ_DUPLICATE',
  'RUN_MISMATCH',
  'DANGLING_PARENT',
] as const;
export type EventStreamIssueCode = (typeof EVENT_STREAM_ISSUE_CODES)[number];

export interface EventStreamIssue {
  code: EventStreamIssueCode;
  seq: number;
  eventId: string;
  message: string;
}

export interface ValidateEventStreamOptions {
  /** 游标分页时片段的起始 seq；不传则以片段首个事件为起点。 */
  fromSeq?: number;
}

/**
 * 校验一段事件流的结构不变量。恢复、回放与增量订阅都靠它判断「流是否可信」。
 */
export function validateEventStream(
  events: readonly RunEvent[],
  options: ValidateEventStreamOptions = {},
): EventStreamIssue[] {
  const issues: EventStreamIssue[] = [];
  const first = events[0];
  if (!first) return issues;

  const runId = first.runId;
  const seenIds = new Set<string>();
  let expectedSeq = options.fromSeq ?? first.seq;

  for (const event of events) {
    if (event.runId !== runId) {
      issues.push({
        code: 'RUN_MISMATCH',
        seq: event.seq,
        eventId: event.id,
        message: `事件属于 ${event.runId}，与流首个事件的 ${runId} 不一致`,
      });
    }

    if (event.seq < expectedSeq) {
      issues.push({
        code: 'SEQ_DUPLICATE',
        seq: event.seq,
        eventId: event.id,
        message: `seq ${event.seq} 重复或回退，写入串行化可能被破坏`,
      });
    } else if (event.seq > expectedSeq) {
      issues.push({
        code: 'SEQ_GAP',
        seq: event.seq,
        eventId: event.id,
        message: `seq 从 ${expectedSeq} 跳到 ${event.seq}，中间事件缺失`,
      });
    }
    expectedSeq = event.seq + 1;

    if (event.parentEventId && !seenIds.has(event.parentEventId)) {
      issues.push({
        code: 'DANGLING_PARENT',
        seq: event.seq,
        eventId: event.id,
        message: `parentEventId ${event.parentEventId} 未在此前出现`,
      });
    }
    seenIds.add(event.id);
  }

  return issues;
}
