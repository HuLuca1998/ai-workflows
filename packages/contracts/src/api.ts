import { z } from 'zod';
import { PERMISSION_PRESETS } from './capabilities.js';
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
/**
 * 把一个实体 Schema 变成 patch 入参：**全可选，且没有默认值**。
 *
 * `.partial()` 只让字段可选，**不去掉 `.default()`** —— 缺席时 Zod 照样
 * 填默认值。于是界面只发 `{id, ver, goal}`，校验之后变成
 * `{id, ver, goal, persona: '', tools: [], outputContract: ''…}`，
 * 后端 COALESCE 收到的是空字符串而不是 NULL，照写。
 *
 * codex 亲手踩到：新建 Agent 时填了「性格与指令」，之后只改「目标」
 * 点保存，那段指令被清空了 —— 静默数据丢失，刷新之后才发现，
 * 而那时原文已经没了。
 *
 * 显式发空串仍然是「改成空」：那是用户的意思，与「没发」是两回事。
 */
const patchOf = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let inner = field as z.ZodTypeAny;
    // 剥到没有 default 为止：可能是 default(optional(...)) 这种叠了两层
    while (inner instanceof z.ZodDefault) {
      inner = inner.def.innerType as z.ZodTypeAny;
    }
    shape[key] = inner.optional();
  }
  return z.object(shape);
};

const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    /** 满足筛选条件的总条数，不是这一页的条数。 */
    total: z.number().int().min(0),
  });

const SPECS = {
  // ── Workflow ────────────────────────────────────────────────────────────
  'mcp.requestConfirm': {
    // MCP 进程提交一条待确认的写操作。
    //
    //「AI 的改动一律先出 Diff，用户确认才落草稿」是核心规则 ——
    // 主管 AI 遵守了，MCP 之前不能：那个进程弹不出应用里的对话框，
    // 于是写工具只能整体关掉（AIWF_MCP_ALLOW_WRITE=1 才开，
    // 开了就没有确认那一步）。这条通道让它也能遵守。
    input: z.object({
      tool: z.string().min(1),
      /** 入参原文。用户要看清「它到底要改什么」才能决定。 */
      inputJson: z.string().min(1),
    }),
    output: z.object({ id: z.string().min(1) }),
    mutates: true,
    audited: true,
    // MCP 进程自己调它，所以要有 Scope；写草稿那一档
    scope: 'workflow:write-draft',
    summary: '提交一条待用户确认的 MCP 写操作',
  },
  'mcp.confirmStatus': {
    // MCP 侧轮询它等结果。
    input: z.object({ id: z.string().min(1) }),
    output: z.object({
      status: z.enum(['pending', 'approved', 'rejected', 'expired']),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '查一条确认的结果',
  },
  'mcp.pendingConfirms': {
    // 应用轮询它来显示确认卡。
    input: z.object({}),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string().min(1),
          tool: z.string().min(1),
          inputJson: z.string(),
          /** 提交时间。用户要知道它等了多久。 */
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
    mutates: false,
    audited: false,
    // 只给本地 UI：让 MCP 看得见待确认队列，它就能自己找到自己那条
    scope: null,
    summary: '列出等待用户确认的 MCP 写操作',
  },
  'mcp.decideConfirm': {
    input: z.object({ id: z.string().min(1), approved: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
    mutates: true,
    audited: true,
    // 决定只能由本地 UI 做 —— 给远端 Scope 就等于自己批准自己
    scope: null,
    summary: '用户对一条 MCP 写操作的决定',
  },
  'mcp.status': {
    // 「设置与环境 · MCP 与集成」那一档读它。
    input: z.object({}),
    output: z.object({
      running: z.boolean(),
      /** 写进客户端配置的那个地址。**带令牌**，界面上默认打码。 */
      url: z.string(),
      /** 不带令牌的端点，配合 Authorization 头用。 */
      endpoint: z.string(),
      port: z.number().int().min(0),
      toolCount: z.number().int().min(0),
      resourceCount: z.number().int().min(0),
      clients: z.array(
        z.object({
          id: z.enum(['claude', 'codex']),
          label: z.string(),
          /** 命令行工具在不在 PATH 里。不在就没法一键接入。 */
          cliInstalled: z.boolean(),
          /** 已经接进去了。 */
          connected: z.boolean(),
        }),
      ),
    }),
    mutates: false,
    audited: false,
    // 本地专属：把 MCP 自己的接线情况暴露给 MCP，等于让 Agent 看得见
    // 自己的令牌，而那个令牌就是它的全部权限
    scope: null,
    summary: '系统 MCP 的运行状态与客户端接入情况',
  },
  'mcp.connect': {
    input: z.object({
      client: z.enum(['claude', 'codex']),
      /** 反过来：把它从客户端里摘掉。 */
      disconnect: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      /** 给用户看的一句话。失败时说清接下来该干什么。 */
      detail: z.string(),
      /** 实际执行的命令。失败时用户能自己复制去跑一遍。 */
      command: z.string(),
    }),
    mutates: true,
    audited: true,
    // 同上：让 Agent 能改客户端的 MCP 配置等于让它给自己扩权
    scope: null,
    summary: '把本地 Claude Code / Codex 接入系统 MCP',
  },
  'workspace.settings': {
    // 顶栏的工作目录、侧栏的权限档与环境状态都读这里。
    //
    // 在此之前那三处**没有数据源**，界面上一直悬着「尚未授权工作目录 /
    // 未设置权限档 / 环境尚未检查」，而应用里没有任何东西能把它们改掉 ——
    // 首次配置屏点什么按钮都不会变。
    input: z.object({}),
    output: z.object({
      /** 已授权的工作目录。缺席表示还没授权。 */
      workdir: z.string().optional(),
      /** 权限档。缺席表示还没选。 */
      permissionPreset: z.enum(PERMISSION_PRESETS).optional(),
      /** 上次环境检查的时间。缺席表示从没检查过。 */
      envCheckedAt: z.string().optional(),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '读工作区设置（工作目录、权限档、上次环境检查）',
  },
  'workspace.updateSettings': {
    // 只带要改的项。三项互不相干，一次改一项是常态
    //（授权目录、选权限档、跑完检查记时间）。
    input: z.object({
      workdir: z.string().min(1).optional(),
      permissionPreset: z.enum(PERMISSION_PRESETS).optional(),
      envCheckedAt: z.string().min(1).optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
    mutates: true,
    // 授权变更必须留痕：它决定了这台机器上的 Agent 能碰到什么
    audited: true,
    scope: 'workflow:write-draft',
    summary: '改工作区设置',
  },
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
  'workspace.resetPreview': {
    // 先看清楚再动手。这个应用一贯这么做 —— 图纸「06 首次安装与检测」
    // 把「将写入的位置」逐条列出来才让你点确认，删东西没有理由更随意。
    //
    // 目录的路径是**算出来的真路径**，不是文案里编的样例：
    // 产物落在用户自己授权的工作目录下（`<workdir>/.aiwf-artifacts`），
    // 不在 App 数据目录里。用户不看到这一条，就不知道自己的代码仓库
    // 里有东西要被删。
    input: z.object({}),
    output: z.object({
      /** 库里现在有多少东西。确认框逐条念给用户听。 */
      counts: z.object({
        workflows: z.number().int().min(0),
        runs: z.number().int().min(0),
        memories: z.number().int().min(0),
        agents: z.number().int().min(0),
        prompts: z.number().int().min(0),
        models: z.number().int().min(0),
      }),
      directories: z.array(
        z.object({
          path: z.string().min(1),
          kind: z.enum(['runs', 'logs', 'artifacts']),
          bytes: z.number().int().min(0),
          /**
           * 这个目录在不在用户授权的工作目录里。
           *
           * 必填而不是可选：界面要靠它把「删 App 自己的地盘」与
           * 「删你代码仓库里的东西」分开警告，而缺席会被读成 false ——
           * 恰好是那条更危险的路径被当成安全的。
           */
          insideWorkdir: z.boolean(),
        }),
      ),
    }),
    mutates: false,
    audited: false,
    // 与 workspace.reset 同档：预览会报出用户机器上的真实路径
    scope: null,
    summary: '预览一键初始化会清掉什么',
  },
  'workspace.reset': {
    input: z.object({
      /**
       * 防误触。`scope: null` 已经把 MCP 与 HTTP 挡在外面了，
       * 这一条挡的是本地脚本照着命令名一把梭 —— 手滑至少要多打一个字段。
       */
      confirm: z.literal(true),
      /**
       * 连 `<workdir>/.aiwf-artifacts` 一起删。
       *
       * 默认 false：那个目录在用户自己的代码仓库里，「没说」只能理解成
       * 「别碰」。界面在确认框里把路径显示出来，由用户勾。
       */
      includeArtifacts: z.boolean().default(false),
    }),
    output: z.object({
      ok: z.literal(true),
      /** 真的删掉了哪些目录。界面照实回显，不照着请求参数猜。 */
      removedDirectories: z.array(z.string()),
    }),
    mutates: true,
    // 清库这件事本身要留痕 —— 事后追查「我的东西哪去了」只剩这一条线索
    audited: true,
    scope: null,
    summary: '一键初始化：清空数据库、重种内置数据、清运行产物与日志',
  },
  'workflow.list': {
    input: z.object({
      query: z.string().optional(),
      archived: z.boolean().optional(),
      /**
       * 首页那四个筛选 chip。
       *
       * 分页之后前端过滤只能过滤**当前页** —— 用户停在第 29 页点「失败」，
       * 看到的是「这 50 条里恰好失败的那些」，而不是全部失败的运行。
       */
      status: z.enum(['running', 'draft', 'failed']).optional(),
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
      /**
       * 名字。**缺席时由引擎编号**（「未命名工作流 N」）。
       *
       * 界面自己算编号的话只能看到当前页 —— 分页后每页固定 50 条，
       * 于是每次新建都叫「未命名工作流 51」，列表里一串认不出来的同名草稿。
       */
      name: z.string().min(1).optional(),
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
       * 调用方本地应用 Patch 后的结果图（JSON）。**可选，只当交叉校验。**
       *
       * 引擎自己应用操作、算 Diff、跑校验（ADR-0009）——
       * 从 MCP 连进来的 Agent 中间没有任何客户端，没人替它算那张图。
       * 传了的话引擎会比一下：不一致说明一致性夹具漏了一种形态，
       * 引擎留一行日志，落库仍以自己算的为准。
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
  'workflow.discardIfEmpty': {
    // 点一次「新建工作流」就落一条持久草稿，只为了看看编辑器长什么样
    // 也会留下垃圾。离开编辑器时调它，从没被用过的空草稿自己清掉。
    //
    // 判断放在后端：前端只知道「我这次没改过」，不知道别的窗口有没有动过它。
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ discarded: z.boolean() }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '丢弃从没被用过的空草稿',
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
          /** 磁盘上的绝对路径。图纸列表底部显示的是它的父目录。 */
          path: z.string(),
          /**
           * 相对产物根目录的路径 —— `run.artifactContent` 收的就是它。
           *
           * 少了这个字段的时候，界面点「预览」会报「入参不合契约」：
           * Zod 静默剥掉未声明的字段，引擎返回的 relPath 到不了界面，
           * 于是传了个 undefined 下去。报错说的是下一个接口，
           * 问题却在这个接口的返回值上。
           */
          relPath: z.string().min(1),
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
  'run.rewindToApproval': {
    // 图纸「03 执行记录」失败横幅的第二个按钮「回到最近审批点改选择」。
    //
    // 用户在审批那一步选错了（批准了一个不该批的 Diff），后面才发现。
    // run.resume 没用 —— 它沿用同一个决定继续往下；重跑又会把
    // 前面几十分钟的工作全丢掉。
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({
      /** 新的运行。原来那条留在记录里，两次可以对照着看。 */
      runId: z.string().min(1),
      /** 回到了哪个审批节点。界面据此把用户带到那一步。 */
      nodeId: z.string().min(1),
    }),
    mutates: true,
    // 它改变了「谁批准了什么」—— 那正是审计要回答的问题
    audited: true,
    scope: 'workflow:run',
    summary: '回到最近的审批点重新选择',
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
       * 这轮对话有没有进历史。
       *
       * 落库失败时**不丢答案** —— 用户已经等了几十秒，拿不到答案比
       * 丢掉历史糟得多。但也不能假装成功：他隔天回来找不到这条对话，
       * 会以为是自己记错了。所以答案照给，把「没存住」说出来。
       */
      historySaved: z.boolean().default(true),
      /**
       * 选的模型没设上时的说明。空数组 = 用的就是抽屉里选的那个。
       *
       * **必须回到界面上**：那个下拉是用户刚点过的，只在后端日志里说
       * 等于悄悄换了模型 —— 而 `AgentsPage` 上写着「不会静默替换模型」。
       *
       * 值来自 agent 自己的拒绝（实测两端都拒不存在的模型：
       * codex `-32602` / claude `-32603`），不是我们编的判断。
       */
      downgraded: z.array(z.string()).default([]),
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
    // **写操作**：它建会话、存两条消息（用户的问题与 AI 的回答）。
    //
    // 曾经声明 mutates:false / workflow:read —— 那不只是文档不准：
    // MCP 的只读会话按 mutates 过滤工具，一个声明只读却写库的方法
    // 会整个绕过那道过滤。
    //
    // 「AI 的改动先出 Diff」说的是**对工作流的改动** ——
    // proposal 不落草稿，那一步仍然要用户确认走 workflow.patch。
    // 与「这次对话本身要不要记下来」是两回事。
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '问主管 AI；对话进历史，而它对工作流的改动一律先出 Diff 再落草稿',
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
    input: patchOf(PromptSchema).extend({
      id: z.string().min(1),
      ver: z.number().int().min(1),
      /**
       * 是谁改的：「你」还是「AI 提议」。缺省算用户自己改的。
       *
       * 版本页要把这两种分开显示（图纸「v3 · 上周 · AI 提议」）——
       * 分不清人改的还是 AI 改的，「历史结果始终可解释」就少了一半。
       */
      changedBy: z.string().min(1).optional(),
    }),
    output: z.object({ ver: z.number().int().min(1) }),
    mutates: true,
    audited: true,
    scope: 'workflow:write-draft',
    summary: '保存为新版本（运行记录引用具体版本号）',
  },
  'prompt.versions': {
    // 图纸「06 提示词库」版本页：v4 · 当前 / v3 / v2，每条带时间与改的人。
    // 只返回**历史**版本，当前那份在 prompt.list 里，界面自己拼上去。
    input: z.object({ promptId: z.string().min(1) }),
    output: z.object({
      items: z.array(
        z.object({
          ver: z.number().int().min(1),
          name: z.string().min(1),
          sections: z.array(z.object({ title: z.string().min(1), body: z.string() })),
          vars: z.array(z.unknown()).default([]),
          changedBy: z.string().min(1),
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '一条提示词的历史版本',
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
    input: z.object({
      enabledOnly: z.boolean().default(false),
      /** 按名字或模型 ID 搜。列表过 50 条之后翻页找是不可行的。 */
      query: z.string().optional(),
      ...PAGING,
    }),
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
    input: patchOf(ModelSchema).extend({ id: z.string().min(1) }),
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
    // 图纸「07 模型」详情区的「测试连通性」，与凭据卡那行
    //「延迟 · 1.4s（最近一次测试）」。
    //
    // 只做握手 + 建会话，不发提示词：那样快、不花钱，而且已经足以回答
    //「这个模型现在能不能用」—— 握不上手的原因（adapter 没装、
    // 版本不匹配、没登录）正是用户需要知道的。
    input: idOnly,
    output: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      /** 通了说通过什么，没通说卡在哪 ——「失败」两个字帮不上任何忙。 */
      detail: z.string().min(1),
    }),
    // 它把延迟写回模型行（图纸「最近一次测试」），所以是写操作
    mutates: true,
    audited: true,
    // 会在这台机器上拉起 adapter 进程：与 env.install 同一条理由，不给远端
    scope: null,
    summary: '测试模型连通性并记下延迟',
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
    input: patchOf(AgentProfileSchema).extend({
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

  // ── GitHub ──────────────────────────────────────────────────────────────
  //
  // 启动表单里的仓库字段（`format: 'repo'`）靠这两条填下拉。
  //
  // 为什么值得单开两个方法：仓库全名与分支名是**用户记不住也不该记**的东西 ——
  // 手填一个 `owner/name` 打错一个字，要等运行跑到 git clone 那一步才报错，
  // 而那时 worktree 已经建好了。让他从自己有权限的仓库里选，这类错就不存在。
  //
  // 都走本机已登录的 `gh`。gh 没装或没登录时**报错而不是返回空列表** ——
  // 一个空下拉看着像「你没有仓库」，用户会去 GitHub 上找自己哪儿配错了。
  'github.repos': {
    input: z.object({
      /** 按全名过滤，留空给最近推送过的那些。 */
      query: z.string().optional(),
      limit: z.number().int().positive().max(200).default(100),
    }),
    output: z.object({
      items: z.array(
        z.object({
          /** `owner/name`。这就是 git 与 gh 都认的那个标识。 */
          fullName: z.string().min(1),
          defaultBranch: z.string().min(1),
          /** 组织仓库。界面上分组显示，个人的和组织的混在一起很难找。 */
          isOrg: z.boolean(),
        }),
      ),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出当前 gh 账号有权限的仓库（含组织仓库）',
  },
  'github.branches': {
    input: z.object({ repo: z.string().min(1) }),
    output: z.object({
      items: z.array(z.string().min(1)),
      /** 默认分支排在前面，也用来给启动表单预选。 */
      defaultBranch: z.string().min(1),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '列出一个仓库的分支',
  },

  // ── 环境 ────────────────────────────────────────────────────────────────
  'env.health': {
    input: z.object({ recheck: z.boolean().default(false) }),
    output: z.object({
      /** 必需项是否都就绪。可选项缺失不影响它。 */
      ready: z.boolean(),
      items: z.array(EnvHealthItemSchema),
    }),
    mutates: false,
    audited: false,
    scope: 'workflow:read',
    summary: '环境健康报告',
  },
  /**
   * 这个目录能不能用。
   *
   * 引导页选完工作目录要验一次，启动表单填本地仓库路径也要验 ——
   * 不验的话，错误发生在运行跑到第四个节点时，而原因在第一屏填的东西里。
   *
   * **必须是真探测**：写一个探针文件再删掉。`stat` 说得出「存在」，
   * 说不出「你有没有权限往里写」—— 而 macOS 的 TCC 恰恰是后者
   * （目录在 `~/Documents` 下时，读得到、写不了）。
   */
  'env.checkDirectory': {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({
      /** 展开 `~` 之后的绝对路径。界面显示它，用户要能确认自己选的是哪个 */
      resolved: z.string().min(1),
      exists: z.boolean(),
      /** 探针文件写得进去吗。这是唯一说得准的判据 */
      writable: z.boolean(),
      /** 是不是一个 git 仓库（有 .git）。选本地仓库路径时要用 */
      isGitRepo: z.boolean(),
      /**
       * 落在 macOS 的 TCC 保护区里（Desktop / Documents / Downloads…）。
       * 现在写得进去不代表以后还行 —— ad-hoc 签名下，App 一更新
       * 授权就失效（docs/MACOS-PERMISSIONS.md）
       */
      tccProtected: z.boolean(),
      /** 不可用时说清为什么、怎么办。可用时为空 */
      message: z.string().optional(),
    }),
    mutates: false,
    audited: false,
    // 与 env.install 同一条理由：探测本机文件系统只允许本地 UI 触发。
    // 开给 MCP 的话，外部客户端能拿它扫用户的目录结构
    scope: null,
    summary: '检查一个目录能不能用',
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
  'env.diagnostics': {
    // 图纸「06 首次安装与检测」与「05 设置与环境」底部的「导出脱敏报告」。
    //
    // 那两屏都还没有任何一次运行，所以 run.diagnostics（要 runId）用不上。
    // 与它共用同一条脱敏管道：用户要把环境情况发给别人看，
    // 而手工整理必然会漏掉某处的 token。
    input: z.object({}),
    output: z.object({
      /** 诊断包落在哪。界面显示它，用户自己去取。 */
      path: z.string().min(1),
      bytes: z.number().int().min(0),
    }),
    mutates: true,
    audited: true,
    // 与 env.install / run.diagnostics 同一条理由：会动本机文件的操作
    // 只允许本地 UI 触发，绝不给远端 Scope
    scope: null,
    summary: '导出脱敏的环境诊断包',
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
