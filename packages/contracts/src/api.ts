import { z } from 'zod';
import type { Scope } from './capabilities.js';
import { RUN_EVENT_CATEGORIES, RunEventSchema } from './events.js';
import { WorkflowGraphSchema } from './graph.js';
import { PatchOperationSchema } from './patch.js';
import {
  AgentProfileSchema,
  ApprovalDecisionSchema,
  SupervisorMessageSchema,
  SupervisorSessionSchema,
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

/** 列表默认一页多少条。够填满一屏，又不会让浏览器建出上千个节点。 */
export const LIST_PAGE_SIZE = 50;

/** 一页最多多少条。上限存在的意义就是不能被绕过。 */
export const LIST_PAGE_LIMIT_MAX = 200;

/**
 * 列表的分页参数。
 *
 * 1292 条工作流一次铺满页面，浏览器要建出上千个 DOM 节点，
 * 而用户真正关心的那几条淹在里面。
 *
 * limit 有上限：没有上限的话「分页」就是摆设 —— 调用方一个
 * `limit: 100000` 就把它绕过去了。
 */
const PAGING = {
  limit: z.number().int().positive().max(LIST_PAGE_LIMIT_MAX).default(LIST_PAGE_SIZE),
  offset: z.number().int().min(0).default(0),
};

/** 列表的返回：这一页 + 总数。界面靠 total 画分页控件。 */
const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    /** 满足筛选条件的总条数，不是这一页的条数。 */
    total: z.number().int().min(0),
  });

const SPECS = {
  // ── Workflow ────────────────────────────────────────────────────────────
  'workspace.stats': {
    // 图纸「01 工作流首页」顶部那四张卡。分四次查会让概览页发四个请求，
    // 而它们本就是同一时刻的快照 —— 分开取会出现「等待审批 1，
    // 但今日运行 0」这种自相矛盾的组合
    input: z.object({}),
    output: z.object({
      /** 卡一：等待审批。副文本是最近那条在等的运行叫什么。 */
      pendingApprovals: z.number().int().min(0),
      pendingApprovalHint: z.string().optional(),
      /** 卡二：今日运行 / 其中成功几条。 */
      runsToday: z.number().int().min(0),
      runsTodaySucceeded: z.number().int().min(0),
      /**
       * 卡三：本周 token 用量。
       *
       * 缺席表示**还没有数据源**（事件流里目前不记 token），
       * 界面据此显示「—」而不是 0 —— 0 会被读成「这周没花钱」。
       */
      tokensThisWeek: z.number().int().min(0).optional(),
      /** 卡四：活跃 worktree 数与占用字节。 */
      activeWorktrees: z.number().int().min(0),
      worktreeBytes: z.number().int().min(0),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '首页四张统计卡的同一时刻快照',
  },
  'workflow.list': {
    input: z.object({
      query: z.string().optional(),
      archived: z.boolean().optional(),
      ...PAGING,
    }),
    output: paged(WorkflowSchema),
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
  'workflow.rename': {
    // 新建只能得到「未命名工作流 N」。没有改名入口的话列表很快全是这种名字 ——
    // 用户操作级测试在真实库里发现了 300 多条
    input: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    output: ok,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '给工作流改名',
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
      ...PAGING,
    }),
    output: paged(RunSchema),
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
  'run.artifactContent': {
    // 图纸「03 执行记录」的产物列表每条右边都有「预览」与「导出」。
    // 没有它的话，一条 33 字节的 stderr.log 也只能显示大小和磁盘路径 ——
    // 用户得自己去 Finder 里翻。
    input: z.object({
      runId: z.string().min(1),
      /**
       * 相对产物根目录的路径。
       *
       * 这是唯一一个「按用户给的路径读文件」的接口 —— 接受绝对路径
       * 或 `..` 的话，界面上一个输入框就变成了任意文件读取器。
       * 引擎侧还会再挡一道（PathGuard），这里是第一道。
       */
      path: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), {
          message: '产物路径必须相对产物根目录，且不能包含 ..',
        }),
      /** 最多读多少字节。超出的部分截断，并在返回里标出来。 */
      maxBytes: z.number().int().positive().max(1_000_000).default(65_536),
    }),
    output: z.object({
      /** 文本产物的内容。二进制时缺席。 */
      text: z.string().optional(),
      /** 二进制产物给一段乱码比不给更糟 —— 用户会以为文件坏了。 */
      binary: z.boolean().default(false),
      /** 是否被 maxBytes 截断。18KB 的日志不该整个塞进界面渲染。 */
      truncated: z.boolean(),
      /** 文件的完整大小，不是本次读到的字节数。 */
      bytes: z.number().int().min(0),
    }),
    mutates: false,
    audited: true,
    scope: 'workflow:read',
    summary: '读产物内容用于预览',
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
  'supervisor.sessions': {
    // 图纸「主管 AI」：「左侧可折叠历史会话列表
    //（按关联的工作流 / 运行 / 记忆 / 模型标注）」。
    //
    // 不存的话每次关掉抽屉对话就没了 —— 而用户常常是隔天回来接着问，
    // 「上次它说那个节点为什么会失败来着」。
    input: z.object({ limit: z.number().int().positive().max(200).default(50) }),
    output: z.object({ items: z.array(SupervisorSessionSchema) }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出历史会话',
  },
  'supervisor.session': {
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({
      session: SupervisorSessionSchema,
      messages: z.array(SupervisorMessageSchema),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '读一个会话的完整消息',
  },
  'supervisor.ask': {
    // 主管 AI 与工作流里的 AI 节点是两回事：节点在**运行中**做一件具体的事，
    // 主管在**编辑时**帮你操作这个应用本身。
    //
    // context 是显式的 —— 不列出来的话，用户无法判断它的回答基于什么
    input: z.object({
      question: z.string().min(1),
      /** 续接一个已有会话。不给就新开一条。 */
      sessionId: z.string().min(1).optional(),
      modelRef: z.string().min(1).optional(),
      context: z
        .object({
          draftRev: z.number().int().min(0).optional(),
          runId: z.string().min(1).optional(),
          workflowId: z.string().min(1).optional(),
        })
        .default({}),
    }),
    output: z.object({
      text: z.string(),
      /** 这次回答用掉的工具调用次数，界面显示「工具活动 · N 次」。 */
      toolCalls: z.number().int().min(0).default(0),
      /** 这轮所属的会话。界面据此把后续问题接到同一条。 */
      sessionId: z.string().min(1).optional(),
      /**
       * AI 想做的改动。**只是提议** —— 界面据此算 Diff 给用户看，
       * 用户确认后才走 workflow.patch 落草稿。
       *
       * 这个方法本身 mutates: false 是有意的：AI 不能直接写库，
       * 落草稿那一步有 baseRevision 守卫，而它必须由用户触发。
       */
      proposal: z
        .object({
          /** Diff 上面那句话 —— 用户判断要不要接受的依据。 */
          summary: z.string().min(1),
          /** 空列表不算提议：那会让用户看到一个没内容的 Diff。 */
          operations: z.array(PatchOperationSchema).min(1),
        })
        .optional(),
    }),
    mutates: false,
    audited: true,
    scope: 'workflow:read',
    summary: '问主管 AI；它的改动一律先出 Diff 再落草稿',
  },
  'memory.list': {
    input: z.object({
      scope: z.string().optional(),
      scopeId: z.string().optional(),
      query: z.string().optional(),
      ...PAGING,
    }),
    output: paged(MemorySchema),
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
  'memory.toggle': {
    // 停用是比删除更轻的一档：先停掉看看有没有影响，确认没用了再删。
    // 与 update 分开是为了让「谁在什么时候停用了哪条记忆」在审计里单独可见 ——
    // 记忆会注入每一次 AI 调用，它的开关值得单独记一笔
    input: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    output: ok,
    mutates: true,
    audited: true,
    scope: 'memory:write',
    summary: '启用 / 停用一条记忆',
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
    input: z.object({ group: z.string().optional(), query: z.string().optional(), ...PAGING }),
    output: paged(PromptSchema),
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
  'prompt.duplicate': {
    // 图纸详情区有「复制」：内置提示词不能改，但可以复制一份自己的
    input: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    output: idOnly,
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '复制提示词为可编辑的副本',
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
    input: z.object({ enabledOnly: z.boolean().default(false), ...PAGING }),
    output: paged(ModelSchema),
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
    input: z.object({ query: z.string().optional(), ...PAGING }),
    output: paged(AgentProfileSchema),
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
  'run.diagnostics': {
    // 图纸「03 执行记录」失败横幅的第四个按钮。
    // M5 的出口标准写着「诊断包不含 Secret」—— 那是这个方法存在的全部理由：
    // 用户要把失败现场发给别人看，而手工整理必然会漏掉某处的 token。
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({
      /** 诊断包落在哪。界面显示它，用户自己去取。 */
      path: z.string().min(1),
      bytes: z.number().int().min(0),
    }),
    mutates: true,
    audited: true,
    // 与 env.install 同一条理由：会动本机文件的操作只允许本地 UI 触发
    scope: null,
    summary: '导出脱敏的诊断包',
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
