import {
  categoryOfEventType,
  type NodeStatus,
  type RunEvent,
  type RunEventCategory,
  type RunStatus,
} from '@aiwf/contracts';

/**
 * 事件存储与投影。
 *
 * 对话、事件、产物、节点进度、运行状态——全部由这一条流派生。
 * 任何界面都不得自行查库或从消息文本里拼状态（功能文档 §1、§14）。
 */

export interface ConversationItem {
  seq: number;
  type: RunEvent['type'];
  actor: RunEvent['actor'];
  summary: string;
  ts: string;
  nodeId?: string;
}

export interface ArtifactEntry {
  seq: number;
  label: string;
  refs: string[];
}

export interface NodeProgress {
  nodeId: string;
  status: NodeStatus;
  attempt: number;
  startedAt?: string;
  endedAt?: string;
}

export interface Provenance {
  models: string[];
  prompts: string[];
  memories: string[];
  approvals: { seq: number; actor: string; summary: string }[];
}

/** 对话时间线收哪些事件：面向理解，不含逐行日志。 */
const CONVERSATION_TYPES = new Set<RunEvent['type']>([
  'conversation.user_message',
  'conversation.agent_message',
  'reasoning.summary',
  'tool.call_finished',
  'tool.call_failed',
  'approval.requested',
  'approval.decided',
  'node.failed',
  'run.failed',
  'run.succeeded',
]);

/** 节点事件 → 节点状态。 */
const NODE_EVENT_STATUS: Partial<Record<RunEvent['type'], NodeStatus>> = {
  'node.queued': 'queued',
  'node.started': 'running',
  'node.waiting': 'waiting',
  'node.retried': 'queued',
  'node.succeeded': 'succeeded',
  'node.failed': 'failed',
  'node.skipped': 'skipped',
  'node.cancelled': 'cancelled',
  // 审批把节点挂起：节点列表要显示 waiting，而不是停在 running 上让人猜
  'approval.requested': 'waiting',
  'approval.decided': 'running',
  'approval.expired': 'failed',
};

/** 运行事件 → 运行状态。 */
const RUN_EVENT_STATUS: Partial<Record<RunEvent['type'], RunStatus>> = {
  'run.created': 'created',
  'run.preflight_passed': 'preflight',
  'run.preflight_failed': 'failed',
  'run.queued': 'queued',
  'run.started': 'running',
  'run.paused': 'paused',
  'run.resumed': 'running',
  'run.interrupted': 'interrupted',
  'run.cancelled': 'cancelled',
  'run.succeeded': 'succeeded',
  'run.failed': 'failed',
};

export class EventStore {
  readonly runId: string;
  /** seq → 事件。用 Map 天然去重，重连重发不会产生副本。 */
  private readonly events = new Map<number, RunEvent>();
  private listeners = new Set<() => void>();
  private cachedSorted: RunEvent[] | null = null;

  constructor(runId: string) {
    this.runId = runId;
  }

  /** 摄入一批事件。幂等；只有真的有新事件时才通知订阅者。 */
  ingest(incoming: readonly RunEvent[]): void {
    let changed = false;
    for (const event of incoming) {
      // 并行运行很常见，混流会让所有投影失真
      if (event.runId !== this.runId) continue;
      if (this.events.has(event.seq)) continue;
      this.events.set(event.seq, event);
      changed = true;
    }
    if (!changed) return;
    this.cachedSorted = null;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  all(): RunEvent[] {
    if (!this.cachedSorted) {
      this.cachedSorted = [...this.events.values()].sort((a, b) => a.seq - b.seq);
    }
    return this.cachedSorted;
  }

  /** 下次拉取的游标：已知的最大 seq。 */
  nextSeq(): number {
    const all = this.all();
    return all.length === 0 ? 0 : (all.at(-1)?.seq ?? 0);
  }

  /**
   * 已知事件里的空洞。恢复与重连后用它决定要回补哪些区间——
   * 装作完整会让「现在跑到哪」这个问题答错。
   */
  gaps(): { from: number; to: number }[] {
    const all = this.all();
    const result: { from: number; to: number }[] = [];
    for (let i = 1; i < all.length; i++) {
      const previous = all[i - 1]!.seq;
      const current = all[i]!.seq;
      if (current > previous + 1) {
        result.push({ from: previous + 1, to: current - 1 });
      }
    }
    return result;
  }

  byCategory(categories?: readonly RunEventCategory[]): RunEvent[] {
    if (!categories || categories.length === 0) return this.all();
    const wanted = new Set(categories);
    return this.all().filter((e) => wanted.has(categoryOfEventType(e.type)));
  }

  conversation(): ConversationItem[] {
    return this.all()
      .filter((e) => CONVERSATION_TYPES.has(e.type))
      .map((e) => ({
        seq: e.seq,
        type: e.type,
        actor: e.actor,
        summary: e.summary,
        ts: e.ts,
        ...(e.nodeId === undefined ? {} : { nodeId: e.nodeId }),
      }));
  }

  artifacts(): ArtifactEntry[] {
    return this.all()
      .filter((e) => e.type === 'artifact.created')
      .map((e) => ({ seq: e.seq, label: e.summary, refs: e.artifactRefs ?? [] }));
  }

  /** 每个节点只保留最新一轮的状态：重试后不该还显示上一轮。 */
  nodeProgress(): NodeProgress[] {
    const byNode = new Map<string, NodeProgress>();
    for (const event of this.all()) {
      const status = NODE_EVENT_STATUS[event.type];
      if (!status || !event.nodeId) continue;
      const attempt = event.attempt ?? 1;
      const current = byNode.get(event.nodeId);
      if (current && attempt < current.attempt) continue;

      byNode.set(event.nodeId, {
        nodeId: event.nodeId,
        status,
        attempt,
        ...(event.type === 'node.started' ? { startedAt: event.ts } : {}),
        ...(status === 'succeeded' || status === 'failed' || status === 'cancelled'
          ? { endedAt: event.ts }
          : {}),
      });
    }
    return [...byNode.values()];
  }

  /** 运行状态：取最后一条能定状态的事件；审批等待由节点事件推出。 */
  runStatus(): RunStatus {
    let status: RunStatus = 'created';
    for (const event of this.all()) {
      const mapped = RUN_EVENT_STATUS[event.type];
      if (mapped) {
        status = mapped;
        continue;
      }
      if (event.type === 'approval.requested') status = 'waiting_approval';
      if (event.type === 'approval.decided' && status === 'waiting_approval') status = 'running';
    }
    return status;
  }

  /**
   * 可解释性证据。验收标准要求任何运行都能回答：
   * 用了哪个版本、哪些提示词版本、哪个模型、注入了哪些记忆、谁批准了什么。
   */
  provenance(): Provenance {
    const trace: Provenance = { models: [], prompts: [], memories: [], approvals: [] };
    for (const event of this.all()) {
      switch (event.type) {
        case 'system.model_resolved':
        case 'system.model_downgraded':
          trace.models.push(event.summary);
          break;
        case 'system.prompt_resolved':
          trace.prompts.push(event.summary);
          break;
        case 'system.memory_injected':
          trace.memories.push(event.summary);
          break;
        case 'approval.decided':
          trace.approvals.push({ seq: event.seq, actor: event.actor, summary: event.summary });
          break;
        default:
          break;
      }
    }
    return trace;
  }
}
