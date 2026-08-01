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

/**
 * 「输出端口由配置里的哪个字段决定」的声明。
 *
 * 端口 = 数组字段里每项的端口名，再加一个兜底端口。
 * 只够表达条件分支这一种形态 —— 够用就行：多出来的表达力
 * 会变成 Rust 侧要跟着实现的第二套解释器。
 */
export interface DynamicOutputRule {
  /** 配置里存放分支的数组字段名。 */
  casesField: string;
  /** 数组每一项里当端口名用的字段。 */
  portField: string;
  /** 配置里存放兜底端口名的字段。 */
  defaultPortField: string;
  /** 兜底端口字段缺席或为空时用它。 */
  fallbackPort: string;
}

export interface NodeDefinition {
  type: NodeType;
  title: string;
  group: NodeGroup;
  summary: string;
  configSchema: z.ZodType;
  ports: { inputs: Port[]; outputs: Port[] };
  /**
   * 输出端口由配置决定（条件分支）；UI 据此禁用静态端口渲染。
   *
   * **是一份声明，不是一个闭包。** 写成 `(config) => Port[]` 的话
   * 这条规则就只有 TypeScript 会算 —— 而 Rust 侧要校验一张图的连线，
   * 就得知道「这个分支节点现在有哪几个输出端口」。函数过不了语言边界，
   * 于是那边只能猜，猜的结果是界面说连得上、引擎说没这个端口。
   *
   * 声明由 `resolveNodeOutputs` 解释；生成物把同一份声明交给 Rust，
   * `tests/node-catalog.test.ts` 盯着两边对同一份配置给出同一组端口。
   */
  dynamicOutputs?: DynamicOutputRule;
  /** 节点默认申请的能力，可在配置弹层收紧，但不能静默扩大 Agent 角色的授权。 */
  defaultCapabilities: Capabilities;
  /** 会对外部世界产生写操作（push / PR / 删除 / 第三方调用），重试前需核对外部状态。 */
  externalWrite: boolean;
  /**
   * 引擎真的能执行它吗。
   *
   * 这份表态原来只活在 `crates/engine/src/preflight.rs` 的 Rust 常量里，
   * 界面拿不到 —— 于是节点库照常列出 16 种、拖得进画布、配置表单
   * 字段齐全可填可存，**只字不提其中 6 种跑不了**，直到用户搭完整条
   * 流程点了「运行」，Dry Run 才说「尚未实现，运行会在这个节点停下」。
   *
   * 放进契约之后 UI 能在**拖之前**就标出来。Rust 侧读生成物比，
   * 两边对不上时 `contract_sync_test` 变红。
   */
  implemented: boolean;
  /** 全图唯一（入口节点）。 */
  singleton?: boolean;
  /**
   * Phosphor 图标类名。节点库与画布上的节点都用它。
   *
   * 放在契约里而不是 UI 的一张 `Record<NodeType, string>`：那张表
   * 是**强制**的（Record 要求每个键都在），新增节点类型时 CI 直接打回 ——
   * 而 CLAUDE.md 的承诺是「新增节点类型不改 UI 代码」。
   */
  icon: string;
  /**
   * 必填字段的占位值。
   *
   * 拖进画布时用它填一份能过 configSchema 的初始配置。没有的话
   * 节点**加不进来** —— 用户看到一句「节点配置不合法」，而他什么都还没填。
   *
   * 可选字段的默认值由 Zod 的 `.default()` 表达，不用写在这儿。
   */
  seed?: Record<string, unknown>;
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
  documents: z.enum(['single', 'multi']).default('multi').describe('产出文档数量'),
  summarySchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('结构化摘要 Schema\n要求 JSON 输出的节点只能选带「结构化输出」能力的模型'),
});

/** 所有 AI 节点共有的字段：节点引用 Agent 角色，而不是复制一份 Prompt。 */
const AiBaseSchema = z.object({
  agentProfileId: z
    .string()
    .min(1)
    // reference：表单据此渲染成「从库里选」而不是自由文本 ——
    // 手打内部 id 是三轮实测里最一致的阻断点（S4/P5/#3）
    .meta({ reference: 'agentProfile' })
    .describe('Agent 角色\n节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效'),
  instruction: z.string().min(1).meta({ long: true }).describe('任务指令'),
  promptId: z
    .string()
    .min(1)
    .optional()
    .meta({ reference: 'prompt' })
    .describe('提示词\n留空则用该节点类型的内建提示词'),
  modelPolicy: ModelPolicySchema.optional().describe(
    '模型策略\n按档位（fast / balanced / quality）从「模型」页已启用的条目里挑；' +
      '要的给不了会写入 RunEvent 降级事件，不静默替换',
  ),
  turnLimit: z.number().int().positive().default(12).describe('Turn 上限'),
  outputContract: OutputContractSchema.optional().describe('输出契约'),
});

const JsonSchemaObject = z.record(z.string(), z.unknown());

// ── 定义表 ──────────────────────────────────────────────────────────────────

const DEFINITIONS: Record<NodeType, NodeDefinition> = {
  'ai.analyze': {
    type: 'ai.analyze',
    icon: 'ph-magnifying-glass',
    seed: { agentProfileId: '待选择角色', instruction: '待填写指令', target: '待填写对象' },
    title: 'AI · 分析',
    group: 'ai',
    summary: '读取分析对象，产出多篇 Markdown 与结构化摘要',
    configSchema: AiBaseSchema.extend({
      target: z.string().min(1).describe('分析对象'),
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
    implemented: true,
  },

  'ai.review': {
    type: 'ai.review',
    icon: 'ph-eyes',
    seed: { agentProfileId: '待选择角色', instruction: '待填写指令', target: '待填写对象' },
    title: 'AI · 审查',
    group: 'ai',
    summary: '按清单审查对象，输出分级问题与结论',
    configSchema: AiBaseSchema.extend({
      target: z.string().min(1).describe('审查对象'),
      checklist: z.array(z.string().min(1)).default([]).describe('审查清单'),
      severities: z
        .array(z.enum(['blocker', 'major', 'minor']))
        .default(['blocker', 'major', 'minor'])
        .describe('严重度分级'),
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
    implemented: true,
  },

  'ai.decide': {
    type: 'ai.decide',
    icon: 'ph-scales',
    seed: { agentProfileId: '待选择角色', instruction: '待填写指令' },
    title: 'AI · 决策',
    group: 'ai',
    summary: 'L1–L3 分级判定，超出自动层级则转人工',
    configSchema: AiBaseSchema.extend({
      // 字段刻意叫 action 而非 then：带 then 的对象会被 await 当成 thenable，
      // 而节点配置会在 IPC / MCP 之间来回传递，撞上 await 只是时间问题
      rules: z
        .array(
          z.object({
            level: z.enum(['L1', 'L2', 'L3']),
            when: z.string().min(1),
            action: z.string().min(1),
          }),
        )
        .default([])
        .describe('分级规则'),
      autoDecideUpTo: z
        .enum(['L1', 'L2', 'L3'])
        .default('L2')
        .describe('可自动决策层级\n默认 L1–L2 自动决策，L3 通知用户转人工'),
      onTimeout: z.enum(['escalate', 'fail']).default('escalate').describe('超时未决处理'),
      decisionSchema: JsonSchemaObject.optional().describe('决策输出 Schema'),
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
    implemented: true,
  },

  'ai.execute': {
    type: 'ai.execute',
    icon: 'ph-hammer',
    seed: { agentProfileId: '待选择角色', instruction: '待填写指令' },
    title: 'AI · 执行',
    group: 'ai',
    summary: '在引擎指定的工作目录内改代码并跑验证命令',
    configSchema: AiBaseSchema.extend({
      workdirSource: z
        .enum(['inherit', 'worktree', 'declared'])
        .default('worktree')
        .describe('工作目录来源\n引擎决定它，Prompt 改不了；它设的是 cwd，不管 agent 读写哪里'),
      verifyCommands: z.array(z.string().min(1)).default([]).describe('验证命令'),
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
    implemented: true,
  },

  entry: {
    type: 'entry',
    icon: 'ph-sign-in',
    seed: { trigger: 'manual', inputSchema: { type: 'object' } },
    title: '入口设置',
    group: 'flow',
    summary: '触发方式、工作目录来源与输入参数 Schema（启动表单由它生成）',
    configSchema: z.object({
      /*
       * 枚举里原来还有 shortcut / url_scheme / webhook 三项。删掉了：
       * 引擎侧 `grep trigger` 零命中，选中它们的唯一效果是画布上多显示
       * 一行「触发：webhook」，到点什么都不发生 —— 正是「填了不生效」。
       * 真要做的时候再加回来，连同 `crates/engine/src/schedule.rs` 的分支。
       */
      trigger: z.enum(['manual', 'schedule', 'interval']).default('manual').describe('触发方式'),
      scheduleTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, '要写成 HH:MM（24 小时制），例如 09:30')
        .optional()
        .describe('每天几点\n仅当触发方式选 schedule 时生效；按本机时区'),
      intervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(60 * 24 * 7)
        .optional()
        .describe('每隔多少分钟\n仅当触发方式选 interval 时生效；最小 1 分钟'),
      workdirSource: z
        .enum(['prompt', 'fixed', 'inherit'])
        .default('prompt')
        .describe('工作目录来源'),
      workdir: z.string().optional().describe('固定工作目录\n仅当来源选 fixed 时生效'),
      inputSchema: JsonSchemaObject.describe('输入参数 Schema\n启动表单按它自动生成'),
      injectedFields: z.array(z.string().min(1)).default([]).describe('系统注入字段'),
    }),
    ports: { inputs: [], outputs: [{ id: 'success', label: 'success' }] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
    implemented: true,
    singleton: true,
  },

  subworkflow: {
    type: 'subworkflow',
    icon: 'ph-tree-structure',
    seed: { workflowId: '待选择工作流', versionRef: 'latest' },
    title: '调用子工作流',
    group: 'flow',
    summary: '同步或并行多实例调用另一个工作流，子 Run 独立会话与环境快照',
    configSchema: z.object({
      workflowId: z.string().min(1).describe('目标工作流'),
      versionRef: z.string().min(1).describe('运行版本\nlatest 或具体版本号'),
      mode: z.enum(['sync', 'parallel']).default('sync').describe('调用方式'),
      inputMapping: z.record(z.string(), z.string()).default({}).describe('输入映射'),
      outputMapping: z.record(z.string(), z.string()).default({}).describe('输出映射'),
      concurrencyLimit: z.number().int().positive().default(1).describe('并发上限'),
      onFailure: z
        .enum(['fail_parent', 'continue', 'retry'])
        .default('fail_parent')
        .describe('失败策略'),
      approvalInheritance: z
        .enum(['inherit', 'isolate'])
        .default('inherit')
        .describe('审批继承\ninherit 时子运行的审批冒泡到父运行'),
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
    implemented: false,
  },

  branch: {
    type: 'branch',
    icon: 'ph-git-fork',
    seed: { cases: [{ port: 'case_1', when: '待填写条件' }] },
    title: '条件分支',
    group: 'flow',
    summary: '按结构化字段分流，端口由配置决定',
    configSchema: z.object({
      cases: z
        .array(z.object({ port: z.string().min(1), when: z.string().min(1) }))
        .min(1)
        .describe('分支条件\n每条对应一个输出端口'),
      defaultPort: z.string().min(1).default('default').describe('兜底端口'),
    }),
    ports: { inputs: [IN], outputs: [{ id: 'default', label: 'default' }] },
    dynamicOutputs: {
      casesField: 'cases',
      portField: 'port',
      defaultPortField: 'defaultPort',
      fallbackPort: 'default',
    },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
    implemented: false,
  },

  transform: {
    type: 'transform',
    icon: 'ph-shuffle',
    seed: { mappings: [{ from: '$.待填写', to: '待填写' }] },
    title: '数据转换',
    group: 'flow',
    summary: 'JSONPath 映射与输出 Schema',
    configSchema: z.object({
      mappings: z
        .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
        .min(1)
        .describe('字段映射\nfrom 用 JSONPath 取值'),
      outputSchema: JsonSchemaObject.optional().describe('输出 Schema'),
    }),
    ports: { inputs: [IN], outputs: [{ id: 'success', label: 'success' }] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
    implemented: false,
  },

  end: {
    type: 'end',
    icon: 'ph-flag-checkered',
    seed: { outcome: 'success' },
    title: '结束',
    group: 'flow',
    summary: '标记成功失败与最终产物',
    configSchema: z.object({
      outcome: z.enum(['success', 'failure']).describe('运行结果'),
      artifacts: z.array(z.string().min(1)).default([]).describe('最终产物'),
    }),
    ports: { inputs: [IN], outputs: [] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
    implemented: true,
  },

  approval: {
    type: 'approval',
    icon: 'ph-user-check',
    seed: { title: '待填写标题', interaction: 'confirm' },
    title: '审批',
    group: 'human',
    summary: '流程上的一道门：由你批，或由另一个 AI 批',
    configSchema: z.object({
      title: z.string().min(1).describe('审批标题'),
      bodyMarkdown: z.string().default('').meta({ long: true }).describe('审批内容\n支持 Markdown'),
      interaction: z.enum(['single', 'multi', 'confirm', 'supplement']).describe('交互类型'),
      /**
       * 谁来批这一道门。
       *
       * **权限由流程管，不由节点各自管**：执行节点拿到的是最高权限，
       * 要不要停下来问由工作流的形状决定 —— 在「探索完成 → 开始编辑」
       * 之间、在「编码完成 → 开 PR」之间放一道门，就是在那两处设了关卡。
       *
       * `auto` 跟随设置里的全局档位。显式写 `user` / `ai` 的节点
       * 表达的是「这一道我要求由谁批」，全局档位仍可覆盖它 ——
       * 「无人值守」的字面含义就是连标了 user 的也交给 AI。
       */
      decider: z
        .enum(['auto', 'user', 'ai'])
        .default('auto')
        .describe('谁来批\nauto 跟随设置里的全局档位'),
      /**
       * `decider: 'ai'` 时由哪个角色来批。
       *
       * 刻意与执行的角色分开：让写代码的那个 agent 自己批自己的改动，
       * 等于没有这道门。空着时用内置的审批者角色。
       */
      deciderAgentProfileId: z
        .string()
        .optional()
        .meta({ reference: 'agentProfile' })
        .describe('审批者角色\n留空用内置审批者；别填成执行那一个 —— 自己批自己等于没有门'),
      options: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            recommended: z.boolean().default(false),
          }),
        )
        .default([])
        .describe('可选项'),
      waitStrategy: z.enum(['forever', 'timeout']).default('forever').describe('等待策略'),
      timeoutMs: z.number().int().positive().optional().describe('等待超时（毫秒）'),
      reminderAfterMs: z.number().int().positive().optional().describe('提醒间隔（毫秒）'),
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
    implemented: true,
  },

  notify: {
    type: 'notify',
    icon: 'ph-bell-ringing',
    seed: { title: '待填写标题', body: '待填写正文' },
    title: '系统通知',
    group: 'human',
    summary: 'macOS 系统通知，点击可跳回运行',
    configSchema: z.object({
      title: z.string().min(1).describe('通知标题'),
      /**
       * macOS 的通知原生有副标题这一行，但 `tauri-plugin-notification`
       * 在桌面端只通 title / body / icon / sound（2.3.3 的 `desktop.rs`）。
       * 所以它被拼在正文的第一行 —— 显示得出来，位置不是原生那一行。
       */
      subtitle: z
        .string()
        .optional()
        .describe('副标题\n会显示在正文第一行（插件没有原生副标题的通路）'),
      body: z.string().min(1).meta({ long: true }).describe('通知正文'),
      /**
       * **引擎目前不读它。**
       *
       * 这个字段说的是「运行到什么状态时才发」，而节点是被上游连线
       * 带到的 —— 执行到这里时运行还没有终态，「completed」无从判断。
       * 要按运行状态发通知，得由调度器在运行收尾时统一处理，
       * 那是另一件事（不是这个节点的配置）。
       *
       * 照 CLAUDE.md 那条：填了不生效比报错更糟，所以在描述里直说。
       * 想控制「什么时候发」，用连线 —— 把 notify 接在成功分支还是
       * 失败分支上，那才是引擎真正照办的东西。
       */
      on: z
        .array(z.enum(['completed', 'failed', 'waiting_approval', 'cancelled']))
        .default(['completed', 'failed', 'waiting_approval'])
        .describe('触发条件\n引擎目前不读它，改了不会生效。用连线控制什么时候发'),
      clickAction: z
        .enum(['open_run', 'open_workflow', 'none'])
        .default('open_run')
        .describe('点击动作'),
      onFailure: z.enum(['ignore', 'fail_node', 'retry']).default('ignore').describe('失败处理'),
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
    implemented: true,
  },

  'script.shell': {
    type: 'script.shell',
    icon: 'ph-terminal-window',
    seed: { interpreter: 'zsh', script: '# 待填写命令' },
    title: 'Shell 脚本',
    group: 'execution',
    summary: '非交互执行，带超时与输出上限',
    configSchema: z.object({
      /** 解释器是白名单：任意可执行文件会绕过命令能力声明。 */
      interpreter: z
        .enum(['zsh', 'bash', 'sh'])
        .describe('解释器\n白名单：任意可执行文件会绕过命令能力声明'),
      /**
       * `${…}` 的值由引擎**加过引号**再替进来（`interp.rs` 的 shell_quote）——
       * 单引号内除了单引号本身没有元字符会被解释，所以 `;`、`$()`、反引号、
       * 换行全部失去特殊含义。
       *
       * 代价是脚本里不能再自己套一层引号。这句提示不是可有可无的：
       * 端到端验证里 AI 写出的第一版脚本是 `gh issue view "${input.issue}"`，
       * 于是命令收到的是 `"'1'"`，报「invalid issue format」——
       * 而错误信息离原因隔着一层引号。
       */
      script: z
        .string()
        .min(1)
        .meta({ long: true })
        .describe('脚本内容\n${…} 的值会自动加引号，脚本里不要再套一层'),
      workdir: z.string().optional().describe('工作目录'),
      env: z.record(z.string(), z.string()).default({}).describe('环境变量'),
      /** 环境映射里引用 Secret 用 keychain:// 前缀，明文永不入库。 */
      secretEnv: z
        .record(z.string(), z.string())
        .default({})
        .describe('凭据环境变量\n用 keychain:// 引用，明文永不入库'),
      outputParse: z.enum(['none', 'json', 'lines']).default('none').describe('输出解析'),
      successExitCodes: z.array(z.number().int()).default([0]).describe('成功退出码'),
      outputLimitBytes: z.number().int().positive().default(1_048_576).describe('输出上限（字节）'),
      timeoutMs: z.number().int().positive().default(900_000).describe('超时（毫秒）'),
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
    implemented: true,
  },

  'script.python': {
    type: 'script.python',
    icon: 'ph-file-py',
    seed: { interpreter: 'python3', script: '# 待填写脚本' },
    title: 'Python 脚本',
    group: 'execution',
    summary: '用 App 管理的独立 Python 运行时执行，不依赖系统 Python',
    configSchema: z.object({
      interpreter: z
        .enum(['python3', 'uv'])
        .describe('解释器\n用 App 管理的独立运行时，不依赖系统 Python'),
      script: z
        .string()
        .min(1)
        .meta({ long: true })
        .describe('脚本内容\n${…} 的值会自动加引号，脚本里不要再套一层'),
      workdir: z.string().optional().describe('工作目录'),
      env: z.record(z.string(), z.string()).default({}).describe('环境变量'),
      secretEnv: z
        .record(z.string(), z.string())
        .default({})
        .describe('凭据环境变量\n用 keychain:// 引用，明文永不入库'),
      outputParse: z.enum(['none', 'json', 'lines']).default('none').describe('输出解析'),
      successExitCodes: z.array(z.number().int()).default([0]).describe('成功退出码'),
      outputLimitBytes: z.number().int().positive().default(1_048_576).describe('输出上限（字节）'),
      timeoutMs: z.number().int().positive().default(900_000).describe('超时（毫秒）'),
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
    implemented: false,
  },

  'git.worktree': {
    type: 'git.worktree',
    icon: 'ph-git-branch',
    seed: { repoRoot: '待填写仓库根', baseBranch: 'main' },
    title: 'Git worktree',
    group: 'execution',
    summary: '在隔离 worktree 里工作，绝不污染当前分支',
    configSchema: z.object({
      repoRoot: z.string().min(1).describe('仓库根目录'),
      baseBranch: z.string().min(1).describe('基础分支'),
      branchTemplate: z.string().min(1).default('aiwf/${run.id}').describe('分支命名模板'),
      parentDir: z.string().min(1).default('~/worktrees').describe('父目录'),
      fetch: z.boolean().default(true).describe('创建前 fetch'),
      conflictPolicy: z.enum(['fail', 'reuse', 'suffix']).default('suffix').describe('冲突策略'),
      cleanupPolicy: z
        .enum(['keep', 'on_success', 'on_run_end', 'manual'])
        .default('on_success')
        .describe('清理策略'),
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
    implemented: true,
  },

  env: {
    type: 'env',
    icon: 'ph-sliders-horizontal',
    seed: { operations: [{ op: 'set', key: 'KEY', value: '', scope: 'run' }] },
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
        .min(1)
        .describe('变量操作'),
      exportDotenv: z.boolean().default(false).describe('导出 .env'),
    }),
    ports: { inputs: [IN], outputs: [{ id: 'success', label: 'success' }] },
    defaultCapabilities: NO_CAPABILITIES,
    externalWrite: false,
    implemented: false,
  },

  'mcp.tool': {
    type: 'mcp.tool',
    icon: 'ph-plugs-connected',
    seed: { serverId: '待选择 Server', toolAllowlist: ['待选择工具'] },
    title: 'MCP 工具',
    group: 'integration',
    summary: '调用外部 MCP Server 的白名单工具',
    configSchema: z.object({
      serverId: z.string().min(1).describe('MCP Server'),
      toolAllowlist: z.array(z.string().min(1)).min(1).describe('工具白名单'),
      args: z.record(z.string(), z.unknown()).default({}).describe('调用参数'),
      scopes: z.array(z.string().min(1)).default([]).describe('权限 Scope'),
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
    implemented: false,
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

/**
 * 节点库里合并展示的类型。
 *
 * 只有脚本一条：Shell 与 Python 在图纸的节点库里是同一个入口，
 * 拖进来之后再选解释器。其余类型一条对一条。
 */
const MERGED_ENTRIES = [
  {
    id: 'script',
    label: 'Shell / Python 脚本',
    summary: '非交互执行，带超时与输出上限',
    types: ['script.shell', 'script.python'] as NodeType[],
  },
] as const;

/**
 * 节点库（图纸「02 画布编辑器」左栏）。
 *
 * **从定义派生**，不是第二份清单：label 与 group 曾经手抄了一遍
 * definition，改了一边忘了另一边就会对不上，而没有任何东西会报错。
 * 现在唯一手写的是「哪些类型合并成一条」—— 那才是真正的差异。
 */
export const NODE_LIBRARY: readonly NodeLibraryEntry[] = (() => {
  const entries: NodeLibraryEntry[] = [];

  for (const type of NODE_TYPES) {
    const group = MERGED_ENTRIES.find((entry) => entry.types.includes(type));
    if (group) {
      // 合并组在它第一个成员出现的位置插入，保持图纸的顺序
      if (group.types[0] === type) {
        entries.push({
          id: group.id,
          group: DEFINITIONS[type].group,
          label: group.label,
          summary: group.summary,
          types: [...group.types],
        });
      }
      continue;
    }
    const definition = DEFINITIONS[type];
    entries.push({
      id: type,
      group: definition.group,
      label: definition.title,
      summary: definition.summary,
      types: [type],
    });
  }
  return entries;
})();

/**
 * 引擎真的能执行的那几种。
 *
 * 从各定义的 `implemented` 算出来，不再手写第二份清单 ——
 * 手写的那份（`crates/engine/src/preflight.rs`）曾经与 executor 的
 * match 分派各自维护、零一致性检查，`notify` 就是那么混进去的。
 */
export const IMPLEMENTED_NODE_TYPES: readonly NodeType[] = NODE_TYPES.filter(
  (type) => DEFINITIONS[type].implemented,
);

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

/**
 * 端口解析：静态端口直接返回，动态端口（条件分支）按当前配置推导。
 *
 * 推导的每一步都对着**声明**做，不额外判断节点类型 ——
 * Rust 侧读同一份声明写同一段逻辑（`crates/engine/src/catalog.rs`），
 * 加一句「if type === 'branch'」就会让那边少一条分支。
 */
export function resolveNodeOutputs(type: NodeType, config: unknown): Port[] {
  const def = getNodeDefinition(type);
  const rule = def.dynamicOutputs;
  if (!rule) return def.ports.outputs;

  // 配置常常是半成品（模型刚提议、用户填了一半），任何一步都不能抛
  const record = (config ?? {}) as Record<string, unknown>;
  const raw = record[rule.casesField];
  const ports = (Array.isArray(raw) ? raw : [])
    .map((item) => (item as Record<string, unknown> | null)?.[rule.portField])
    .filter((port): port is string => typeof port === 'string' && port.length > 0)
    .map((port) => ({ id: port, label: port }));

  const declared = record[rule.defaultPortField];
  const fallback =
    typeof declared === 'string' && declared.length > 0 ? declared : rule.fallbackPort;
  return [...ports, { id: fallback, label: fallback }];
}
