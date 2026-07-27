import {
  CoreApiError,
  ERROR_CODES,
  type CoreApiMethod,
  type ErrorCode,
  type Transport,
} from './ipc-deps.js';

/**
 * Core API 方法 ↔ Tauri IPC 命令的转换层。
 *
 * 契约用点号方法名与 camelCase，Rust 侧用 snake_case，两边形状不同。
 * 转换逻辑单独放在这里而不是散在调用点，是因为字段名写错的症状是
 * 「数据莫名为空」而不是报错——必须能单测。
 */

/** 已接通引擎的方法。没列在这里的方法调用时会明确报未实现。 */
const COMMANDS: Partial<Record<CoreApiMethod, string>> = {
  'workflow.list': 'workflow_list',
  'workflow.get': 'workflow_get',
  'workflow.create': 'workflow_create',
  // patch 的结构化操作在客户端应用并生成 Diff（contracts 的 applyPatch），
  // 落库写整份图 + baseRevision 守卫，见 crates/store 的 save_draft_guarded
  'workflow.patch': 'workflow_save_draft',
  'workflow.versionGraph': 'workflow_version_graph',
  'workflow.rollback': 'workflow_rollback',
  'workflow.publish': 'workflow_publish',
  'workflow.delete': 'workflow_delete',
  'run.start': 'run_start',
  'run.list': 'run_list',
  'run.get': 'run_get',
  'run.events': 'run_events',
  'run.cancel': 'run_cancel',
  'run.resume': 'run_resume',
  'approval.decide': 'approval_decide',
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
  created_at?: string;
  updated_at: string;
}

interface VersionMetaDto {
  id: string;
  version: number;
  config_hash: string;
  published_at: string;
  published_by: string;
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
          createdAt: row.created_at ?? row.updated_at,
          updatedAt: row.updated_at,
          archived: false,
        })),
      };
    }

    case 'workflow.get': {
      const detail = raw as WorkflowRowDto & {
        rev: number;
        graph_json: string;
        versions: VersionMetaDto[];
      };
      let graph: unknown;
      try {
        graph = JSON.parse(detail.graph_json);
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
          createdAt: detail.created_at ?? detail.updated_at,
          updatedAt: detail.updated_at,
          archived: false,
        },
        graph,
        rev: detail.rev,
        versions: (detail.versions ?? []).map((v) => ({
          id: v.id,
          workflowId: detail.id,
          version: v.version,
          configHash: v.config_hash,
          dependencyManifest: {},
          publishedAt: v.published_at,
          publishedBy: v.published_by,
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
      const dto = raw as { version_id: string; version: number; config_hash: string };
      return { versionId: dto.version_id, version: dto.version, configHash: dto.config_hash };
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

    case 'workflow.delete':
      return { ok: true };

    case 'run.start':
      return { runId: raw as string };

    case 'run.list':
      return { items: ((raw ?? []) as RunRowDto[]).map(toRun) };

    case 'run.get':
      return { run: raw ? toRun(raw as RunRowDto) : null };

    case 'run.events':
      return raw;

    case 'run.cancel':
    case 'run.resume':
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
