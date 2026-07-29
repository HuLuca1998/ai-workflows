import type { PatchOperation } from './patch.js';

/**
 * 内置模板。
 *
 * 「GitHub Issue 修复」是 M1 的出口标准：这个模板必须能完整搭出、校验通过、
 * 发布为 v1。节点与连线取自图纸「02 画布编辑器」里的示例工作流
 * （原型的 nodes / edges 数组），包括那段并行探索（3 路分析汇聚到子工作流）。
 *
 * 模板以**结构化操作**的形式给出，而不是一份现成的图：
 * 这样新建时走的是与手工搭建、与 AI 改图完全相同的路径（applyPatch），
 * 模板本身也就被同一套校验守住了。
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  summary: string;
  operations: PatchOperation[];
}

const AGENT = {
  analyst: 'builtin:analyst',
  builder: 'builtin:builder',
  reviewer: 'builtin:reviewer',
  operator: 'builtin:operator',
} as const;

/** 图纸里那条 9 节点主线 + 3 路并行探索。 */
const ISSUE_FIX: WorkflowTemplate = {
  id: 'github-issue-fix',
  name: 'GitHub Issue 修复',
  summary: '读 Issue → 分析 → 审批 → worktree → 修复 → 审查 → 决策 → PR',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · Issue 输入',
      position: { x: 40, y: 34 },
      config: {
        trigger: 'manual',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['issue', 'repo'],
          properties: {
            issue: { type: 'string', title: 'Issue 编号' },
            repo: { type: 'string', title: '仓库' },
            base: { type: 'string', title: '基础分支', default: 'main' },
          },
        },
        injectedFields: ['run.id', 'run.startedAt'],
      },
    },
    {
      op: 'addNode',
      nodeId: 'read_issue',
      type: 'script.shell',
      title: '读取 Issue',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        script: 'gh issue view "$ISSUE" --repo "$REPO" --json title,body,labels',
        outputParse: 'json',
        timeoutMs: 60_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'analyze',
      type: 'ai.analyze',
      title: '分析 · 根因与方案',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        target: '${read_issue.success}',
        instruction: '定位根因，给出 2–3 个可选方案，写清每个方案的风险与验证方式。',
      },
    },
    {
      op: 'addNode',
      nodeId: 'approve_plan',
      type: 'approval',
      title: '审批 · 选择方案',
      position: { x: 790, y: 34 },
      config: {
        title: '选择修复方案',
        bodyMarkdown: '分析给出了多个方案，选一个继续。',
        interaction: 'single',
        waitStrategy: 'forever',
      },
    },
    {
      op: 'addNode',
      nodeId: 'worktree',
      type: 'git.worktree',
      title: '创建 Git worktree',
      position: { x: 790, y: 184 },
      config: {
        repoRoot: '${input.repo}',
        baseBranch: '${input.base}',
        branchTemplate: 'fix/${input.issue}-${run.id}',
        // 保留到 PR 合并：图纸里那条记忆说的就是这件事
        cleanupPolicy: 'manual',
      },
    },
    {
      op: 'addNode',
      nodeId: 'fix',
      type: 'ai.execute',
      title: '执行 · Fix Agent',
      position: { x: 540, y: 184 },
      config: {
        agentProfileId: AGENT.builder,
        instruction: '按选定方案修改代码，小步提交，每步可验证。',
        workdirSource: 'worktree',
        verifyCommands: ['pnpm test'],
      },
    },
    {
      op: 'addNode',
      nodeId: 'review',
      type: 'ai.review',
      title: '审查 · Diff 与风险',
      position: { x: 290, y: 184 },
      config: {
        agentProfileId: AGENT.reviewer,
        target: '${fix.success}',
        instruction: '只读检查 Diff、测试与风险，按严重度排序，最多 5 条。',
        checklist: ['并发', '缓存失效', '错误分支', '日志脱敏'],
      },
    },
    {
      op: 'addNode',
      nodeId: 'decide',
      type: 'ai.decide',
      title: '决策 · L1–L3 分级',
      position: { x: 40, y: 184 },
      config: {
        agentProfileId: AGENT.operator,
        instruction: '按影响面给出 L1–L3 分级；push 与建 PR 属于 L3。',
        autoDecideUpTo: 'L2',
        onTimeout: 'escalate',
      },
    },
    {
      op: 'addNode',
      nodeId: 'approve_diff',
      type: 'approval',
      title: '审批 · 检查 Diff',
      position: { x: 40, y: 334 },
      config: {
        title: '检查 Diff 与风险',
        bodyMarkdown: '将要发生的外部写操作：commit → push → 创建 PR。不会修改当前分支。',
        interaction: 'confirm',
        waitStrategy: 'forever',
      },
    },
    {
      op: 'addNode',
      nodeId: 'push_pr',
      type: 'script.shell',
      title: 'Commit / Push / PR',
      position: { x: 290, y: 334 },
      config: {
        interpreter: 'zsh',
        // 三件事的顺序不能反：先 commit 才有东西可推，推完才建得了 PR。
        //
        // 「push 完再 gh pr create」漏掉 commit 的话，推上去的是一个与
        // base 完全相同的空分支，gh 以「No commits between …」失败 ——
        // 而那时分支已经在远端了。所以没改动就在本地停住，不往外推。
        //
        // pipefail：这一步会有人加 `| tail`、`| grep` 之类裁输出，
        // 管道的退出码默认是最后一节的，gh 失败会变成「退出码 0」，
        // 节点显示成功、通知照发「PR 已创建」。
        //
        // `${…}` 展开时已经带上单引号，所以先接进变量，别在外面再套一层 ——
        // 套了会变成 `#'1'`，靠相邻字符串拼接才碰巧对。
        script: [
          'set -euo pipefail',
          'ISSUE=${input.issue}',
          'cd ${worktree.success.path}',
          'git add -A',
          "git diff --cached --quiet && { echo '没有任何改动，不建 PR'; exit 1; }",
          'git commit -qm "fix: 关闭 #$ISSUE"',
          'git push -qu origin HEAD',
          'gh pr create --fill',
        ].join('\n'),
        timeoutMs: 300_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'notify',
      type: 'notify',
      title: '系统通知',
      position: { x: 540, y: 334 },
      config: {
        title: 'Issue 修复完成',
        body: 'PR 已创建，点击查看。',
        clickAction: 'open_run',
      },
    },
    {
      op: 'addNode',
      nodeId: 'done',
      type: 'end',
      title: '结束',
      position: { x: 790, y: 334 },
      config: { outcome: 'success' },
    },

    // 主线。审批与审查的分支端口在这里显式给出——
    // 这正是「画布上的连线需要能指定端口」的实际用途
    {
      op: 'connect',
      edgeId: 'e_entry_read',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'read_issue', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_read_analyze',
      source: { nodeId: 'read_issue', port: 'success' },
      target: { nodeId: 'analyze', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_analyze_approve',
      source: { nodeId: 'analyze', port: 'success' },
      target: { nodeId: 'approve_plan', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_approve_worktree',
      source: { nodeId: 'approve_plan', port: 'approved' },
      target: { nodeId: 'worktree', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_worktree_fix',
      source: { nodeId: 'worktree', port: 'success' },
      target: { nodeId: 'fix', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_fix_review',
      source: { nodeId: 'fix', port: 'success' },
      target: { nodeId: 'review', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_review_decide',
      source: { nodeId: 'review', port: 'passed' },
      target: { nodeId: 'decide', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_decide_approve',
      source: { nodeId: 'decide', port: 'escalated' },
      target: { nodeId: 'approve_diff', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_approve_push',
      source: { nodeId: 'approve_diff', port: 'approved' },
      target: { nodeId: 'push_pr', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_push_notify',
      source: { nodeId: 'push_pr', port: 'success' },
      target: { nodeId: 'notify', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_notify_done',
      source: { nodeId: 'notify', port: 'success' },
      target: { nodeId: 'done', port: 'input' },
    },

    // 审查不通过就回到执行：这条边让工作流能循环修复……
    // 但图必须是 DAG，所以改为走「需要改动」分支到一个新的审批，
    // 由人决定是否重来。图纸里也没有回边。
    {
      op: 'connect',
      edgeId: 'e_review_back',
      source: { nodeId: 'review', port: 'changes_requested' },
      target: { nodeId: 'approve_diff', port: 'input' },
    },
  ],
};

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [ISSUE_FIX];

export function templateById(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
