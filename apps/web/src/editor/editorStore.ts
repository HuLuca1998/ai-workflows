import { create } from 'zustand';
import {
  CoreApiError,
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
      set({ loading: false, error: describe(error) });
    }
  },

  apply: (operations: PatchOperation[]) => {
    if (!draft) return;
    try {
      draft.apply(operations);
    } catch (error) {
      // 非法操作不改草稿，把原因显示出来而不是静默丢弃
      set({ error: describe(error) });
    }
  },

  save: async () => {
    if (!draft || !draft.isDirty) return;
    set({ saving: true, error: null });
    try {
      await draft.commit();
      set({ saving: false, rev: draft.rev, dirty: false });
    } catch (error) {
      // 冲突时 DraftStore 已把本地图回滚，这里同步回界面
      set({
        saving: false,
        graph: draft.graph,
        dirty: draft.isDirty,
        error: describe(error),
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
      set({ saving: false, error: describe(error) });
      return null;
    }
  },

  setSelection: (ids: string[]) => set({ selection: ids }),

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

function describe(error: unknown): string {
  if (error instanceof CoreApiError) {
    return error.hint ? `${error.message}（${error.hint}）` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

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
