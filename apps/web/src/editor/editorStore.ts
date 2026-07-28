import { create } from 'zustand';
import { describeError } from '../data/describeError.js';
import {
  DraftStore,
  type PatchOperation,
  type ValidationResult,
  type WorkflowGraph,
  validateGraph,
} from './editorDeps.js';
import { coreClient } from '../data/workspace.js';

/**
 * 编辑器状态。
 *
 * 草稿本身交给 DraftStore（乐观编辑 + 冲突回滚 + AI 提议先出 Diff），
 * 这里只管「界面需要知道的东西」：加载状态、选中、校验结果、保存进度。
 *
 * 保存是显式的（工具栏没有自动保存的位置）：编辑先落在本地草稿，
 * 用户点保存或触发发布时才提交。这与「草稿与执行分离」一致——
 * 本地怎么改都不影响已发布版本。
 */

export interface VersionSummary {
  id: string;
  version: number;
  configHash: string;
  publishedAt: string;
  publishedBy: string;
}

interface EditorState {
  workflowId: string | null;
  name: string;
  /** 服务端已确认的草稿修订号。 */
  rev: number;
  graph: WorkflowGraph;
  versions: VersionSummary[];
  validation: ValidationResult;
  selection: string[];
  loading: boolean;
  saving: boolean;
  /** 有未提交的本地改动。 */
  dirty: boolean;
  error: string | null;

  load: (workflowId: string) => Promise<void>;
  apply: (operations: PatchOperation[]) => void;
  save: () => Promise<void>;
  publish: () => Promise<number | null>;
  /** 读某个已发布版本的图（版本抽屉对比与回滚用）。 */
  loadVersionGraph: (versionId: string) => Promise<WorkflowGraph>;
  /** 把某个版本回填成新的草稿修订。原草稿仍在历史里，不会丢。 */
  rollbackTo: (versionId: string) => Promise<void>;
  /** 给工作流改名。名字是用户识别它的唯一线索。 */
  rename: (name: string) => Promise<void>;
  /** 放弃本地未提交的改动，回到服务端那份图。冲突后用户主动脱身的出路。 */
  discardLocal: () => void;
  setSelection: (ids: string[]) => void;
  clear: () => void;
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [], groups: [] };

/** DraftStore 不是状态的一部分（它带订阅与可变图），单独持有。 */
let draft: DraftStore | null = null;
let unsubscribeDraft: (() => void) | null = null;

export const useEditor = create<EditorState>((set, get) => ({
  workflowId: null,
  name: '',
  rev: 0,
  graph: EMPTY_GRAPH,
  versions: [],
  validation: { ok: true, issues: [] },
  selection: [],
  loading: false,
  saving: false,
  dirty: false,
  error: null,

  load: async (workflowId: string) => {
    set({ loading: true, error: null, workflowId });
    try {
      const result = (await coreClient.call('workflow.get', { id: workflowId })) as {
        workflow: { name: string };
        graph: WorkflowGraph;
        rev: number;
        versions: VersionSummary[];
      };

      unsubscribeDraft?.();
      draft = new DraftStore(coreClient, workflowId, { graph: result.graph, rev: result.rev });
      // 草稿变了就把新图与脏标记同步到界面
      unsubscribeDraft = draft.subscribe(() => {
        const current = draft;
        if (!current) return;
        set({
          graph: current.graph,
          rev: current.rev,
          dirty: current.isDirty,
          validation: validateGraph(current.graph),
        });
      });

      set({
        name: result.workflow.name,
        graph: result.graph,
        rev: result.rev,
        versions: result.versions,
        validation: validateGraph(result.graph),
        selection: [],
        dirty: false,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: describeError(error) });
    }
  },

  apply: (operations: PatchOperation[]) => {
    if (!draft) return;
    try {
      draft.apply(operations);
    } catch (error) {
      // 非法操作不改草稿，把原因显示出来而不是静默丢弃
      set({ error: describeError(error) });
    }
  },

  save: async () => {
    if (!draft || !draft.isDirty) return;
    set({ saving: true, error: null });
    try {
      await draft.commit();
      set({ saving: false, rev: draft.rev, dirty: false });
    } catch (error) {
      // 失败后 DraftStore 保留着本地改动（见它的 commit）。把真实状态
      // 同步回界面：dirty 仍是 true，按钮显示「保存草稿」，用户能重试
      set({
        saving: false,
        graph: draft.graph,
        dirty: draft.isDirty,
        error: describeError(error),
      });
    }
  },

  publish: async () => {
    const { workflowId, dirty } = get();
    if (!workflowId) return null;
    if (dirty) {
      // 发布的是已落库的修订，未保存的改动不在其中——先说清楚再让用户决定
      set({ error: '有未保存的改动。请先保存草稿，再发布版本。' });
      return null;
    }
    set({ saving: true, error: null });
    try {
      const result = (await coreClient.call('workflow.publish', {
        id: workflowId,
        rev: get().rev,
      })) as { version: number };
      await get().load(workflowId);
      set({ saving: false });
      return result.version;
    } catch (error) {
      set({ saving: false, error: describeError(error) });
      return null;
    }
  },

  loadVersionGraph: async (versionId: string) => {
    const result = (await coreClient.call('workflow.versionGraph', { versionId })) as {
      graph: WorkflowGraph;
    };
    return result.graph;
  },

  rollbackTo: async (versionId: string) => {
    const { workflowId } = get();
    if (!workflowId) return;
    set({ saving: true, error: null });
    try {
      // 回滚不是「撤销」：旧图作为一个**新的**草稿修订写进去，
      // 原草稿仍留在修订历史里，随时能再回来
      await coreClient.call('workflow.rollback', { id: workflowId, versionId });
      await get().load(workflowId);
      set({ saving: false });
    } catch (error) {
      set({ saving: false, error: describeError(error) });
    }
  },

  rename: async (name: string) => {
    const { workflowId } = get();
    if (!workflowId) return;
    // 先落库再改本地：反过来的话失败时界面显示的是一个没存上的名字
    try {
      await coreClient.call('workflow.rename', { id: workflowId, name });
      set({ name });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  discardLocal: () => {
    if (!draft) return;
    draft.discardLocal();
    // 订阅会把图与 dirty 同步回来，这里只清掉那条已经不成立的报错
    set({ error: null });
  },

  setSelection: (ids: string[]) => set({ selection: ids }),

  /**
   * 离开编辑器。
   *
   * **不在这里自动丢空草稿**。试过，代价太大：effect 的 cleanup 分不出
   * 「切换工作流」与「真的离开」，而 React 的双次挂载会让它在用户
   * 刚新建、还没来得及做任何事时就触发 —— 实测的请求序列是
   * `create → discard_if_empty → save_draft`，用户刚拖的节点保存到了
   * 一个已经被删掉的工作流上。
   *
   * 少几条垃圾草稿配不上误删用户正在做的东西的风险。
   * 清理改成概览页的显式入口（workflow.discardIfEmpty 仍然可用）。
   */
  clear: () => {
    unsubscribeDraft?.();
    unsubscribeDraft = null;
    draft = null;
    set({
      workflowId: null,
      name: '',
      rev: 0,
      graph: EMPTY_GRAPH,
      versions: [],
      validation: { ok: true, issues: [] },
      selection: [],
      dirty: false,
      error: null,
    });
  },
}));

/** 测试用：直接注入一份草稿，跳过 IPC。 */
export function __setDraftForTest(next: DraftStore | null): void {
  unsubscribeDraft?.();
  draft = next;
  unsubscribeDraft = next
    ? next.subscribe(() => {
        useEditor.setState({
          graph: next.graph,
          rev: next.rev,
          dirty: next.isDirty,
          validation: validateGraph(next.graph),
        });
      })
    : null;
}
