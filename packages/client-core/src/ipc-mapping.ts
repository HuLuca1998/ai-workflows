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
  'run.rewindToApproval': 'run_rewind_to_approval',
  'mcp.requestConfirm': 'mcp_request_confirm',
  'mcp.confirmStatus': 'mcp_confirm_status',
  'mcp.pendingConfirms': 'mcp_pending_confirms',
  'mcp.decideConfirm': 'mcp_decide_confirm',
  'mcp.status': 'mcp_status',
  'mcp.connect': 'mcp_connect',
  'workspace.settings': 'workspace_settings',
  'env.diagnostics': 'env_diagnostics',
  'workspace.updateSettings': 'workspace_update_settings',
  'workspace.resetPreview': 'workspace_reset_preview',
  'workspace.reset': 'workspace_reset',
  'env.health': 'env_health',
  'github.repos': 'github_repos',
  'github.branches': 'github_branches',
  'run.diagnostics': 'run_diagnostics',
  'supervisor.sessions': 'supervisor_sessions',
  'supervisor.session': 'supervisor_session',
  'run.artifactContent': 'run_artifact_content',
  'workflow.get': 'workflow_get',
  'workflow.create': 'workflow_create',
  // 结构化操作交给引擎应用（ADR-0009）：它自己算 Diff、自己校验、
  // 自己做 baseRevision 守卫。客户端仍会先本地应用一次做乐观更新，
  // 两份实现的一致性由 crates/engine/tests/conformance_test.rs 压着
  'workflow.patch': 'workflow_patch',
  'workflow.validate': 'workflow_validate',
  'workflow.diff': 'workflow_diff',
  'workflow.versionGraph': 'workflow_version_graph',
  'workflow.rollback': 'workflow_rollback',
  'workflow.publish': 'workflow_publish',
  'workflow.rename': 'workflow_rename',
  'workflow.discardIfEmpty': 'workflow_discard_if_empty',
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
  'prompt.versions': 'prompt_versions',
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
  'model.test': 'model_test',
  'model.delete': 'model_delete',
};

export function ipcCommandFor(method: CoreApiMethod): string | null {
  return COMMANDS[method] ?? null;
}

export function toIpcInput(method: CoreApiMethod, input: unknown): Record<string, unknown> {
  const record = (input ?? {}) as Record<string, unknown>;
  // 这一层是白名单式的：每个分支只挑自己认识的字段，漏一个就静默丢掉。
  // run.list 就这么把 limit/offset 丢过 —— 症状是「页码在走，数据不换」，
  // 而原因离症状很远。分页参数统一在出口补回来，不再逐个分支去记。
  return withPaging(record, shapeFor(method, record));
}

/**
 * 分页参数原样带上。
 *
 * 只有列表方法有它们；其余方法的 record 里根本没有这两个键，
 * 所以无条件补是安全的。
 */
function withPaging(
  record: Record<string, unknown>,
  shaped: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...shaped,
    ...(record.limit === undefined ? {} : { limit: record.limit }),
    ...(record.offset === undefined ? {} : { offset: record.offset }),
  };
}

function shapeFor(method: CoreApiMethod, record: Record<string, unknown>): Record<string, unknown> {
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
    // 操作列表是权威的那一份 —— 引擎自己应用（ADR-0009）。
    //
    // 原先这里必须带 graphJson，因为 Rust 侧没有 applyPatch，只能整份回写；
    // 于是返回的 diff 与 validation 是**编出来的空壳**（见下面 fromIpc）。
    // 现在引擎自己算，两样都是真的了。graphJson 仍然捎带，当交叉校验：
    // 两边算出的图不一致时引擎会留一行日志，说明 conformance 夹具漏了形态。
    const operations = record.operations;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new CoreApiError({
        code: 'INTERNAL',
        message: 'workflow.patch 缺少 operations：结构化操作是唯一的写入形态',
      });
    }
    return {
      id: record.id,
      baseRevision: record.baseRevision,
      operations,
      ...(typeof record.graphJson === 'string' ? { graphJson: record.graphJson } : {}),
    };
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
      // 「是谁改的」要带过去 —— 这层是白名单式的，漏一个就静默丢掉，
      // ver 和 run.list 的分页参数都这么丢过
      ...(record.changedBy ? { changedBy: record.changedBy } : {}),
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

  if (method === 'agent.update' || method === 'agent.create') {
    // capabilities 是对象。桌面壳收字符串（与 sectionsJson 同一条理由：
    // 让 serde 解任意 Value 会把「能力长什么样」从契约里糊掉），
    // 而 devserver 直接读 input.capabilities —— 两边都给，各取所需
    return {
      ...record,
      ...(record.capabilities === undefined
        ? {}
        : { capabilitiesJson: JSON.stringify(record.capabilities) }),
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
      const page = (raw ?? { items: [], total: 0 }) as {
        items: WorkflowRowDto[];
        total: number;
      };
      const rows = page.items ?? [];
      return {
        total: page.total ?? rows.length,
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
      // 引擎算的 Diff 与校验结果原样回去。
      //
      // 这里曾经编一个空 Diff 加一句「ok: true」——因为底下走的是
      // workflow_save_draft，它只回一个 rev。代价是任何**不经过 DraftStore**
      // 的调用方（MCP、脚本、以后的 Web 形态）都会收到一句
      // 「校验通过、什么都没改」，而实际上图可能已经坏了
      return raw as unknown;

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

    case 'run.list': {
      const page = (raw ?? { items: [], total: 0 }) as { items: RunRowDto[]; total: number };
      const rows = page.items ?? [];
      return { items: rows.map(toRun), total: page.total ?? rows.length };
    }

    case 'run.get':
      return { run: raw ? toRun(raw as RunRowDto) : null };

    case 'run.events':
    case 'run.dryRun':
    case 'run.artifacts':
    case 'run.artifactContent':
      return raw;

    // 引擎返回裸 id 字符串（与 workflow.create 一样），契约要 { id }
    case 'mcp.requestConfirm':
      return { id: raw };

    // 引擎返回数组，契约要 { items }
    case 'mcp.pendingConfirms':
      return { items: raw ?? [] };

    // 引擎返回 ()，契约要 { ok: true }
    case 'mcp.decideConfirm':
      return { ok: true };

    case 'prompt.versions': {
      // Rust 侧把分段与变量作为 JSON 字符串带回来（引擎不需要理解它们的结构）
      const rows = (raw ?? []) as {
        ver: number;
        name: string;
        sectionsJson: string;
        varsJson: string;
        changedBy: string;
        createdAt: string;
      }[];
      return {
        items: rows.map((row) => ({
          ver: row.ver,
          name: row.name,
          sections: safeParse(row.sectionsJson, []),
          vars: safeParse(row.varsJson, []),
          changedBy: row.changedBy,
          createdAt: row.createdAt,
        })),
      };
    }

    case 'run.cancel':
    case 'run.resume':
    // 引擎侧返回 ()，序列化成 null；契约要 { ok: true }
    case 'workspace.updateSettings':
      return { ok: true };

    case 'supervisor.session':
    case 'supervisor.ask':
    case 'workspace.stats':
    // 这两个的形状引擎那边已经是契约要的样子（DTO 带 camelCase），
    // 原样带过来 —— 在这里重组一遍只会多一处能漂移的地方
    case 'workspace.resetPreview':
    case 'workspace.reset':
    case 'env.health':
    case 'github.repos':
    case 'github.branches':
    case 'run.diagnostics':
    case 'workflow.discardIfEmpty':
      return raw;

    // 分页的列表：后端已经发 { items, total }，原样带过来。
    // 再包一层 { items: raw } 的话 total 就丢了 —— 而界面靠它画分页控件
    case 'memory.list':
    case 'prompt.list':
    case 'agent.list':
    case 'model.list':
      return raw;

    case 'supervisor.sessions':
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
    const candidate = error as {
      code: unknown;
      message?: unknown;
      retriable?: unknown;
      hint?: unknown;
      details?: unknown;
    };
    const code = ERROR_CODES.find((c) => c === candidate.code);
    if (code) {
      return new CoreApiError({
        code: code as ErrorCode,
        message: typeof candidate.message === 'string' ? candidate.message : 'IPC 调用失败',
        ...(typeof candidate.retriable === 'boolean' ? { retriable: candidate.retriable } : {}),
        // hint 是「接下来该干什么」，界面直接展示。这里漏掉它的话，
        // 引擎那边算出来的那句话就永远到不了用户眼前 —— 而症状是
        // 「补了上游也不生效」，最难查
        ...(typeof candidate.hint === 'string' ? { hint: candidate.hint } : {}),
        ...(candidate.details === undefined ? {} : { details: candidate.details }),
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

/** 解析引擎带回来的 JSON 字符串。坏了就当空 —— 一条历史读不出来不该让整页崩掉。 */
function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
