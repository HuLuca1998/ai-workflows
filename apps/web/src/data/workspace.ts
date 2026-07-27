import { create } from 'zustand';
import { applyPatch, type PatchOperation, type WorkflowGraph } from '@aiwf/contracts';
import { CoreApiClient, MemoryTransport, type Transport } from '@aiwf/client-core';
import { isDesktopRuntime } from '../updater/useAppVersion.js';
import { createTauriTransport } from './ipc.js';

/**
 * 工作区数据。
 *
 * 桌面形态走 Tauri IPC 拿真实数据；Web 形态在 M6 接远程引擎之前用内存传输，
 * 这样界面在两端都能跑，而**不引入假数据冒充真实状态**——
 * 空库就显示空态，与产品原则「可解释优先」一致。
 */

export interface WorkflowSummary {
  id: string;
  name: string;
  folder?: string;
  updatedAt: string;
}

function createTransport(): Transport {
  if (isDesktopRuntime()) {
    return createTauriTransport(async (command, args) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke(command, args);
    });
  }
  // Web 形态在 M6 接远程引擎之前只有空数据：空库就显示空态，不塞演示内容
  return new MemoryTransport({
    'workflow.list': () => ({ items: [] }),
    'workflow.create': () => ({ id: 'wf_web_demo', rev: 0 }),
  });
}

export const coreClient = new CoreApiClient(createTransport());

interface WorkspaceState {
  workflows: WorkflowSummary[];
  loading: boolean;
  error: string | null;
  /** 概览页统计条。M0 只有工作流数是真的，其余等引擎接上。 */
  stats: {
    waitingApproval: number;
    runsToday: number;
    runsSucceeded: number;
    activeWorktrees: number;
  };
  load: () => Promise<void>;
  /**
   * 新建工作流。给了 operations 就在建完后立刻应用（模板）。
   * 模板走的是与手工搭建完全相同的 patch 路径，因此同样被校验守住。
   * 返回新建的工作流 id，便于直接跳进编辑器。
   */
  createWorkflow: (name: string, operations?: readonly PatchOperation[]) => Promise<string | null>;
  /** 导入一份已校验过的图，作为新工作流的第一个修订。 */
  importWorkflow: (name: string, graph: WorkflowGraph) => Promise<string | null>;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workflows: [],
  loading: false,
  error: null,
  stats: { waitingApproval: 0, runsToday: 0, runsSucceeded: 0, activeWorktrees: 0 },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result = (await coreClient.call('workflow.list', {})) as {
        items: { id: string; name: string; folder?: string; updatedAt: string }[];
      };
      set({
        workflows: result.items.map((w) => ({
          id: w.id,
          name: w.name,
          ...(w.folder === undefined ? {} : { folder: w.folder }),
          updatedAt: w.updatedAt,
        })),
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  importWorkflow: async (name: string, graph: WorkflowGraph) => {
    // 导入没有「相对于什么的改动」，所以直接带初始图创建，
    // 而不是拿一条假 Patch 去凑 operations
    const result = (await coreClient.call('workflow.create', {
      name,
      graphJson: JSON.stringify(graph),
    })) as { id: string };
    await get().load();
    return result.id ?? null;
  },

  createWorkflow: async (name: string, operations?: readonly PatchOperation[]) => {
    // 模板先在本地跑一遍 applyPatch——它因此被同一套校验守住，
    // 再把结果图作为初始图创建
    const graphJson =
      operations && operations.length > 0
        ? JSON.stringify(
            applyPatch({ nodes: [], edges: [], groups: [] }, 0, {
              baseRevision: 0,
              operations: [...operations],
            }).graph,
          )
        : undefined;

    const result = (await coreClient.call('workflow.create', {
      name,
      ...(graphJson ? { graphJson } : {}),
    })) as { id: string };
    await get().load();
    return result.id ?? null;
  },
}));
