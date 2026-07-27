import { CoreApiError, ERROR_CODES, type CoreApiMethod, type ErrorCode } from '@aiwf/contracts';
import type { Transport } from './transport.js';

/**
 * Core API 方法 ↔ 引擎侧命令的转换层。
 *
 * 契约用点号方法名与 camelCase，Rust 侧用 snake_case，两边形状不同。
 * 转换逻辑单独放在这里而不是散在调用点，是因为字段名写错的症状是
 * 「数据莫名为空」而不是报错——必须能单测。
 *
 * 它在 client-core 而不是某个界面里，是因为**不止一个消费者**：
 * 桌面壳走 Tauri IPC、Web 走 HTTP 桥接、MCP Server 也走同一个桥接。
 * 各写一份的话，第二个消费者接上时才会发现「返回值不合契约」——
 * 而那正是 MCP 接进来时踩到的。
 */

/** 已接通引擎的方法。没列在这里的方法调用时会明确报未实现。 */
const COMMANDS: Partial<Record<CoreApiMethod, string>> = {
  'workflow.list': 'workflow_list',
  'workspace.stats': 'workspace_stats',
  'run.artifactContent': 'run_artifact_content',
  'workflow.get': 'workflow_get',
  'workflow.create': 'workflow_create',
  // patch 的结构化操作在客户端应用并生成 Diff（contracts 的 applyPatch），
  // 落库写整份图 + baseRevision 守卫，见 crates/store 的 save_draft_guarded
  'workflow.patch': 'workflow_save_draft',
  'workflow.versionGraph': 'workflow_version_graph',
  'workflow.rollback': 'workflow_rollback',
  'workflow.publish': 'workflow_publish',
  'workflow.rename': 'workflow_rename',
  'workflow.delete': 'workflow_delete',
  'run.start': 'run_start',
  'run.dryRun': 'run_dry_run',
  'run.list': 'run_list',
  'run.get': 'run_get',
  'run.events': 'run_events',
  'run.artifacts': 'run_artifacts',
  'run.cancel': 'run_cancel',
  'run.resume': 'run_resume',
  'approval.decide': 'approval_decide',
  'supervisor.ask': 'supervisor_ask',
  'memory.list': 'memory_list',
  'memory.create': 'memory_create',
  'memory.update': 'memory_update',
  'memory.toggle': 'memory_toggle',
  'memory.delete': 'memory_delete',
  'prompt.list': 'prompt_list',
  'prompt.create': 'prompt_create',
  'prompt.update': 'prompt_update',
  'prompt.duplicate': 'prompt_duplicate',
  'prompt.delete': 'prompt_delete',
  'agent.list': 'agent_list',
  'agent.create': 'agent_create',
  'agent.update': 'agent_update',
  'agent.duplicate': 'agent_duplicate',
  'agent.delete': 'agent_delete',
  'model.list': 'model_list',
  'model.create': 'model_create',
  'model.update': 'model_update',
  'model.delete': 'model_delete',
};

export function ipcCommandFor(method: CoreApiMethod): string | null {
  return COMMANDS[method] ?? null;
}

export function toIpcInput(method: CoreApiMethod, input: unknown): Record<string, unknown> {
  const record = (input ?? {}) as Record<string, unknown>;

  if (method === 'workflow.create') {
    // Rust 侧参数是 snake_case
    return {
      name: record.name,
      ...(record.graphJson ? { graphJson: record.graphJson } : {}),
    };
  }

  if (method === 'workflow.rollback') {
    return { id: record.id, versionId: record.versionId };
  }

  if (method === 'workflow.patch') {
    const graphJson = record.graphJson;
    if (typeof graphJson !== 'string' || graphJson.length === 0) {
      // 静默发一个空图会把用户的工作流清掉，这里必须硬失败
      throw new CoreApiError({
        code: 'INTERNAL',
        message: 'workflow.patch 缺少 graphJson：调用方要先在客户端应用 Patch 再提交',
      });
    }
    return { id: record.id, baseRev: record.baseRevision, graphJson };
  }

  if (method === 'run.start') {
    // Rust 侧收 JSON 字符串：让 serde 去解一个任意 Value
    // 会把「输入是什么形状」这件事从契约里糊掉
    return {
      workflowId: record.workflowId,
      ...(record.versionId ? { versionId: record.versionId } : {}),
      ...(record.draftRev === undefined ? {} : { draftRev: record.draftRev }),
      inputsJson: JSON.stringify(record.inputs ?? {}),
      workdir: record.workdir,
    };
  }

  if (method === 'run.list') {
    // Rust 侧参数是 Vec<String>，undefined 会让 invoke 直接报参数错误
    return {
      ...(record.workflowId ? { workflowId: record.workflowId } : {}),
      statuses: Array.isArray(record.status) ? record.status : [],
      ...(record.query ? { query: record.query } : {}),
    };
  }

  if (method === 'prompt.create' || method === 'prompt.update') {
    // Rust 侧收 JSON 字符串：分段是有序数组，让 serde 解任意 Value
    // 会把「分段长什么样」这件事从契约里糊掉
    return {
      ...(record.id ? { id: record.id } : {}),
      // ver 是乐观锁，不能被这层转换吃掉
      ...(record.ver === undefined ? {} : { ver: record.ver }),
      ...(record.group ? { group: record.group } : {}),
      ...(record.name ? { name: record.name } : {}),
      ...(record.sections ? { sectionsJson: JSON.stringify(record.sections) } : {}),
      ...(record.vars ? { varsJson: JSON.stringify(record.vars) } : {}),
    };
  }

  if (method === 'supervisor.ask') {
    // 上下文转成 JSON 字符串：Rust 侧只是把它拼进提示词，
    // 不需要为每个字段建一个参数
    return {
      question: record.question,
      ...(record.modelRef ? { modelRef: record.modelRef } : {}),
      contextJson: JSON.stringify(record.context ?? {}),
    };
  }

  if (method === 'model.list') {
    return { enabledOnly: record.enabledOnly ?? false };
  }

  if (method === 'run.events') {
    return {
      runId: record.runId,
      fromSeq: record.fromSeq ?? 0,
      limit: record.limit ?? 200,
    };
  }

  if (method === 'approval.decide') {
    // selected 与 supplement 属于审批的完整语义，等 M2 后半段的
    // 审批面板接上时再传；现在发过去 Rust 侧只会报参数不认识
    return { runId: record.runId, nodeId: record.nodeId, decision: record.decision };
  }

  return record;
}

interface RunRowDto {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  inputsJson: string;
  currentNode?: string | null;
  workdir?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

function toRun(row: RunRowDto): Record<string, unknown> {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    status: row.status,
    inputs: parseInputs(row.inputsJson),
    envSnapshot: {},
    ...(row.currentNode ? { currentNode: row.currentNode } : {}),
    ...(row.workdir ? { workdir: row.workdir } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.endedAt ? { endedAt: row.endedAt } : {}),
  };
}

/** 一条坏记录不该让整个执行记录页打不开。 */
function parseInputs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface WorkflowRowDto {
  id: string;
  name: string;
  folder?: string | null;
  createdAt?: string;
  updatedAt: string;
  archived?: boolean;
  latestVersion?: number;
  lastRun?: unknown;
}

interface VersionMetaDto {
  id: string;
  version: number;
  configHash: string;
  publishedAt: string;
  publishedBy: string;
}

export function fromIpcResult(method: CoreApiMethod, raw: unknown): unknown {
  switch (method) {
    case 'workflow.list': {
      const rows = (raw ?? []) as WorkflowRowDto[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          ...(row.folder ? { folder: row.folder } : {}),
          createdAt: row.createdAt ?? row.updatedAt,
          updatedAt: row.updatedAt,
          archived: row.archived ?? false,
          // 运行态投影：后端已按 camelCase 发，原样带过来。
          // 漏掉的话首页每一行都长成「未运行 · 草稿」
          ...(row.latestVersion === undefined ? {} : { latestVersion: row.latestVersion }),
          ...(row.lastRun ? { lastRun: row.lastRun } : {}),
        })),
      };
    }

    case 'workflow.get': {
      const detail = raw as WorkflowRowDto & {
        rev: number;
        graphJson: string;
        versions: VersionMetaDto[];
      };
      let graph: unknown;
      try {
        graph = JSON.parse(detail.graphJson);
      } catch (error) {
        // 给一张空图会让用户以为工作流丢了，宁可报错
        throw new CoreApiError({
          code: 'INTERNAL',
          message: `工作流 ${detail.id} 的图数据无法解析：${String(error)}`,
          hint: '草稿可能已损坏，可从版本抽屉回滚到某个已发布版本',
        });
      }
      return {
        workflow: {
          id: detail.id,
          name: detail.name,
          ...(detail.folder ? { folder: detail.folder } : {}),
          createdAt: detail.createdAt ?? detail.updatedAt,
          updatedAt: detail.updatedAt,
          archived: false,
        },
        graph,
        rev: detail.rev,
        versions: (detail.versions ?? []).map((v) => ({
          id: v.id,
          workflowId: detail.id,
          version: v.version,
          configHash: v.configHash,
          dependencyManifest: {},
          publishedAt: v.publishedAt,
          publishedBy: v.publishedBy,
        })),
      };
    }

    case 'workflow.create':
      return { id: raw as string, rev: 0 };

    case 'workflow.patch':
      // Diff 与校验结果已在客户端算过（DraftStore），这里只回新 rev
      return {
        rev: raw as number,
        diff: { added: [], removed: [], changed: [] },
        validation: { ok: true, issues: [] },
      };

    case 'workflow.publish': {
      const dto = raw as { versionId: string; version: number; configHash: string };
      return { versionId: dto.versionId, version: dto.version, configHash: dto.configHash };
    }

    case 'workflow.versionGraph': {
      try {
        return { graph: JSON.parse(raw as string) };
      } catch (error) {
        throw new CoreApiError({
          code: 'INTERNAL',
          message: `版本的图数据无法解析：${String(error)}`,
        });
      }
    }

    case 'workflow.rollback':
      return { rev: raw as number };

    case 'workflow.rename':
    case 'workflow.delete':
      return { ok: true };

    case 'run.start':
      return { runId: raw as string };

    case 'run.list':
      return { items: ((raw ?? []) as RunRowDto[]).map(toRun) };

    case 'run.get':
      return { run: raw ? toRun(raw as RunRowDto) : null };

    case 'run.events':
    case 'run.dryRun':
    case 'run.artifacts':
    case 'run.artifactContent':
      return raw;

    case 'run.cancel':
    case 'run.resume':
      return { ok: true };

    case 'supervisor.ask':
    case 'workspace.stats':
      return raw;

    case 'memory.list':
    case 'prompt.list':
    case 'agent.list':
    case 'model.list':
      return { items: raw ?? [] };

    case 'memory.create':
    case 'agent.create':
    case 'agent.duplicate':
    case 'prompt.create':
    case 'prompt.duplicate':
      return { id: raw as string };

    // 这两个返回新版本号，不是 { ok }。归错档的话后端算出的 ver
    // 在这一层就被丢掉了，界面拿不到新版本，下一次保存必然撞乐观锁
    case 'agent.update':
    case 'prompt.update':
      return raw;

    case 'agent.delete':
    case 'prompt.delete':
    case 'memory.update':
    case 'memory.toggle':
    case 'memory.delete':
      return { ok: true };

    case 'model.create':
      return { id: raw as string };

    case 'model.update':
    case 'model.delete':
      return { ok: true };

    case 'approval.decide':
      return { ok: true };

    default:
      return raw;
  }
}

export function normalizeIpcError(error: unknown): CoreApiError {
  if (error instanceof CoreApiError) return error;

  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = error as { code: unknown; message?: unknown; retriable?: unknown };
    const code = ERROR_CODES.find((c) => c === candidate.code);
    if (code) {
      return new CoreApiError({
        code: code as ErrorCode,
        message: typeof candidate.message === 'string' ? candidate.message : 'IPC 调用失败',
        ...(typeof candidate.retriable === 'boolean' ? { retriable: candidate.retriable } : {}),
      });
    }
  }

  return new CoreApiError({
    code: 'INTERNAL',
    message: `IPC 调用失败：${error instanceof Error ? error.message : String(error)}`,
    details: error,
  });
}

export type InvokeFn = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * 桌面形态的传输实现。invoke 由外部注入，便于测试。
 */
export function createTauriTransport(invoke: InvokeFn): Transport {
  return {
    async call(method, input) {
      const command = ipcCommandFor(method);
      if (!command) {
        throw new CoreApiError({
          code: 'INTERNAL',
          message: `${method} 尚未接通引擎`,
          hint: '该方法所属的能力还没实现，见 docs/ROADMAP.md 的里程碑安排',
        });
      }
      try {
        const raw = await invoke(command, toIpcInput(method, input));
        return fromIpcResult(method, raw);
      } catch (error) {
        throw normalizeIpcError(error);
      }
    },

    subscribeEvents() {
      // 事件流在 M2 随引擎接上
      return () => {};
    },
  };
}
