import { create } from 'zustand';

/** 列表一页多少条。与契约的 LIST_PAGE_SIZE 一致。 */
const LIST_PAGE_SIZE = 50;
import {
  applyPatch,
  type PatchOperation,
  type Workflow,
  type WorkflowGraph,
} from '@aiwf/contracts';
import {
  CoreApiClient,
  MemoryTransport,
  createTauriTransport,
  type Transport,
} from '@aiwf/client-core';
import { isDesktopRuntime } from '../updater/useAppVersion.js';

import { createHttpTransport } from './httpTransport.js';

/**
 * 工作区数据。
 *
 * 桌面形态走 Tauri IPC 拿真实数据；Web 形态在 M6 接远程引擎之前用内存传输，
 * 这样界面在两端都能跑，而**不引入假数据冒充真实状态**——
 * 空库就显示空态，与产品原则「可解释优先」一致。
 */

/**
 * 列表行的形状**直接取自契约**，不再手写一份。
 *
 * 手写的那份漏了 latestVersion 与 lastRun，于是后端明明发了运行态投影，
 * TypeScript 却说这两个字段不存在 —— 而运行时它们确实在。
 * 类型与契约分家的代价就是这个。
 */
export type WorkflowSummary = Workflow;

function createTransport(): Transport {
  if (isDesktopRuntime()) {
    return createTauriTransport(async (command, args) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke(command, args);
    });
  }

  // 开发时把 VITE_AIWF_SERVER 指向 aiwf-devserver，浏览器就连上真实引擎。
  // 这条路径存在的理由是测试：桌面壳的 WKWebView 没法用浏览器工具驱动，
  // 而「点下去引擎真的动了」必须能被自动化验证
  const server = import.meta.env.VITE_AIWF_SERVER as string | undefined;
  if (server) return createHttpTransport(server);

  // 没配服务端时只有空数据：空库就显示空态，不塞演示内容
  return new MemoryTransport({
    'workflow.list': () => ({ items: [] }),
    'workflow.create': () => ({ id: 'wf_web_demo', rev: 0 }),
  });
}

export const coreClient = new CoreApiClient(createTransport());

interface WorkspaceState {
  workflows: WorkflowSummary[];
  /** 满足条件的总条数。分页控件靠它。 */
  total: number;
  offset: number;
  loading: boolean;
  error: string | null;
  /** 概览页统计条。M0 只有工作流数是真的，其余等引擎接上。 */
  stats: {
    waitingApproval: number;
    runsToday: number;
    runsSucceeded: number;
    activeWorktrees: number;
  };
  load: (offset?: number) => Promise<void>;
  /** 筛选与搜索都在后端做 —— 前端过滤只能过滤当前页。 */
  setFilter: (status: string | null, query: string) => Promise<void>;
  status: string | null;
  query: string;
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
  total: 0,
  offset: 0,
  status: null,
  query: '',
  loading: false,
  error: null,
  stats: { waitingApproval: 0, runsToday: 0, runsSucceeded: 0, activeWorktrees: 0 },

  setFilter: async (status: string | null, query: string) => {
    // 换条件时回到第一页：停在第 29 页的话，筛完可能一条都没有，
    // 而用户以为是「没有失败的工作流」
    set({ status, query, offset: 0 });
    await get().load(0);
  },

  load: async (offset?: number) => {
    const next = offset ?? get().offset;
    set({ loading: true, error: null, offset: next });
    try {
      // 原样收下：coreClient 已经拿契约校验过一遍，
      // 在这里再挑一遍字段只会把新增的（latestVersion、lastRun）漏掉 ——
      // 而那种漏法不报错，只是界面上永远没有那些信息
      const { status, query } = get();
      const result = (await coreClient.call('workflow.list', {
        ...(status ? { status } : {}),
        ...(query ? { query } : {}),
        limit: LIST_PAGE_SIZE,
        offset: next,
      })) as { items: WorkflowSummary[]; total: number };
      set({ workflows: result.items, total: result.total, loading: false });
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
