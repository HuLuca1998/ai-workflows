import { z } from 'zod';

/**
 * 运行报告 —— 工作流跑完之后给人看的那一份东西。
 *
 * ## 为什么不是「让 AI 写一段 HTML」
 *
 * 直觉的做法是让 agent 生成 HTML 塞进界面。这个仓库已经为同一个问题
 * 定过调子（`packages/ui/src/components/RichText.tsx` 的头注释）：
 *
 * > 给它完整 HTML 等于把渲染通道接到 agent 的权限面上 —— 那个 agent
 * > 连着系统 MCP、读得到工作流、改得动草稿。
 *
 * 报告比对话更危险：它会被**反复打开、分享、导出**，而生成它的 agent
 * 刚刚读过整个工作区。所以这里定的是**一套组件白名单**：
 * agent 产出结构化数据，应用按自己的设计令牌渲染。
 *
 * 三个附带的好处（不是安全考虑，是它本来就更好）：
 *
 * - 样式统一 —— 十条工作流的报告不会长成十个样
 * - 内容可搜索、可比较、可导出成别的格式（HTML 只能整块看）
 * - 报告在窄窗口里也能重排，而 agent 写死的 HTML 不会
 *
 * ## 每条工作流的报告长得不一样
 *
 * 不一样体现在**块的组合**上：日志巡检报告是「指标 + 表格 + 时间线」，
 * Issue 修复报告是「摘要 + diff 统计 + 链接」。块的种类是固定的，
 * 怎么摆由生成它的 agent 决定。
 */

/** 一条指标。报告顶部那排大数字。 */
export const ReportMetricSchema = z.object({
  label: z.string().min(1).max(40),
  value: z.string().min(1).max(40),
  /** 副文本：同比、单位、口径。 */
  note: z.string().max(80).optional(),
  /**
   * 语气。只影响颜色，不影响含义 —— 颜色之外还要有文字，
   * 色觉障碍用户与截图转黑白时同样要读得出来。
   */
  tone: z.enum(['neutral', 'success', 'warning', 'danger']).default('neutral'),
});
export type ReportMetric = z.infer<typeof ReportMetricSchema>;

/** 表格。列宽由渲染方决定，agent 只给数据。 */
export const ReportTableSchema = z.object({
  kind: z.literal('table'),
  title: z.string().max(80).optional(),
  columns: z.array(z.string().min(1).max(40)).min(1).max(8),
  /** 每行的单元格数要与 columns 对齐 —— 对不齐时渲染方按 columns 截断补空。 */
  rows: z.array(z.array(z.string().max(500))).max(200),
});

/** 一段说明文字。走 RichText 的 markdown 子集，不是 HTML。 */
export const ReportProseSchema = z.object({
  kind: z.literal('prose'),
  title: z.string().max(80).optional(),
  /** markdown 子集（RichText 认的那些）。HTML 标签会按原文显示。 */
  body: z.string().min(1).max(20_000),
});

/** 指标行。 */
export const ReportMetricsSchema = z.object({
  kind: z.literal('metrics'),
  title: z.string().max(80).optional(),
  items: z.array(ReportMetricSchema).min(1).max(8),
});

/** 时间线：发生了什么，按顺序。 */
export const ReportTimelineSchema = z.object({
  kind: z.literal('timeline'),
  title: z.string().max(80).optional(),
  items: z
    .array(
      z.object({
        at: z.string().max(40).optional(),
        text: z.string().min(1).max(500),
        tone: z.enum(['neutral', 'success', 'warning', 'danger']).default('neutral'),
      }),
    )
    .min(1)
    .max(100),
});

/** 代码 / 日志片段。等宽显示，不解释内容。 */
export const ReportCodeSchema = z.object({
  kind: z.literal('code'),
  title: z.string().max(80).optional(),
  lang: z.string().max(20).default(''),
  body: z.string().min(1).max(20_000),
});

/**
 * 链接组。
 *
 * **只收 http/https**：`javascript:` 与 `data:` 在这里被 Schema 挡掉，
 * 而不是留给渲染层去记得过滤 —— 渲染层会有第二个、第三个实现。
 */
export const ReportLinksSchema = z.object({
  kind: z.literal('links'),
  title: z.string().max(80).optional(),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        href: z
          .string()
          .min(1)
          .max(2000)
          .refine((value) => /^https?:\/\//u.test(value), {
            message: '链接只能是 http:// 或 https://',
          }),
      }),
    )
    .min(1)
    .max(50),
});

/** 报告里的一块。**这就是白名单** —— 认不出的 kind 由 Zod 挡在门外。 */
export const ReportBlockSchema = z.discriminatedUnion('kind', [
  ReportMetricsSchema,
  ReportProseSchema,
  ReportTableSchema,
  ReportTimelineSchema,
  ReportCodeSchema,
  ReportLinksSchema,
]);
export type ReportBlock = z.infer<typeof ReportBlockSchema>;

/**
 * 一份运行报告。
 *
 * 由 AI 节点产出，落成产物 `report.json`，运行详情页的抽屉渲染它。
 */
export const RunReportSchema = z.object({
  /** Schema 版本。加新块类型时不改这个；改了既有块的含义才改。 */
  schemaVer: z.literal(1).default(1),
  title: z.string().min(1).max(120),
  /** 一句话结论。列表页与抽屉标题下面都显示它。 */
  summary: z.string().min(1).max(500),
  /**
   * 整体结论的语气。列表上的徽章按它上色 ——
   * 「跑完了」与「跑完了但有问题」是两回事。
   */
  outcome: z.enum(['success', 'warning', 'failed']).default('success'),
  blocks: z.array(ReportBlockSchema).min(1).max(30),
});
export type RunReport = z.infer<typeof RunReportSchema>;

/** 报告产物的固定文件名。引擎按它认，界面按它找。 */
export const REPORT_ARTIFACT_NAME = 'report.json';

/**
 * 解析一份报告。
 *
 * 解析失败**不抛** —— 报告是锦上添花，一份坏报告不该让运行详情页打不开。
 * 调用方拿到 `null` 时显示原始产物即可。
 */
export function parseRunReport(raw: unknown): RunReport | null {
  const parsed = RunReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
