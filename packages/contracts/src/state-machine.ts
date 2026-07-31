/**
 * Run / Node 状态机（技术选型 §13）。
 *
 * 引擎按这里推进，UI 按这里渲染徽标与横幅。任何新状态都属于契约变更。
 */

export const RUN_STATUSES = [
  'created',
  'preflight',
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'interrupted',
  'resuming',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const NODE_STATUSES = [
  'idle',
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

const RUN_TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/** 重启后要在运行列表顶部提示「可恢复」的状态。 */
// waiting_approval 不在里面:它要的是审批决定,不是恢复 ——
// 引擎的 resume 明确拒绝它,界面在等审批时摆一个「恢复运行」
// 只会让用户不敢点(第 3 轮实测 P11)
const RUN_RESUMABLE: readonly RunStatus[] = ['paused', 'interrupted'];

/**
 * 允许的 Run 迁移。取消边不写在这里——任何非终态都可取消，由 canTransitionRun 统一补上。
 */
const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ['preflight'],
  // preflight 不通过就直接失败，绝不带着缺失依赖进队列
  preflight: ['queued', 'failed'],
  queued: ['running'],
  running: ['waiting_approval', 'paused', 'interrupted', 'succeeded', 'failed'],
  waiting_approval: ['running', 'paused', 'interrupted', 'failed'],
  paused: ['running', 'interrupted'],
  // 断电 / 杀进程后落在 interrupted，重启读检查点进 resuming
  interrupted: ['resuming'],
  resuming: ['running', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/**
 * 允许的 Node 迁移。failed → queued 是「从失败节点重试」，会产生新 attempt。
 */
const NODE_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  idle: ['queued', 'skipped', 'cancelled'],
  queued: ['running', 'skipped', 'cancelled'],
  // waiting：等审批、等汇聚上游、等用户补充
  running: ['waiting', 'succeeded', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  failed: ['queued'],
  succeeded: [],
  skipped: [],
  cancelled: [],
};

export function isRunTerminal(status: RunStatus): boolean {
  return RUN_TERMINAL.includes(status);
}

export function isRunResumable(status: RunStatus): boolean {
  return RUN_RESUMABLE.includes(status);
}

export function isNodeTerminal(status: NodeStatus): boolean {
  return NODE_TRANSITIONS[status].length === 0;
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (isRunTerminal(from)) return false;
  // 用户永远能叫停一个还没结束的运行
  if (to === 'cancelled') return true;
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

/** 重试计数：首次执行是 attempt 1，之后逐次递增。 */
export function nextAttempt(current: number | undefined): number {
  if (current === undefined) return 1;
  if (!Number.isInteger(current) || current < 1) {
    throw new Error(`attempt 必须是从 1 起的整数，收到 ${current}`);
  }
  return current + 1;
}
