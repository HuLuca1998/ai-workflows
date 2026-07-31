import { APPROVAL_MODES, RISK_LEVELS, type ApprovalMode, type RiskLevel } from './capabilities.js';
import { NODE_TYPES, type NodeType } from './nodes/definitions.js';

export { APPROVAL_MODES, RISK_LEVELS, type ApprovalMode, type RiskLevel };

/**
 * 审批三档 —— **谁来批工作流里的那些门**。
 *
 * | 档位             | 谁批                                             |
 * | ---------------- | ------------------------------------------------ |
 * | `human_approval` | 每一道门都我批                                   |
 * | `ai_assisted`    | AI 批，节点上标了「必须我批」的除外               |
 * | `unattended`     | 全交给 AI，包括标了「必须我批」的                 |
 *
 * ## 权限由流程管，不由节点各自管
 *
 * 执行节点拿到的是**最高权限** —— 不再逐个节点声明能读什么、能跑什么。
 * 要不要停下来问，由工作流的形状决定：在「探索完成 → 开始编辑」之间、
 * 在「编码完成 → 开 PR」之间放一个 `approval` 节点，那两处就是关卡。
 *
 * 这条的代价必须说清楚：**一条没放 approval 节点的工作流会一路跑到底**，
 * 包括 push 与建 PR。引擎不再按节点类型或脚本内容替你兜底 ——
 * 那道兜底曾经存在，而它带来的是「读一个 Issue 也要人点一次」。
 *
 * 兜底换成了别的东西：节点库里那句话、审批节点的默认位置（内置模板里
 * 两道门都在）、以及运行前的 Dry Run 会列出这条工作流有几道门。
 */

/** 这一道门由谁放行。 */
export type ApprovalDecider = 'ai' | 'human';

/** 审批节点上写的裁决者。`auto` = 跟随全局档位。 */
export const NODE_DECIDERS = ['auto', 'user', 'ai'] as const;
export type NodeDecider = (typeof NODE_DECIDERS)[number];

/**
 * 一道审批门由谁批。
 *
 * 两个输入：节点上写的（工作流作者的意图）与全局档位（用户当下想被打扰多少）。
 * **全局档位覆盖节点** —— 那是设置页那三张卡的意义所在：
 * 用户选「无人值守」时，连标了「必须我批」的门也交给 AI，
 * 否则那一档就不叫无人值守。
 *
 * 认不出的值一律回到人 —— 库里可能躺着上一版的档位名，
 * 静默放行等于用户以为设了一道门而实际没有。
 */
export function approvalDecider(mode: ApprovalMode, nodeDecider?: NodeDecider): ApprovalDecider {
  if (!(APPROVAL_MODES as readonly string[]).includes(mode)) return 'human';

  switch (mode) {
    // 全都我来 —— 节点上写的 ai 也不作数
    case 'human_approval':
      return 'human';

    // 全交给 AI —— 节点上写的 user 也不作数
    case 'unattended':
      return 'ai';

    // 节点说了算。没说（auto）时默认 AI 批 ——
    // 这一档的名字就是「AI 审批，关键节点用户审批」，
    // 而「关键」由工作流作者在节点上标出来
    default:
      return nodeDecider === 'user' ? 'human' : 'ai';
  }
}

/**
 * 节点类型的基线风险。
 *
 * **这不再是一道门，是一句说明。** 风险判定曾经用来自动拦截，
 * 结果是「读一个 Issue 也要人点一次」—— 现在拦不拦由工作流里的
 * `approval` 节点决定，而这张表的用途是**告诉批的那个人（或 AI）
 * 接下来会发生什么**：审批界面上那句「这一步会写到这台机器之外」
 * 就是从这里来的。
 *
 * 仍然要覆盖 `NODE_TYPES` 全部：漏一个，审批界面上那一栏就是空的，
 * 而批的人得自己去猜。`tests/approval.test.ts` 盯着这件事。
 */
const BASE_RISK: Record<NodeType, RiskLevel> = {
  // 什么都不做，或只读上游产出
  entry: 'read_only',
  end: 'read_only',
  approval: 'read_only',
  branch: 'read_only',
  transform: 'read_only',

  // AI 里只有 execute 会动文件 —— 另外三种只读上下文再产出文字
  'ai.analyze': 'read_only',
  'ai.review': 'read_only',
  'ai.decide': 'read_only',
  'ai.execute': 'workspace_write',

  // 通知走的是系统通知中心，不碰文件也不出这台机器。
  // 它归 read_only 不是因为「没实现所以无所谓」——
  // 实现之后也一样，弹一条通知没有可回滚性问题
  notify: 'read_only',

  // 起进程。脚本内容决定实际风险，这里只给下限
  'script.shell': 'workspace_write',
  'script.python': 'workspace_write',
  env: 'workspace_write',

  // 建 worktree 会在磁盘上落一份检出。它本身不推送，
  // 但它是「接下来要改代码」的那一步
  'git.worktree': 'workspace_write',

  // 子工作流的风险是它内部节点的并集，静态算不出来。
  // 按最高算：里面藏一个 push 的话，外面这一层不该比它松
  subworkflow: 'external_write',

  // 契约里 externalWrite: true 的那个。第三方系统，不可控
  'mcp.tool': 'external_write',
};

/**
 * 查基线风险。**未知类型按外部写算**。
 *
 * 契约新增了节点而这张表没跟上时走到这里。默认 `read_only` 的话，
 * 新节点会带着「三档全放行」上线，而没有任何东西会红。
 */
export function baseRiskOf(type: string): RiskLevel {
  if (!(NODE_TYPES as readonly string[]).includes(type)) return 'external_write';
  return BASE_RISK[type as NodeType];
}

/**
 * 界面文案。放契约里是因为设置页、引导页、运行页的审批卡片都要用同一套说法 ——
 * 三处各写一份的时候，同一个档位在三个地方承诺的事情会不一样。
 */
export const APPROVAL_MODE_LABELS: Record<
  ApprovalMode,
  { name: string; summary: string; detail: string }
> = {
  human_approval: {
    name: '我来审批',
    summary: '工作流里的每一道门都由你批',
    detail:
      '节点上标了「交给 AI」的门也会停下来等你。适合第一次跑一条陌生的工作流 —— 你会看到它每一步想做什么。',
  },
  ai_assisted: {
    name: 'AI 审批，关键步骤问我',
    summary: '门由 AI 批，标了「必须我批」的除外',
    detail:
      'AI 会读这一步要做什么，给出放行或拒绝并写清理由。工作流作者标为「必须我批」的那几道门仍然停下来等你 —— 通常是开 PR 之前那一道。',
  },
  unattended: {
    name: '无人值守',
    summary: '所有门都交给 AI，包括标了「必须我批」的',
    detail:
      '全程不打断你，每一次放行都留档可查。适合你已经跑过几遍、清楚这条工作流会做什么的时候。',
  },
};

/**
 * 「谁来批」这件事在界面上怎么说。
 *
 * 节点配置弹层与审批卡片共用 —— 两处各写一份的话，
 * 用户在节点上选的那一项与运行时看到的说法会对不上。
 */
export const NODE_DECIDER_LABELS: Record<NodeDecider, string> = {
  auto: '跟随设置（默认）',
  user: '必须我批',
  ai: '交给 AI 批',
};
