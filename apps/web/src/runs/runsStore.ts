import { create } from 'zustand';
import { coreClient } from '../data/workspace.js';

/**
 * 执行记录的数据层。
 *
 * 事件流是唯一事实来源：进度、当前节点、失败原因全部从事件推出来。
 * 另存一份状态就多一处会不一致的地方——而且不一致时界面显示的
 * 与运行记录里写的会对不上，那是最难解释给用户听的一类 bug。
 */

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  inputs: Record<string, unknown>;
  currentNode?: string;
  workdir?: string;
  startedAt?: string;
  endedAt?: string;
}

/** 字段名跟着契约的 RunEventSchema 走，不另起一套。 */
export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: string;
  nodeId?: string;
  attempt?: number;
  actor: string;
  summary: string;
  payloadRef?: string;
  sensitivity: string;
  schemaVer: number;
}

/** 图纸左栏的筛选 chips。 */
export type RunFilter = 'all' | 'running' | 'waiting_approval' | 'failed';

/** 「进行中」= 还没结束的：等待审批也算，它只是在等人。 */
const ACTIVE_STATUSES = new Set(['created', 'queued', 'running', 'waiting_approval']);

const FILTER_STATUSES: Record<RunFilter, string[]> = {
  all: [],
  running: ['running'],
  waiting_approval: ['waiting_approval'],
  failed: ['failed'],
};

export interface RunProgress {
  done: number;
  current: string | null;
  failed: string | null;
}

interface RunsState {
  items: RunSummary[];
  selectedId: string | null;
  events: RunEvent[];
  /** 增量拉取的游标。 */
  nextSeq: number;
  loading: boolean;
  error: string | null;
  filter: RunFilter;
  query: string;

  load: () => Promise<void>;
  select: (runId: string) => Promise<void>;
  pollEvents: () => Promise<void>;
  setFilter: (filter: RunFilter) => Promise<void>;
  setQuery: (query: string) => void;
  cancel: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
  decide: (nodeId: string, decision: string) => Promise<void>;

  grouped: () => { active: RunSummary[]; past: RunSummary[] };
  progress: () => RunProgress;
  selected: () => RunSummary | null;
}

export const useRuns = create<RunsState>((set, get) => ({
  items: [],
  selectedId: null,
  events: [],
  nextSeq: 0,
  loading: false,
  error: null,
  filter: 'all',
  query: '',

  load: async () => {
    set({ loading: true, error: null });
    const { filter, query } = get();
    const statuses = FILTER_STATUSES[filter];
    try {
      // 筛选与搜索都交给后端：前端过滤只能过滤已加载的那一页，
      // 用户搜三个月前的运行会搜不到
      const result = (await coreClient.call('run.list', {
        ...(statuses.length > 0 ? { status: statuses } : {}),
        ...(query ? { query } : {}),
      })) as { items: RunSummary[] };
      set({ items: result.items, loading: false });
    } catch (error) {
      // 保留已有列表：清空会让用户以为运行记录丢了
      set({ loading: false, error: describe(error) });
    }
  },

  select: async (runId: string) => {
    // 先清空再拉：留着上一个运行的事件会让用户看到别的运行的记录
    set({ selectedId: runId, events: [], nextSeq: 0, error: null });
    await get().pollEvents();
  },

  pollEvents: async () => {
    const { selectedId, nextSeq } = get();
    if (!selectedId) return;
    try {
      const page = (await coreClient.call('run.events', {
        runId: selectedId,
        fromSeq: nextSeq,
        limit: 200,
      })) as { events: RunEvent[]; nextSeq: number };

      if (page.events.length === 0) return;

      // 按 seq 去重：select() 与轮询可能同时在拉，两者都读到同一个
      // fromSeq 就会把同一批事件追加两次 —— 界面上一条事件出现两遍。
      // seq 在存储层唯一，去重是天然正确的做法
      set((state) => {
        const known = new Set(state.events.map((event) => event.seq));
        const fresh = page.events.filter((event) => !known.has(event.seq));
        if (fresh.length === 0) return state;
        return {
          events: [...state.events, ...fresh].sort((a, b) => a.seq - b.seq),
          nextSeq: Math.max(state.nextSeq, page.nextSeq),
        };
      });
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  setFilter: async (filter: RunFilter) => {
    set({ filter });
    await get().load();
  },

  setQuery: (query: string) => set({ query }),

  cancel: async (runId: string) => {
    try {
      await coreClient.call('run.cancel', { runId });
    } catch (error) {
      set({ error: describe(error) });
    }
    await get().load();
  },

  resume: async (runId: string) => {
    try {
      await coreClient.call('run.resume', { runId });
    } catch (error) {
      set({ error: describe(error) });
    }
    await get().load();
  },

  decide: async (nodeId: string, decision: string) => {
    const { selectedId } = get();
    if (!selectedId) return;
    try {
      await coreClient.call('approval.decide', { runId: selectedId, nodeId, decision });
    } catch (error) {
      set({ error: describe(error) });
      return;
    }
    await get().pollEvents();
    await get().load();
  },

  grouped: () => {
    const { items } = get();
    return {
      active: items.filter((run) => ACTIVE_STATUSES.has(run.status)),
      past: items.filter((run) => !ACTIVE_STATUSES.has(run.status)),
    };
  },

  progress: () => {
    const { events } = get();
    const succeeded = new Set<string>();
    const failed = new Set<string>();
    let current: string | null = null;

    for (const event of events) {
      if (!event.nodeId) continue;
      switch (event.type) {
        case 'node.started':
          current = event.nodeId;
          break;
        case 'node.succeeded':
          succeeded.add(event.nodeId);
          // 重试成功后就不再算失败
          failed.delete(event.nodeId);
          break;
        case 'node.failed':
          failed.add(event.nodeId);
          break;
        default:
          break;
      }
    }

    return {
      done: succeeded.size,
      current,
      failed: [...failed][0] ?? null,
    };
  },

  selected: () => {
    const { items, selectedId } = get();
    return items.find((run) => run.id === selectedId) ?? null;
  },
}));

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
