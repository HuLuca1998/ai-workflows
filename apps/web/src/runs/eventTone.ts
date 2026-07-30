import type { RunEventType } from '@aiwf/contracts';

/**
 * 事件的语气 —— 决定事件流里那一行用什么颜色。
 *
 * 此前事件行只按前缀分四类（运行/节点/AI/审批），于是 `node.failed` 与
 * `node.succeeded` 在同一条流里长得一模一样：都是中性灰的一行小字。
 * 一条跑了几百个事件的运行，用户找不到「哪一步崩的」，只能一行行读类型名。
 *
 * 语气不按前缀分，按**结果**分：失败/警示/成功/等待/中性。
 */
export type EventTone = 'failed' | 'warn' | 'succeeded' | 'waiting' | 'neutral';

/**
 * 明确列出，不做前缀猜测。
 *
 * 猜测在这里会错得很难看：`system.permission_denied` 与
 * `system.permission_granted` 只差一个词，`artifact.truncated` 是警示而
 * `artifact.created` 是中性 —— 任何「按前缀归类」的写法都会把它们混在一起。
 */
const TONES: Partial<Record<RunEventType, EventTone>> = {
  'run.preflight_failed': 'failed',
  'run.failed': 'failed',
  'run.cancelled': 'warn',
  'run.interrupted': 'warn',
  'run.paused': 'warn',
  'run.succeeded': 'succeeded',
  'run.preflight_passed': 'succeeded',

  'node.failed': 'failed',
  'node.cancelled': 'warn',
  'node.retried': 'warn',
  'node.skipped': 'warn',
  'node.succeeded': 'succeeded',
  'node.waiting': 'waiting',

  'tool.call_failed': 'failed',
  'tool.call_finished': 'succeeded',

  'script.stderr': 'warn',

  'approval.requested': 'waiting',
  'approval.reminded': 'waiting',
  'approval.expired': 'warn',

  'artifact.truncated': 'warn',

  'system.permission_denied': 'failed',
  'system.model_downgraded': 'warn',
  /** 半句话仍然有用，所以节点不失败 —— 但下游必须看得出它不完整 */
  'system.output_truncated': 'warn',
};

export function eventTone(type: string): EventTone {
  return TONES[type as RunEventType] ?? 'neutral';
}

/**
 * `script.exited` 的语气要看退出码，光看类型判不出来。
 *
 * 摘要形如「退出码 1」/「exit=0」，取第一个整数即可；取不到就中性 ——
 * 猜一个「失败」比不说更糟。
 */
export function scriptExitTone(summary: string): EventTone {
  const matched = /-?\d+/u.exec(summary);
  if (!matched) return 'neutral';
  return Number(matched[0]) === 0 ? 'succeeded' : 'failed';
}

export function toneOfEvent(type: string, summary = ''): EventTone {
  if (type === 'script.exited') return scriptExitTone(summary);
  return eventTone(type);
}
