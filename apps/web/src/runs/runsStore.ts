import { create } from 'zustand';
import { LIST_PAGE_SIZE, isRunTerminal, type RunStatus } from '@aiwf/contracts';
import { describeError } from '../data/describeError.js';
import type { Run, RunEvent as ContractRunEvent } from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';

/**
 * 执行记录的数据层。
 *
 * 事件流是唯一事实来源：进度、当前节点、失败原因全部从事件推出来。
 * 另存一份状态就多一处会不一致的地方——而且不一致时界面显示的
 * 与运行记录里写的会对不上，那是最难解释给用户听的一类 bug。
 */

/**
 * 形状**直接取自契约**，不手写一份。
 *
 * 手写的那两份漏了 versionId / draftRev / nodeLabel，于是后端明明发了，
 * TypeScript 却说字段不存在。这类分家已经栽过三次
 * （WorkflowSummary 漏 lastRun、RunSchema 漏 workflowName），
 * 症状一律是「界面上那块永远空着，一条错误都没有」。
 */
export type RunSummary = Run;
export type RunEvent = ContractRunEvent;

/** 图纸左栏的筛选 chips。 */
export type RunFilter = 'all' | 'running' | 'waiting_approval' | 'failed';

/** 「进行中」= 还没结束的：等待审批也算，它只是在等人。 */
/**
 * 活跃 = 非终态。**从契约派生**，不再手写枚举。
 *
 * 手写那份只列了 created/queued/running/waiting_approval，漏掉契约里的
 * preflight / paused / interrupted / resuming —— 杀掉 App 后落在
 * interrupted 的运行于是混进「历史」跟已完成的排一起，既不轮询、
 * 也不显示「取消运行」，而「从失败节点重试」只长在失败横幅上。
 * 那条运行连一个可点的按钮都没有。
 */
const isActiveStatus = (status: string): boolean => !isRunTerminal(status as RunStatus);

/** 每页事件数。与后端的默认 limit 对齐。 */
const EVENT_PAGE_SIZE = 200;

/**
 * 最多翻多少页。
 *
 * 5000 条事件已经远超人能读完的量，而再多就会让界面明显卡顿。
 * 到顶时明确标出来，让用户知道自己看到的不是全部。
 */
const EVENT_PAGE_MAX = 25;

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
  /** 事件太多、翻页到上限了。界面据此提示「还有更多没显示」。 */
  truncated: boolean;
  /**
   * 选中运行所引用的那张图里，每个节点的类型（`nodeId → type`）。
   *
   * 详情面板按类型分发渲染：脚本节点看命令与退出码，AI 节点看对话，
   * worktree 看分支。**类型只有图里有** —— 事件里没有，
   * 靠事件形状去猜会立起第二套真源，加一种节点类型就得改猜法。
   *
   * 取不到时是空表，详情面板退回通用的事件列表 ——
   * 那比一片空白诚实。
   */
  nodeTypes: Record<string, string>;
  /** 满足当前筛选的总条数。分页控件靠它。 */
  total: number;
  offset: number;
  loading: boolean;
  error: string | null;
  filter: RunFilter;
  query: string;

  load: () => Promise<void>;
  select: (runId: string) => Promise<void>;
  loadNodeTypes: (runId: string) => Promise<void>;
  pollEvents: () => Promise<void>;
  setFilter: (filter: RunFilter) => Promise<void>;
  search: (query: string) => Promise<void>;
  setOffset: (offset: number) => Promise<void>;
  setQuery: (query: string) => void;
  cancel: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
  /** 用同样的参数再起一次运行，返回新运行的 id。 */
  rerun: (runId: string) => Promise<string | null>;
  /** 回到最近的审批点重新选择。开的是新运行，原来那条留着。 */
  rewindToApproval: (runId: string) => Promise<string | null>;
  decide: (nodeId: string, decision: string) => Promise<void>;

  grouped: () => { active: RunSummary[]; past: RunSummary[] };
  progress: () => RunProgress;
  selected: () => RunSummary | null;
}

export const useRuns = create<RunsState>((set, get) => ({
  items: [],
  selectedId: null,
  events: [],
  nodeTypes: {},
  nextSeq: 0,
  truncated: false,
  total: 0,
  offset: 0,
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
        limit: LIST_PAGE_SIZE,
        offset: get().offset,
      })) as { items: RunSummary[]; total: number };
      set({ items: result.items, total: result.total, loading: false });
    } catch (error) {
      // 保留已有列表：清空会让用户以为运行记录丢了
      set({ loading: false, error: describeError(error) });
    }
  },

  select: async (runId: string) => {
    // 先清空再拉：留着上一个运行的事件会让用户看到别的运行的记录
    set({
      selectedId: runId,
      events: [],
      nextSeq: 0,
      truncated: false,
      error: null,
      nodeTypes: {},
    });
    await Promise.all([get().pollEvents(), get().loadNodeTypes(runId)]);
  },

  /**
   * 取这次运行引用的那张图，记下每个节点的类型。
   *
   * 拿不到不算错误：运行可能引用的是一个已经被删掉的版本，
   * 而那时事件流本身还是完整的 —— 详情面板退回通用列表就行，
   * 不该因为图读不到就让整页报错。
   */
  loadNodeTypes: async (runId: string) => {
    const run = get().items.find((item) => item.id === runId);
    if (!run?.versionId) return;
    try {
      const result = (await coreClient.call('workflow.versionGraph', {
        versionId: run.versionId,
      })) as { graph: { nodes: { id: string; type: string }[] } };
      const types: Record<string, string> = {};
      for (const node of result.graph.nodes) types[node.id] = node.type;
      // 期间用户可能已经切走了，别把上一条运行的类型盖到新选中的那条上
      if (get().selectedId === runId) set({ nodeTypes: types });
    } catch {
      // 静默：详情面板会退回通用列表
    }
  },

  /**
   * 拉事件，**一页拉不完就接着拉**。
   *
   * 只拉一页的话，217 条事件的运行在界面上永远停在第 200 条 ——
   * 缺的正是「它最后怎么结束的」，而运行记录的价值就在于完整。
   *
   * 上限 EVENT_PAGE_MAX 页：后端如果一直说 hasMore，翻页会变成死循环，
   * 界面卡死而根因在后端。到顶时把 truncated 标出来 ——
   * 静默截断会让用户以为那就是全部。
   */
  pollEvents: async () => {
    const { selectedId } = get();
    if (!selectedId) return;

    try {
      for (let page = 0; page < EVENT_PAGE_MAX; page += 1) {
        const from = get().nextSeq;
        const result = (await coreClient.call('run.events', {
          runId: selectedId,
          fromSeq: from,
          limit: EVENT_PAGE_SIZE,
        })) as { events: RunEvent[]; hasMore?: boolean; nextSeq: number };

        // 一条都没给就停：说 hasMore 却不给新事件是后端的问题，
        // 我们不能因此转圈
        if (result.events.length === 0) return;

        // 按 seq 去重：select() 与轮询可能同时在拉，两者都读到同一个
        // fromSeq 就会把同一批事件追加两次 —— 界面上一条事件出现两遍。
        // seq 在存储层唯一，去重是天然正确的做法
        set((state) => {
          const known = new Set(state.events.map((event) => event.seq));
          const fresh = result.events.filter((event) => !known.has(event.seq));
          if (fresh.length === 0) return state;
          return {
            events: [...state.events, ...fresh].sort((a, b) => a.seq - b.seq),
            nextSeq: Math.max(state.nextSeq, result.nextSeq),
          };
        });

        // 一页都没推进 nextSeq 也停 —— 同样是转不下去的信号
        if (get().nextSeq === from) return;
        if (!result.hasMore) return;
      }

      set({ truncated: true });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  setFilter: async (filter: RunFilter) => {
    // 换条件时回到第一页：停在第 5 页的话，筛完可能一条都没有，
    // 而用户以为是「没有失败的运行」
    set({ filter, offset: 0 });
    await get().load();
  },

  setQuery: (query: string) => set({ query }),

  /** 搜索。同样回到第一页。 */
  search: async (query: string) => {
    set({ query, offset: 0 });
    await get().load();
  },

  setOffset: async (offset: number) => {
    set({ offset: Math.max(0, offset) });
    await get().load();
  },

  cancel: async (runId: string) => {
    try {
      await coreClient.call('run.cancel', { runId });
    } catch (error) {
      set({ error: describeError(error) });
    }
    await get().load();
  },

  resume: async (runId: string) => {
    try {
      await coreClient.call('run.resume', { runId });
    } catch (error) {
      set({ error: describeError(error) });
    }
    await get().load();
  },

  /**
   * 用相同参数重跑。
   *
   * 这是一次**全新的运行**，不动原来那条 —— 两次的事件流可以对照着看，
   * 而这正是可解释性要的：「上次哪里不一样」得有个参照物。
   */
  rerun: async (runId: string) => {
    const run = get().items.find((item) => item.id === runId);
    if (!run) return null;

    try {
      const result = (await coreClient.call('run.start', {
        workflowId: run.workflowId,
        // 沿用原运行的版本：不带的话会跑当前草稿，
        // 而草稿可能已经改过 —— 那就不是「相同参数」重跑了
        // rev 0 不存在 —— 兜底成 0 曾让重跑必失败(P3)。两个都缺就直说
        ...(run.versionId
          ? { versionId: run.versionId }
          : typeof run.draftRev === 'number'
            ? { draftRev: run.draftRev }
            : null),
        inputs: run.inputs ?? {},
      })) as { runId: string };
      await get().load();
      await get().select(result.runId);
      return result.runId;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  /**
   * 回到最近的审批点重新选择 —— 图纸失败横幅的第二个按钮。
   *
   * 用户在审批那一步选错了（批准了一个不该批的 Diff），后面才发现。
   * 「从失败节点重试」沿用同一个决定继续往下；「用相同参数重跑」
   * 又把前面几十分钟的工作全丢掉。
   */
  rewindToApproval: async (runId: string) => {
    try {
      const result = (await coreClient.call('run.rewindToApproval', { runId })) as {
        runId: string;
      };
      await get().load();
      await get().select(result.runId);
      return result.runId;
    } catch (error) {
      set({ error: describeError(error) });
      return null;
    }
  },

  decide: async (nodeId: string, decision: string) => {
    const { selectedId } = get();
    if (!selectedId) return;
    try {
      await coreClient.call('approval.decide', { runId: selectedId, nodeId, decision });
    } catch (error) {
      set({ error: describeError(error) });
      return;
    }
    await get().pollEvents();
    await get().load();
  },

  grouped: () => {
    const { items } = get();
    return {
      active: items.filter((run) => isActiveStatus(run.status)),
      past: items.filter((run) => !isActiveStatus(run.status)),
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
