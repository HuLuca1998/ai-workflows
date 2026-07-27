import { z } from 'zod';
import { CapabilitiesSchema, NO_CAPABILITIES, type Capabilities } from '../capabilities.js';

/**
 * 节点定义 Schema —— M0 冻结物之一。
 *
 * 配置弹层的表单由 configSchema 驱动渲染，新增节点类型不改 UI 代码（功能文档 §14）。
 * 执行语义（并行 / 汇聚）由连线决定，不写在节点配置里（功能文档 §3.1）。
 */

export const NODE_TYPES = [
  'ai.analyze',
  'ai.review',
  'ai.decide',
  'ai.execute',
  'entry',
  'subworkflow',
  'branch',
  'transform',
  'end',
  'approval',
  'notify',
  'script.shell',
  'script.python',
  'git.worktree',
  'env',
  'mcp.tool',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_GROUPS = ['ai', 'flow', 'human', 'execution', 'integration'] as const;
export type NodeGroup = (typeof NODE_GROUPS)[number];

export interface Port {
  id: string;
  label: string;
}

export interface NodeDefinition {
  type: NodeType;
  title: string;
  group: NodeGroup;
  summary: string;
  configSchema: z.ZodType;
  ports: { inputs: Port[]; outputs: Port[] };
  /** 输出端口由配置决定（条件分支）；UI 据此禁用静态端口渲染。 */
  dynamicOutputs?: boolean;
  resolveOutputs?: (config: unknown) => Port[];
  /** 节点默认申请的能力，可在配置弹层收紧，但不能静默扩大 Agent 角色的授权。 */
  defaultCapabilities: Capabilities;
  /** 会对外部世界产生写操作（push / PR / 删除 / 第三方调用），重试前需核对外部状态。 */
  externalWrite: boolean;
  /** 全图唯一（入口节点）。 */
  singleton?: boolean;
}

const IN: Port = { id: 'input', label: 'input' };
const caps = (patch: Partial<Capabilities>): Capabilities =>
  CapabilitiesSchema.parse({ ...NO_CAPABILITIES, ...patch });

// ── 通用片段 ────────────────────────────────────────────────────────────────

/** 模型选择：要么给策略档位，要么直接钉住某个已登记模型。 */
const ModelPolicySchema = z.union([
  z.enum(['fast', 'balanced', 'quality']),
  z.object({ modelId: z.string().min(1) }),
]);

const OutputContractSchema = z.object({
  documents: z.enum(['single', 'multi']).default('multi'),
  /** 结构化摘要的 JSON Schema；要求 JSON 输出的节点只能选带「结构化输出」能力的模型。 */
  summarySchema: z.record(z.string(), z.unknown()).optional(),
});

/** 所有 AI 节点共有的字段：节点引用 Agent 角色，而不是复制一份 Prompt。 */
const AiBaseSchema = z.object({
  agentProfileId: z.string().min(1),
  instruction: z.string().min(1),
  promptId: z.string().min(1).optional(),
  modelPolicy: ModelPolicySchema.optional(),
  turnLimit: z.number().int().positive().default(12),
  outputContract: OutputContractSchema.optional(),
});

const JsonSchemaObject = z.record(z.string(), z.unknown());

// ── 定义表 ──────────────────────────────────────────────────────────────────

const DEFINITIONS: Record<NodeType, NodeDefinition> = {
  'ai.analyze': {
    type: 'ai.analyze',
    title: 'AI · 分析',
    group: 'ai',
    summary: '读取分析对象，产出多篇 Markdown 与结构化摘要',
    configSchema: AiBaseSchema.extend({
      target: z.string().min(1),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'insufficient_context', label: 'insufficient_context' },
      ],
    },
    defaultCapabilities: caps({ file: 'read', memory: 'read' }),
    externalWrite: false,
  },

  'ai.review': {
    type: 'ai.review',
    title: 'AI · 审查',
    group: 'ai',
    summary: '按清单审查对象，输出分级问题与结论',
    configSchema: AiBaseSchema.extend({
      target: z.string().min(1),
      checklist: z.array(z.string().min(1)).default([]),
      severities: z.array(z.enum(['blocker', 'major', 'minor'])).default(['blocker', 'major', 'minor']),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'passed', label: 'passed' },
        { id: 'changes_requested', label: 'changes_requested' },
      ],
    },
    defaultCapabilities: caps({ file: 'read', memory: 'read' }),
    externalWrite: false,
  },

  'ai.decide': {
    type: 'ai.decide',
    title: 'AI · 决策',
    group: 'ai',
    summary: 'L1–L3 分级判定，超出自动层级则转人工',
    configSchema: AiBaseSchema.extend({
      rules: z
        .array(
          z.object({
            level: z.enum(['L1', 'L2', 'L3']),
            when: z.string().min(1),
            then: z.string().min(1),
          }),
        )
        .default([]),
      /** 默认 L1–L2 自动决策，L3 通知用户转人工（功能文档 §3.2）。 */
      autoDecideUpTo: z.enum(['L1', 'L2', 'L3']).default('L2'),
      onTimeout: z.enum(['escalate', 'fail']).default('escalate'),
      decisionSchema: JsonSchemaObject.optional(),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'auto_decided', label: 'auto_decided' },
        { id: 'escalated', label: 'escalated' },
      ],
    },
    defaultCapabilities: caps({ memory: 'read' }),
    externalWrite: false,
  },

  'ai.execute': {
    type: 'ai.execute',
    title: 'AI · 执行',
    group: 'ai',
    summary: '在引擎指定的工作目录内改代码并跑验证命令',
    configSchema: AiBaseSchema.extend({
      /** 工作目录由引擎决定，Prompt 不能改变安全边界（技术选型 §5）。 */
      workdirSource: z.enum(['inherit', 'worktree', 'declared']).default('worktree'),
      verifyCommands: z.array(z.string().min(1)).default([]),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
        { id: 'needs_decision', label: 'needs_decision' },
      ],
    },
    defaultCapabilities: caps({ file: 'read-write', command: 'declared', memory: 'read' }),
    externalWrite: false,
  },

  entry: {
    type: 'entry',
    title: '入口设置',
    group: 'flow',
    summary: '触发方式、工作目录来源与输入参数 Schema（启动表单由它生成）',
    configSchema: z.object({
      trigger: z.enum(['manual', 'shortcut', 'url_scheme', 'schedule', 'webhook']).default('manual'),
      workdirSource: z.enum(['prompt', 'fixed', 'inherit']).default('prompt'),
      workdir: z.string().optional(),
      inputSchema: JsonSchemaObject,
      injectedFields: z.array(z.string().min(1)).default([]),
    }),
    ports: { inputs: [], outputs: [{ id: 'success', label: 'success' }] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
    singleton: true,
  },

  subworkflow: {
    type: 'subworkflow',
    title: '调用子工作流',
    group: 'flow',
    summary: '同步或并行多实例调用另一个工作流，子 Run 独立会话与环境快照',
    configSchema: z.object({
      workflowId: z.string().min(1),
      versionRef: z.string().min(1),
      mode: z.enum(['sync', 'parallel']).default('sync'),
      inputMapping: z.record(z.string(), z.string()).default({}),
      outputMapping: z.record(z.string(), z.string()).default({}),
      concurrencyLimit: z.number().int().positive().default(1),
      onFailure: z.enum(['fail_parent', 'continue', 'retry']).default('fail_parent'),
      /** 审批冒泡到父运行还是子运行自理。 */
      approvalInheritance: z.enum(['inherit', 'isolate']).default('inherit'),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
      ],
    },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  branch: {
    type: 'branch',
    title: '条件分支',
    group: 'flow',
    summary: '按结构化字段分流，端口由配置决定',
    configSchema: z.object({
      cases: z
        .array(z.object({ port: z.string().min(1), when: z.string().min(1) }))
        .min(1),
      defaultPort: z.string().min(1).default('default'),
    }),
    ports: { inputs: [IN], outputs: [{ id: 'default', label: 'default' }] },
    dynamicOutputs: true,
    resolveOutputs: (config) => {
      const parsed = z
        .object({
          cases: z.array(z.object({ port: z.string() })).default([]),
          defaultPort: z.string().default('default'),
        })
        .safeParse(config);
      if (!parsed.success) return [{ id: 'default', label: 'default' }];
      const ports = parsed.data.cases.map((c) => ({ id: c.port, label: c.port }));
      return [...ports, { id: parsed.data.defaultPort, label: parsed.data.defaultPort }];
    },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  transform: {
    type: 'transform',
    title: '数据转换',
    group: 'flow',
    summary: 'JSONPath 映射与输出 Schema',
    configSchema: z.object({
      mappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(1),
      outputSchema: JsonSchemaObject.optional(),
    }),
    ports: { inputs: [IN], outputs: [{ id: 'success', label: 'success' }] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  end: {
    type: 'end',
    title: '结束',
    group: 'flow',
    summary: '标记成功失败与最终产物',
    configSchema: z.object({
      outcome: z.enum(['success', 'failure']),
      artifacts: z.array(z.string().min(1)).default([]),
    }),
    ports: { inputs: [IN], outputs: [] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  approval: {
    type: 'approval',
    title: '人工审批',
    group: 'human',
    summary: '把决定权交回给人：单选 / 多选 / 确认 / 补充',
    configSchema: z.object({
      title: z.string().min(1),
      bodyMarkdown: z.string().default(''),
      interaction: z.enum(['single', 'multi', 'confirm', 'supplement']),
      options: z
        .array(z.object({ id: z.string().min(1), label: z.string().min(1), recommended: z.boolean().default(false) }))
        .default([]),
      waitStrategy: z.enum(['forever', 'timeout']).default('forever'),
      timeoutMs: z.number().int().positive().optional(),
      reminderAfterMs: z.number().int().positive().optional(),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'approved', label: 'approved' },
        { id: 'changes_requested', label: 'changes_requested' },
        { id: 'rejected', label: 'rejected' },
        { id: 'expired', label: 'expired' },
      ],
    },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  notify: {
    type: 'notify',
    title: '系统通知',
    group: 'human',
    summary: 'macOS 系统通知，点击可跳回运行',
    configSchema: z.object({
      title: z.string().min(1),
      subtitle: z.string().optional(),
      body: z.string().min(1),
      on: z
        .array(z.enum(['completed', 'failed', 'waiting_approval', 'cancelled']))
        .default(['completed', 'failed', 'waiting_approval']),
      clickAction: z.enum(['open_run', 'open_workflow', 'none']).default('open_run'),
      onFailure: z.enum(['ignore', 'fail_node', 'retry']).default('ignore'),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
      ],
    },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  'script.shell': {
    type: 'script.shell',
    title: 'Shell 脚本',
    group: 'execution',
    summary: '非交互执行，带超时与输出上限',
    configSchema: z.object({
      /** 解释器是白名单：任意可执行文件会绕过命令能力声明。 */
      interpreter: z.enum(['zsh', 'bash', 'sh']),
      script: z.string().min(1),
      workdir: z.string().optional(),
      env: z.record(z.string(), z.string()).default({}),
      /** 环境映射里引用 Secret 用 keychain:// 前缀，明文永不入库。 */
      secretEnv: z.record(z.string(), z.string()).default({}),
      outputParse: z.enum(['none', 'json', 'lines']).default('none'),
      successExitCodes: z.array(z.number().int()).default([0]),
      outputLimitBytes: z.number().int().positive().default(1_048_576),
      timeoutMs: z.number().int().positive().default(900_000),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
      ],
    },
    defaultCapabilities: caps({ file: 'read-write', command: 'declared' }),
    externalWrite: false,
  },

  'script.python': {
    type: 'script.python',
    title: 'Python 脚本',
    group: 'execution',
    summary: '用 App 管理的独立 Python 运行时执行，不依赖系统 Python',
    configSchema: z.object({
      interpreter: z.enum(['python3', 'uv']),
      script: z.string().min(1),
      workdir: z.string().optional(),
      env: z.record(z.string(), z.string()).default({}),
      secretEnv: z.record(z.string(), z.string()).default({}),
      outputParse: z.enum(['none', 'json', 'lines']).default('none'),
      successExitCodes: z.array(z.number().int()).default([0]),
      outputLimitBytes: z.number().int().positive().default(1_048_576),
      timeoutMs: z.number().int().positive().default(900_000),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
      ],
    },
    defaultCapabilities: caps({ file: 'read-write', command: 'declared' }),
    externalWrite: false,
  },

  'git.worktree': {
    type: 'git.worktree',
    title: 'Git worktree',
    group: 'execution',
    summary: '在隔离 worktree 里工作，绝不污染当前分支',
    configSchema: z.object({
      repoRoot: z.string().min(1),
      baseBranch: z.string().min(1),
      branchTemplate: z.string().min(1).default('aiwf/${run.id}'),
      parentDir: z.string().min(1).default('~/worktrees'),
      fetch: z.boolean().default(true),
      conflictPolicy: z.enum(['fail', 'reuse', 'suffix']).default('suffix'),
      cleanupPolicy: z.enum(['keep', 'on_success', 'on_run_end', 'manual']).default('on_success'),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
      ],
    },
    defaultCapabilities: caps({ file: 'read-write', command: 'declared' }),
    externalWrite: false,
  },

  env: {
    type: 'env',
    title: '环境变量',
    group: 'execution',
    summary: '按作用域读写删环境变量，可导出 .env',
    configSchema: z.object({
      operations: z
        .array(
          z.object({
            op: z.enum(['set', 'unset', 'read']),
            key: z.string().min(1),
            value: z.string().optional(),
            scope: z.enum(['node', 'run', 'workflow', 'global']).default('run'),
          }),
        )
        .min(1),
      exportDotenv: z.boolean().default(false),
    }),
    ports: { inputs: [IN], outputs: [{ id: 'success', label: 'success' }] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
  },

  'mcp.tool': {
    type: 'mcp.tool',
    title: 'MCP 工具',
    group: 'integration',
    summary: '调用外部 MCP Server 的白名单工具',
    configSchema: z.object({
      serverId: z.string().min(1),
      toolAllowlist: z.array(z.string().min(1)).min(1),
      args: z.record(z.string(), z.unknown()).default({}),
      scopes: z.array(z.string().min(1)).default([]),
    }),
    ports: {
      inputs: [IN],
      outputs: [
        { id: 'success', label: 'success' },
        { id: 'failed', label: 'failed' },
      ],
    },
    defaultCapabilities: caps({ network: 'allowlist' }),
    // 外部工具可能建 PR、发消息、删数据：一律按外部写操作对待
    externalWrite: true,
  },
};

/** 画布左侧节点库：15 条目录项（Shell 与 Python 脚本合并展示为一条）。 */
export interface NodeLibraryEntry {
  id: string;
  group: NodeGroup;
  label: string;
  summary: string;
  types: NodeType[];
}

export const NODE_LIBRARY: readonly NodeLibraryEntry[] = [
  { id: 'ai.analyze', group: 'ai', label: 'AI · 分析', summary: DEFINITIONS['ai.analyze'].summary, types: ['ai.analyze'] },
  { id: 'ai.review', group: 'ai', label: 'AI · 审查', summary: DEFINITIONS['ai.review'].summary, types: ['ai.review'] },
  { id: 'ai.decide', group: 'ai', label: 'AI · 决策', summary: DEFINITIONS['ai.decide'].summary, types: ['ai.decide'] },
  { id: 'ai.execute', group: 'ai', label: 'AI · 执行', summary: DEFINITIONS['ai.execute'].summary, types: ['ai.execute'] },
  { id: 'entry', group: 'flow', label: '入口设置', summary: DEFINITIONS.entry.summary, types: ['entry'] },
  { id: 'subworkflow', group: 'flow', label: '调用子工作流', summary: DEFINITIONS.subworkflow.summary, types: ['subworkflow'] },
  { id: 'branch', group: 'flow', label: '条件分支', summary: DEFINITIONS.branch.summary, types: ['branch'] },
  { id: 'transform', group: 'flow', label: '数据转换', summary: DEFINITIONS.transform.summary, types: ['transform'] },
  { id: 'end', group: 'flow', label: '结束', summary: DEFINITIONS.end.summary, types: ['end'] },
  { id: 'approval', group: 'human', label: '人工审批', summary: DEFINITIONS.approval.summary, types: ['approval'] },
  { id: 'notify', group: 'human', label: '系统通知', summary: DEFINITIONS.notify.summary, types: ['notify'] },
  {
    id: 'script',
    group: 'execution',
    label: 'Shell / Python 脚本',
    summary: '非交互执行，带超时与输出上限',
    types: ['script.shell', 'script.python'],
  },
  { id: 'git.worktree', group: 'execution', label: 'Git worktree', summary: DEFINITIONS['git.worktree'].summary, types: ['git.worktree'] },
  { id: 'env', group: 'execution', label: '环境变量', summary: DEFINITIONS.env.summary, types: ['env'] },
  { id: 'mcp.tool', group: 'integration', label: 'MCP 工具', summary: DEFINITIONS['mcp.tool'].summary, types: ['mcp.tool'] },
] as const;

export function getNodeDefinition(type: NodeType): NodeDefinition {
  const def = DEFINITIONS[type];
  if (!def) {
    throw new Error(`未登记的节点类型：${type}`);
  }
  return def;
}

export function listNodeDefinitions(): NodeDefinition[] {
  return NODE_TYPES.map((t) => DEFINITIONS[t]);
}

/** 端口解析：静态端口直接返回，动态端口（条件分支）按当前配置推导。 */
export function resolveNodeOutputs(type: NodeType, config: unknown): Port[] {
  const def = getNodeDefinition(type);
  return def.resolveOutputs ? def.resolveOutputs(config) : def.ports.outputs;
}
