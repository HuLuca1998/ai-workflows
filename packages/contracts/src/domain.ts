import { z } from 'zod';
import { CapabilitiesSchema, PERMISSION_PRESETS } from './capabilities.js';
import { WorkflowGraphSchema } from './graph.js';
import { NODE_STATUSES, RUN_STATUSES } from './state-machine.js';
import { SENSITIVITY_LEVELS } from './events.js';

/**
 * 领域实体。字段与 SQLite 表（技术选型 §10）一一对应，避免出现「界面有、库里没有」的字段。
 */

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  folder: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archived: z.boolean().default(false),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

/** 草稿：rev 单调递增，编辑草稿不影响运行中的版本。 */
export const WorkflowRevisionSchema = z.object({
  workflowId: z.string().min(1),
  rev: z.number().int().min(0),
  graph: WorkflowGraphSchema,
  updatedAt: z.iso.datetime(),
});
export type WorkflowRevision = z.infer<typeof WorkflowRevisionSchema>;

/** 已发布版本：不可变快照，运行记录永远引用它。 */
export const WorkflowVersionSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  version: z.number().int().min(1),
  graph: WorkflowGraphSchema,
  /** 配置哈希：运行记录据此断言「跑的就是这份配置」。 */
  configHash: z.string().min(1),
  dependencyManifest: z.record(z.string(), z.string()).default({}),
  publishedAt: z.iso.datetime(),
  publishedBy: z.string().min(1),
});
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  draftRev: z.number().int().min(0).optional(),
  status: z.enum(RUN_STATUSES),
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** 环境快照：同一工作流不同参数并行运行时互不影响。 */
  envSnapshot: z.record(z.string(), z.string()).default({}),
  currentNode: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  /** 子工作流以独立 Run + parentRunId 表达，审批冒泡到父运行。 */
  parentRunId: z.string().min(1).optional(),
  permissionPreset: z.enum(PERMISSION_PRESETS).default('workspace_safe'),
});
export type Run = z.infer<typeof RunSchema>;

export const NodeRunStateSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  status: z.enum(NODE_STATUSES),
  attempt: z.number().int().min(1),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
});
export type NodeRunState = z.infer<typeof NodeRunStateSchema>;

export const MEMORY_SCOPES = ['global', 'workspace', 'workflow', 'agent', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MemorySchema = z.object({
  id: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().optional(),
  key: z.string().min(1),
  value: z.string(),
  summary: z.string().optional(),
  source: z.enum(['user', 'ai_proposed', 'system']).default('user'),
  createdBy: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  sensitivity: z.enum(SENSITIVITY_LEVELS).default('internal'),
  /** 乐观锁：AI 通过 MCP 更新时携带版本号，落后版本会被拒绝。 */
  ver: z.number().int().min(1),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type Memory = z.infer<typeof MemorySchema>;

export const AGENT_RUNTIMES = ['acp.claude', 'acp.codex', 'provider.api'] as const;

export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  goal: z.string().default(''),
  persona: z.string().default(''),
  runtime: z.enum(AGENT_RUNTIMES),
  modelRef: z.string().min(1),
  fallbackModelRef: z.string().min(1).optional(),
  tools: z.array(z.string()).default([]),
  capabilities: CapabilitiesSchema,
  outputContract: z.string().default(''),
  turnLimit: z.number().int().positive().default(12),
  timeoutMs: z.number().int().positive().default(900_000),
  ver: z.number().int().min(1),
  builtin: z.boolean().default(false),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const PromptSchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  name: z.string().min(1),
  /** 框架分段可见可改：Role / Task / Context / Constraints / Output contract。 */
  sections: z.array(z.object({ title: z.string().min(1), body: z.string() })),
  vars: z
    .array(
      z.object({
        name: z.string().min(1),
        source: z.string().min(1),
        onMissing: z.enum(['empty_and_log', 'fail', 'default']).default('empty_and_log'),
        default: z.string().optional(),
      }),
    )
    .default([]),
  ver: z.number().int().min(1),
  builtin: z.boolean().default(false),
  updatedAt: z.iso.datetime(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: z.enum(AGENT_RUNTIMES),
  modelId: z.string().min(1),
  /** 同一模型的不同推理档位登记为不同条目，运行记录才能区分。 */
  effort: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),
  contextWindow: z.number().int().positive(),
  capabilities: z.array(z.string()).default([]),
  credentialRef: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  lastLatencyMs: z.number().int().nonnegative().optional(),
});
export type Model = z.infer<typeof ModelSchema>;

export const ApprovalDecisionSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  decision: z.enum(['approved', 'changes_requested', 'rejected']),
  selected: z.array(z.string()).default([]),
  supplement: z.string().default(''),
  decidedAt: z.iso.datetime(),
  actor: z.string().min(1),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum(['diff', 'report', 'log', 'json', 'binary']),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  truncated: z.boolean().default(false),
  createdAt: z.iso.datetime(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const EnvHealthItemSchema = z.object({
  capability: z.string().min(1),
  version: z.string().optional(),
  path: z.string().optional(),
  source: z.enum(['system', 'app_managed', 'missing']),
  status: z.enum(['ready', 'needs_attention', 'optional', 'missing']),
  detail: z.string().optional(),
});
export type EnvHealthItem = z.infer<typeof EnvHealthItemSchema>;
