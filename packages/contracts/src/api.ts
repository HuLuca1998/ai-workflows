import { z } from 'zod';
import type { Scope } from './capabilities.js';
import { RUN_EVENT_CATEGORIES, RunEventSchema } from './events.js';
import { WorkflowGraphSchema } from './graph.js';
import { PatchOperationSchema } from './patch.js';
import {
  AgentProfileSchema,
  ApprovalDecisionSchema,
  EnvHealthItemSchema,
  MemorySchema,
  ModelSchema,
  PromptSchema,
  RunSchema,
  WorkflowSchema,
  WorkflowVersionSchema,
} from './domain.js';
import { RUN_STATUSES } from './state-machine.js';

/**
 * Core API 契约（技术选型 §11）。IPC 与 tRPC 共用同一份定义：
 * 界面代码不感知传输差异，MCP 与 HTTP 也只是它的调用方。
 */

export interface MethodSpec {
  input: z.ZodType;
  output: z.ZodType;
  /** 写方法：需要审计事件、需要更高 Scope。 */
  mutates: boolean;
  audited: boolean;
  /** null 表示仅本地 UI 可调用，不通过 MCP / HTTP 暴露。 */
  scope: Scope | null;
  summary: string;
}

const ok = z.object({ ok: z.literal(true) });
const idOnly = z.object({ id: z.string().min(1) });
const ValidationIssueSchema = z.object({
  level: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});
const ValidationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(ValidationIssueSchema),
});
const DiffEntrySchema = z.object({
  kind: z.enum(['node', 'edge', 'group']),
  id: z.string(),
  label: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
const DiffSchema = z.object({
  added: z.array(DiffEntrySchema),
  removed: z.array(DiffEntrySchema),
  changed: z.array(DiffEntrySchema),
});

/** 一次最多拉多少事件：Run Detail 用游标分页 + 虚拟滚动，不允许一把梭。 */
export const EVENTS_PAGE_LIMIT_MAX = 1000;

const SPECS = {
  // ── Workflow ────────────────────────────────────────────────────────────
  'workflow.list': {
    input: z.object({ query: z.string().optional(), archived: z.boolean().optional() }),
    output: z.object({ items: z.array(WorkflowSchema) }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出工作流',
  },
  'workflow.get': {
    input: z.object({ id: z.string().min(1), rev: z.number().int().min(0).optional() }),
    output: z.object({
      workflow: WorkflowSchema,
      graph: WorkflowGraphSchema,
      rev: z.number().int().min(0),
      versions: z.array(WorkflowVersionSchema.omit({ graph: true })),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '读取工作流草稿与版本列表',
  },
  'workflow.create': {
    input: z.object({
      name: z.string().min(1),
      folder: z.string().optional(),
      fromTemplate: z.string().optional(),
      /**
       * 初始图（JSON）。模板与导入都走这里：它们没有「相对于什么的改动」，
       * 拿假 Patch 去凑 operations 会往审计里写一条不存在的操作。
       */
      graphJson: z.string().min(1).optional(),
    }),
    output: z.object({ id: z.string().min(1), rev: z.number().int().min(0) }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '创建工作流',
  },
  'workflow.patch': {
    input: z.object({
      id: z.string().min(1),
      baseRevision: z.number().int().min(0),
      operations: z.array(PatchOperationSchema).min(1),
      /**
       * 客户端应用 Patch 后的结果图（JSON）。
       *
       * 结构化 Patch 的应用逻辑（applyPatch）在本包里，引擎侧没有对应实现，
       * 所以由调用方算出 Diff 与新图后一并提交，引擎只做 baseRevision 守卫与落库。
       * 不传时由实现方决定是否自行应用——见 docs/adr/0008。
       */
      graphJson: z.string().min(1).optional(),
    }),
    output: z.object({
      rev: z.number().int(),
      diff: DiffSchema,
      validation: ValidationResultSchema,
    }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '结构化修改草稿；rev 不匹配返回 REVISION_CONFLICT',
  },
  'workflow.validate': {
    input: z.object({ id: z.string().min(1), rev: z.number().int().min(0).optional() }),
    output: ValidationResultSchema,
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '校验草稿',
  },
  'workflow.diff': {
    input: z.object({ id: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }),
    output: DiffSchema,
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '对比两个版本或草稿',
  },
  'workflow.versionGraph': {
    input: z.object({ versionId: z.string().min(1) }),
    output: z.object({ graph: WorkflowGraphSchema }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '读取某个已发布版本的图（回滚与版本对比用）',
  },
  'workflow.rollback': {
    input: z.object({ id: z.string().min(1), versionId: z.string().min(1) }),
    output: z.object({ rev: z.number().int().min(0) }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '把某个已发布版本回填为新的草稿修订（原草稿保留在历史里）',
  },
  'workflow.publish': {
    input: z.object({
      id: z.string().min(1),
      rev: z.number().int().min(0),
      note: z.string().optional(),
    }),
    output: z.object({
      versionId: z.string().min(1),
      version: z.number().int().min(1),
      configHash: z.string().min(1),
    }),
    mutates: true,
    audited: true,
    scope: 'workflow:publish',
    summary: '把草稿发布为不可变版本',
  },
  'workflow.delete': {
    input: idOnly,
    output: ok,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '归档 / 删除工作流（需单独确认）',
  },

  // ── Run ─────────────────────────────────────────────────────────────────
  'run.start': {
    input: z
      .object({
        workflowId: z.string().min(1),
        versionId: z.string().min(1).optional(),
        draftRev: z.number().int().min(0).optional(),
        inputs: z.record(z.string(), z.unknown()).default({}),
        /** 留空表示用应用的默认运行目录 —— 那个路径只有引擎侧知道。 */
        workdir: z.string().optional(),
        dryRun: z.boolean().default(false),
      })
      // 必须说清跑的是哪一份定义：已发布版本或草稿修订，二选一
      .refine((v) => (v.versionId === undefined) !== (v.draftRev === undefined), {
        message: 'versionId 与 draftRev 必须且只能提供一个',
      }),
    output: z.object({ runId: z.string().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:run',
    summary: '启动运行（先做 preflight）',
  },
  'run.dryRun': {
    // 图纸的启动表单在**打开时**就显示依赖检查结果，不是点了开始才查，
    // 所以这是一个独立于 run.start 的只读方法
    input: z
      .object({
        workflowId: z.string().min(1),
        versionId: z.string().min(1).optional(),
        draftRev: z.number().int().min(0).optional(),
        workdir: z.string().optional(),
      })
      .refine((v) => (v.versionId === undefined) !== (v.draftRev === undefined), {
        message: 'versionId 与 draftRev 必须且只能提供一个',
      }),
    output: z.object({
      /** 实际会用的工作目录。留空时由引擎决定，界面据此显示。 */
      workdir: z.string(),
      checks: z.array(
        z.object({
          label: z.string(),
          status: z.enum(['passed', 'failed']),
          detail: z.string(),
        }),
      ),
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      ok: z.boolean(),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: 'Dry Run 依赖检查：只报真的查过的项',
  },
  'run.list': {
    input: z.object({
      workflowId: z.string().optional(),
      status: z.array(z.enum(RUN_STATUSES)).optional(),
      query: z.string().optional(),
    }),
    output: z.object({ items: z.array(RunSchema) }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出运行',
  },
  'run.get': {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ run: RunSchema }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '读取单次运行',
  },
  'run.events': {
    input: z.object({
      runId: z.string().min(1),
      fromSeq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(EVENTS_PAGE_LIMIT_MAX).default(200),
      categories: z.array(z.enum(RUN_EVENT_CATEGORIES)).optional(),
    }),
    output: z.object({
      events: z.array(RunEventSchema),
      nextSeq: z.number().int().min(0),
      hasMore: z.boolean(),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '游标分页拉事件；订阅版为 SSE / channel 推送',
  },
  'run.artifacts': {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({
      items: z.array(
        z.object({
          nodeId: z.string(),
          kind: z.string(),
          name: z.string(),
          path: z.string(),
          bytes: z.number().int().min(0),
          sha256: z.string(),
        }),
      ),
      /** 产物目录，图纸里显示在列表底部。 */
      root: z.string(),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出一次运行的产物',
  },
  'run.resume': {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ runId: z.string().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:run',
    summary: '从检查点恢复',
  },
  'run.cancel': {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ runId: z.string().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:run',
    summary: '取消运行：先停子进程再写 cancelled 事件，已产生的产物保留',
  },
  'run.retryNode': {
    input: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    output: z.object({ runId: z.string().min(1), newAttempt: z.number().int().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:run',
    summary: '从失败节点重试；副作用操作重试前核对外部状态',
  },

  // ── Approval ────────────────────────────────────────────────────────────
  'approval.decide': {
    input: ApprovalDecisionSchema.omit({ decidedAt: true, actor: true }),
    output: z.object({ accepted: z.boolean() }),
    mutates: true,
    audited: true,
    scope: 'workflow:run',
    summary: '提交审批决定',
  },

  // ── Memory ──────────────────────────────────────────────────────────────
  'memory.list': {
    input: z.object({
      scope: z.string().optional(),
      scopeId: z.string().optional(),
      query: z.string().optional(),
    }),
    output: z.object({ items: z.array(MemorySchema) }),
    mutates: false,
    audited: false,
    scope: 'memory:read',
    summary: '按作用域列出记忆',
  },
  'memory.create': {
    input: MemorySchema.omit({ id: true, createdAt: true, updatedAt: true, ver: true }),
    output: idOnly,
    mutates: true,
    audited: true,
    scope: 'memory:write',
    summary: '写入记忆（Token 与密钥禁止写入）',
  },
  'memory.update': {
    input: z.object({
      id: z.string().min(1),
      value: z.string().optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
      /** 乐观锁：落后版本会被拒绝。 */
      ver: z.number().int().min(1),
    }),
    output: z.object({ ver: z.number().int().min(1) }),
    mutates: true,
    audited: true,
    scope: 'memory:write',
    summary: '更新记忆并生成新版本',
  },
  'memory.delete': {
    input: idOnly,
    output: ok,
    mutates: true,
    audited: true,
    scope: 'memory:write',
    summary: '删除记忆（删除后不再注入未来调用）',
  },

  // ── Prompt / Model / Agent ─────────────────────────────────────────────
  'prompt.list': {
    input: z.object({ group: z.string().optional(), query: z.string().optional() }),
    output: z.object({ items: z.array(PromptSchema) }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出提示词',
  },
  'prompt.create': {
    input: PromptSchema.omit({ id: true, ver: true, updatedAt: true }),
    output: idOnly,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '新建提示词',
  },
  'prompt.update': {
    input: PromptSchema.partial().extend({ id: z.string().min(1), ver: z.number().int().min(1) }),
    output: z.object({ ver: z.number().int().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '保存为新版本（运行记录引用具体版本号）',
  },
  'prompt.delete': {
    input: idOnly,
    output: ok,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '删除自定义提示词；内置项只能恢复默认',
  },
  'model.list': {
    input: z.object({ enabledOnly: z.boolean().default(false) }),
    output: z.object({ items: z.array(ModelSchema) }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出已登记模型',
  },
  'model.create': {
    input: ModelSchema.omit({ id: true }),
    output: idOnly,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '登记模型（ACP 握手不返回模型列表，需手动登记或从 CLI 导入）',
  },
  'model.update': {
    input: ModelSchema.partial().extend({ id: z.string().min(1) }),
    output: ok,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '更新模型登记',
  },
  'model.delete': {
    input: idOnly,
    output: ok,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '删除模型登记',
  },
  'model.test': {
    input: idOnly,
    output: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative().optional(),
      detail: z.string().optional(),
    }),
    mutates: false,
    audited: true,
    scope: 'workflow:read',
    summary: '连通性测试',
  },
  'agent.list': {
    input: z.object({ query: z.string().optional() }),
    output: z.object({ items: z.array(AgentProfileSchema) }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出 Agent 角色',
  },
  'agent.create': {
    input: AgentProfileSchema.omit({ id: true, ver: true }),
    output: idOnly,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '新建 Agent 角色',
  },
  'agent.update': {
    input: AgentProfileSchema.partial().extend({
      id: z.string().min(1),
      ver: z.number().int().min(1),
    }),
    output: z.object({ ver: z.number().int().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '保存 Agent 新版本；引用它的节点一并生效',
  },
  'agent.duplicate': {
    // 图纸详情区有「复制」：用户想基于内置角色改，但不该改到内置本身。
    // 副本从 v1 开始，且一定是可编辑的
    input: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    output: idOnly,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '复制角色为一个可编辑的副本',
  },
  'agent.delete': {
    input: idOnly,
    output: ok,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '删除 Agent 角色（被引用时拒绝）',
  },

  // ── 环境 ────────────────────────────────────────────────────────────────
  'env.health': {
    input: z.object({ recheck: z.boolean().default(false) }),
    output: z.object({
      status: z.enum(['ready', 'needs_attention']),
      items: z.array(EnvHealthItemSchema),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '环境健康报告',
  },
  'env.install': {
    input: z.object({ tools: z.array(z.string().min(1)).min(1) }),
    output: z.object({ started: z.boolean() }),
    mutates: true,
    audited: true,
    // 安装会动本机文件系统：只允许本地 UI 在用户确认后触发，绝不给远端 Scope
    scope: null,
    summary: '安装缺失工具（不使用 sudo，不改 shell profile）',
  },
} as const satisfies Record<string, MethodSpec>;

export type CoreApiMethod = keyof typeof SPECS;
export const CORE_API_METHODS = Object.keys(SPECS) as CoreApiMethod[];

export function getMethodSpec(method: CoreApiMethod): MethodSpec {
  const spec = SPECS[method];
  if (!spec) {
    throw new Error(`未登记的 Core API 方法：${method}`);
  }
  return spec;
}

export function requiredScope(method: CoreApiMethod): Scope | null {
  return getMethodSpec(method).scope;
}

/**
 * MCP 首版暴露的工具（技术选型 §6 的落地顺序）：
 * 只读 + create + patch + validate + 记忆 CRUD；publish / run 稳定后再开。
 */
export const MCP_FIRST_RELEASE_TOOLS: readonly CoreApiMethod[] = [
  'workflow.list',
  'workflow.get',
  'workflow.create',
  'workflow.patch',
  'workflow.validate',
  'workflow.diff',
  'run.list',
  'run.get',
  'run.events',
  'memory.list',
  'memory.create',
  'memory.update',
  'memory.delete',
  'prompt.list',
  'model.list',
  'agent.list',
] as const;
