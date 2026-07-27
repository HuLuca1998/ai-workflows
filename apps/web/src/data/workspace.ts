import { create } from 'zustand';
import { CoreApiClient, MemoryTransport, type Transport } from '@aiwf/client-core';
import { isDesktopRuntime } from '../updater/useAppVersion.js';

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

/** Core API 方法名 → Tauri IPC 命令名。M0 只接通了这两条。 */
const IPC_COMMANDS: Record<string, string> = {
  'workflow.list': 'workflow_list',
  'workflow.create': 'workflow_create',
};

/** 桌面形态的传输实现。 */
function createTauriTransport(): Transport {
  return {
    async call(method, input) {
      const command = IPC_COMMANDS[method];
      if (!command) {
        throw { code: 'INTERNAL', message: `${method} 在 M0 尚未接通引擎（见 docs/ROADMAP.md）` };
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke(command, (input ?? {}) as Record<string, unknown>);
      // IPC 返回 snake_case，契约用 camelCase
      if (method === 'workflow.list') {
        const rows = raw as { id: string; name: string; folder?: string; updated_at: string }[];
        return {
          items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            folder: r.folder ?? undefined,
            createdAt: r.updated_at,
            updatedAt: r.updated_at,
            archived: false,
          })),
        };
      }
      if (method === 'workflow.create') return { id: raw as string, rev: 0 };
      return raw;
    },
    subscribeEvents() {
      // 事件流在 M2 接上
      return () => {};
    },
  };
}

function createTransport(): Transport {
  if (isDesktopRuntime()) return createTauriTransport();
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
