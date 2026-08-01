import { z } from 'zod';
import { CapabilitiesSchema, PERMISSION_PRESETS } from './capabilities.js';
import { WorkflowGraphSchema } from './graph.js';
import { NODE_STATUSES, RUN_STATUSES } from './state-machine.js';
import { SENSITIVITY_LEVELS } from './events.js';

/**
 * 领域实体。字段与 SQLite 表（技术选型 §10）一一对应，避免出现「界面有、库里没有」的字段。
 */

/**
 * 工作流列表行上那点运行态投影。
 *
 * 图纸「01 工作流首页」的状态列显示的是**最近一次运行**的状态
 * （等待审批 / 成功 / 失败 · 节点 3），没运行过才是草稿或已发布。
 * 不带上这些，列表里每一行都长成「已创建 · 未运行 · 草稿」，
 * 跟执行记录完全对不上。
 */
export const WorkflowLastRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  startedAt: z.iso.datetime(),
  /** 已结束才有；运行中的时长由界面自己按当前时间算。 */
  durationMs: z.number().int().min(0).optional(),
  /** 失败时停在哪个节点 —— 图纸写的是「失败 · 节点 3」。 */
  failedNodeLabel: z.string().optional(),
  /** 运行引用的是不可变版本，不是草稿 rev。 */
  version: z.number().int().min(1).optional(),
});
export type WorkflowLastRun = z.infer<typeof WorkflowLastRunSchema>;

export const WorkflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  folder: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archived: z.boolean().default(false),
  /** 最新发布版本号。没发布过时缺席 —— 那时状态列显示「草稿」。 */
  latestVersion: z.number().int().min(1).optional(),
  /**
   * 已发布版本上的自动触发，一句人话（「每天 09:30」）。
   * 只有它才真的会跑 —— 调度器只看已发布版本。
   */
  scheduleLabel: z.string().optional(),
  /**
   * 草稿上设了自动触发，而已发布版本上没有（或压根没发布过）。
   *
   * 这是**填了不生效**的活标本：用户在画布上设好每天 9 点、保存、
   * 关掉，第二天来看什么都没跑，而画布上那行「每天 09:00」还好好写着。
   * 界面必须把这条标出来。
   */
  schedulePendingPublish: z.boolean().default(false),
  lastRun: WorkflowLastRunSchema.optional(),
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
  /**
   * 工作流名。存储层查 run 时顺带 JOIN 出来 ——
   * 执行记录的列表与详情都要显示它，让界面再查一次 workflow 表
   * 既慢又容易忘（忘了的症状是「运行条目只剩一个状态徽章」）。
   */
  workflowName: z.string().default(''),
  versionId: z.string().min(1).optional(),
  draftRev: z.number().int().min(0).optional(),
  status: z.enum(RUN_STATUSES),
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** 环境快照：同一工作流不同参数并行运行时互不影响。 */
  envSnapshot: z.record(z.string(), z.string()).default({}),
  currentNode: z.string().optional(),
  /** 这次运行的工作目录。详情页要显示它 —— 并行运行靠它互不干扰。 */
  workdir: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  /** 子工作流以独立 Run + parentRunId 表达，审批冒泡到父运行。 */
  parentRunId: z.string().min(1).optional(),
  /**
   * 这一条是谁发起的。定时跑出来的运行必须一眼可辨 ——
   * 否则用户第二天早上看到一条自己没点过的运行，无从判断
   * 是调度器干的还是别人动了他的机器。
   */
  trigger: z.enum(['manual', 'schedule', 'interval']).default('manual'),
  permissionPreset: z.enum(PERMISSION_PRESETS).default('human_approval'),
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

/**
 * Agent 的接入方式。**只有 ACP。**
 *
 * **`acp.codex` 排在前面是有意的**：这个应用本身跑在 Claude Code 里开发，
 * 用 claude 的 adapter 做测试会与开发环境互相干扰 —— 嵌套的 agent 会话、
 * 共用的登录态、同一份配额。默认值、探测顺序都跟着这个顺序走。
 *
 * 「尽可能」不是「绝不」：只装了 claude adapter 的机器上仍然要能用。
 *
 * 这里曾经还有第三格 `provider.api`（直连模型厂商的 HTTP API）。
 * 它**一行实现都没有**，而界面能选、库里能存、跑起来必然失败；
 * `Model` 上的 `credentialRef` / `contextWindow` 也是为它准备的 ——
 * ACP 的登录态由 CLI 自己管，上下文窗口由 agent 自己知道。
 * 要重新支持直连 API 时，连同那几个字段一起加回来，别只加枚举值。
 */
export const AGENT_RUNTIMES = ['acp.codex', 'acp.claude'] as const;

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

/**
 * runtime 报上来的一个可选项（一个模型、一档推理深度）。
 *
 * **值不写死在契约里** —— 本机 CLI 一升级就会多出模型，
 * 而写死的枚举到那天会静默失效。所以这里只规定形状，
 * 具体候选由 `model.sync` 现问现拿。
 *
 * 校验也不必我们做：设一个不在候选里的值，agent 自己会拒
 * （实测 codex `-32602` / claude `-32603`）。
 */
export const ConfigChoiceSchema = z.object({
  /** 发给 agent 的那个值，如 `gpt-5.6-sol` / `high`。 */
  value: z.string().min(1),
  /** 给人看的名字，如 `GPT-5.6-Sol`。agent 自己给的。 */
  label: z.string().default(''),
  description: z.string().default(''),
});
export type ConfigChoice = z.infer<typeof ConfigChoiceSchema>;

/**
 * Agent 向用户提的一个问题。
 *
 * **组件目录是白名单**：agent 只能从这几种里挑一个、填数据，
 * 碰不到布局也发明不了新组件。让它返回 HTML 或任意 UI spec 的话，
 * 渲染通道就与它的权限面接在了一起 —— 而这个 agent 连着系统 MCP，
 * 能读工作流、能改草稿。
 *
 * 认不出的 `kind` 由界面降级成纯文本显示原文，**不静默吞掉**：
 * 用户至少要知道 agent 问了什么。
 */
export const ASK_KINDS = ['choice', 'multiChoice', 'form', 'confirm'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const AskOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  /** 补充说明。选项之间的差别常常不在标题上。 */
  description: z.string().default(''),
});

export const AskFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  /** 多行输入。补一段背景与填一个分支名不是一回事。 */
  multiline: z.boolean().default(false),
  required: z.boolean().default(false),
  placeholder: z.string().default(''),
});

export const AskSpecSchema = z.object({
  /**
   * 组件类型。合法值是 `ASK_KINDS`，但这里**故意不用 `z.enum`**。
   *
   * agent 是独立进程，版本可能比界面新。用枚举的话，一个界面还不认识的
   * `kind` 会在 Core API 门口就被 Zod 拒掉 —— 于是那条提问根本到不了界面，
   * 用户什么都看不到，而 agent 那边还挂着等回答。
   *
   * 白名单放在**界面层**：认得的渲染成组件，认不出的摊开原文，
   * 而「不回答」这条路始终可用。
   */
  kind: z.string().min(1),
  /** 一句话说清在问什么。它是卡片的标题。 */
  title: z.string().min(1),
  /** 为什么问。用户凭它判断该选哪个。 */
  detail: z.string().default(''),
  /** `choice` / `multiChoice` 用。 */
  options: z.array(AskOptionSchema).default([]),
  /** `form` 用。 */
  fields: z.array(AskFieldSchema).default([]),
  /** `multiChoice` 的默认勾选。 */
  defaults: z.array(z.string()).default([]),
});
export type AskSpec = z.infer<typeof AskSpecSchema>;

/**
 * 用户的回答。
 *
 * 三个字段按 `kind` 用其一 —— 合成一个联合类型会让 Rust 侧的
 * 反序列化跟着分叉，而这里的取舍是「两侧都好写」。
 */
export const AskAnswerSchema = z.object({
  /** `choice` 选中的那个 value；`confirm` 用固定值 `yes` / `no`。 */
  selected: z.string().optional(),
  /** `multiChoice` 选中的那些。 */
  selectedMany: z.array(z.string()).default([]),
  /** `form` 填的内容。 */
  fields: z.record(z.string(), z.string()).default({}),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: z.enum(AGENT_RUNTIMES),
  modelId: z.string().min(1),
  /** 同一模型的不同推理档位登记为不同条目，运行记录才能区分。 */
  effort: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),
  /**
   * 0 = 未知。`model.sync` 同步来的条目拿不到窗口大小（claude 报模型窗口、
   * codex 报会话水位，两端语义不同，编一个数字更糟），store 端故意写 0。
   * 手动登记仍要求为正 —— model.create 的入参单独收紧了这个字段。
   */
  contextWindow: z.number().int().nonnegative(),
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

/**
 * 缺工具时给的一条可复制命令。
 *
 * 应用**自己不装任何东西**：替用户执行下载意味着要为「从哪下载、
 * 怎么校验签名、装坏了怎么回滚」全都做决定，而每个决定都是新的攻击面。
 */
export const InstallHintSchema = z.object({
  /** 复制得走的一行。绝不含 sudo。 */
  command: z.string().min(1),
  /** 出处。「复制这行到终端」是让用户执行我们给的代码，得说清它哪来的。 */
  source: z.string().min(1),
  url: z.string().url().optional(),
});
export type InstallHint = z.infer<typeof InstallHintSchema>;

export const EnvHealthItemSchema = z.object({
  capability: z.string().min(1),
  /** 面向用户的名字。capability 是 id，界面显示的是这个。 */
  label: z.string().min(1),
  version: z.string().optional(),
  path: z.string().optional(),
  source: z.enum(['system', 'app_managed', 'missing']),
  status: z.enum(['ready', 'needs_attention', 'optional', 'missing']),
  detail: z.string().optional(),
  /** 缺了才给。已就绪还给的话用户会以为该重装。 */
  installHint: InstallHintSchema.optional(),
});
export type EnvHealthItem = z.infer<typeof EnvHealthItemSchema>;

/**
 * 主管 AI 的一次会话。
 *
 * 图纸要求历史列表「按关联的工作流 / 运行 / 记忆 / 模型标注」——
 * 关联对象都是可选的：不在任何上下文里问的问题（「这个应用怎么用」）
 * 也是一次会话。
 */
export const SupervisorSessionSchema = z.object({
  id: z.string().min(1),
  /** 取第一个问题的前几十字。用户靠它认出「上次那条」。 */
  title: z.string().min(1),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messageCount: z.number().int().min(0),
  workflowId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  modelRef: z.string().min(1).optional(),
});
export type SupervisorSession = z.infer<typeof SupervisorSessionSchema>;

export const SupervisorMessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
  at: z.iso.datetime(),
});
export type SupervisorMessage = z.infer<typeof SupervisorMessageSchema>;
