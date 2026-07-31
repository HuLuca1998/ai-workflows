import { APPROVAL_MODES, RISK_LEVELS, type ApprovalMode, type RiskLevel } from './capabilities.js';
import { NODE_TYPES, type NodeType } from './nodes/definitions.js';

export { APPROVAL_MODES, RISK_LEVELS, type ApprovalMode, type RiskLevel };

/**
 * 审批三档。
 *
 * 用户选的不是「哪一类操作要确认」，而是**谁来确认**：
 *
 * | 档位             | 谁批                                       |
 * | ---------------- | ------------------------------------------ |
 * | `human_approval` | 有副作用的都我批                           |
 * | `ai_assisted`    | AI 批常规的，外部写留给我                  |
 * | `unattended`     | 全交给 AI，包括 push 与建 PR               |
 *
 * 这三档替换了原来的 `review_every_change` / `workspace_safe` /
 * `trusted_workflow`。旧的那组按「操作类别」切，结果是最严那档把
 * `script.shell` **整类**都拦下 —— 一条只读的 `gh issue view` 也要人点一次。
 * 真正决定要不要问人的是这一步会造成什么，不是它属于哪种节点。
 */

/** 这一步由谁放行。`none` = 不用问，直接跑。 */
export type ApprovalDecider = 'none' | 'ai' | 'human';

/**
 * 谁来批这一步。
 *
 * **认不出的值一律从严**：数据库里可能躺着上一版的档位名（旧的三档），
 * 契约里可能加了新节点而基线风险表没跟上。静默放行的话，
 * 用户以为自己选的是某一档，实际一道门都没有。
 */
export function approvalDecider(mode: ApprovalMode, risk: RiskLevel): ApprovalDecider {
  const 已知档位 = (APPROVAL_MODES as readonly string[]).includes(mode);
  if (!已知档位) return 'human';

  // 认不出的风险等级按最高那档算
  const 实际风险: RiskLevel = (RISK_LEVELS as readonly string[]).includes(risk)
    ? risk
    : 'external_write';

  if (实际风险 === 'read_only') return 'none';

  if (mode === 'human_approval') return 'human';

  // ai_assisted 与 unattended 的**唯一**差别就在这里：
  // 「关键节点用户审批」这句话的全部内容就是外部写这一格
  if (mode === 'ai_assisted' && 实际风险 === 'external_write') return 'human';

  return 'ai';
}

/**
 * 节点类型的**基线**风险。
 *
 * 叫基线是因为它只是下限：`script.shell` 的实际风险取决于脚本内容 ——
 * 同一个节点类型，`git log` 与 `git push` 不是一回事。引擎按脚本内容
 * 往上调（`crates/engine/src/risk.rs`），**只上调不下调**：
 * 嗅探漏了一种写法时，结果是多问一次，而不是放过一次。
 *
 * 这张表必须覆盖 `NODE_TYPES` 全部 —— 漏一个就是漏一道门，
 * 而漏掉的那个会以 `read_only` 的形态被三档全部放行。
 * `tests/approval.test.ts` 盯着这件事。
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
    summary: '每一步有副作用的操作都问我',
    detail:
      '改文件、起进程、推分支、建 PR 都会停下来等你点。只读操作（看 Issue、读日志、跑分析）不拦。',
  },
  ai_assisted: {
    name: 'AI 审批，关键步骤问我',
    summary: 'AI 放行常规操作，外部写操作留给你',
    detail:
      '改工作区里的文件、跑验证命令由 AI 判断放不放行，并写清理由；push、建 PR、删远端这类别人看得见的操作仍然停下来等你。',
  },
  unattended: {
    name: '无人值守',
    summary: '全部交给 AI，包括推分支与建 PR',
    detail:
      'AI 对每一步都给出放行或拒绝的判断并留档，全程不打断你。适合你已经跑过几遍、清楚这条工作流会做什么的时候。',
  },
};
