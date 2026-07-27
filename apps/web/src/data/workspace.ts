import { create } from 'zustand';
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
  createWorkflow: (name: string) => Promise<void>;
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

  createWorkflow: async (name: string) => {
    await coreClient.call('workflow.create', { name });
    await get().load();
  },
}));
