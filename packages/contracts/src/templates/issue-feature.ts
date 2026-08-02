import { AGENT, REPORT_INSTRUCTION, type WorkflowTemplate } from './shared.js';

/**
 * 「Issue 需求开发」。
 *
 * 与「Issue 修复」的区别不在流程长短，在**第一步问的问题**：
 * 修复问「哪里坏了」，开发问「要做成什么样」。所以这条流程里
 * 有一道修复流程没有的门 —— 先把需求拆成方案交人确认，
 * 再动代码。需求做错了比 bug 修错了贵得多。
 *
 * 收尾产出一份 `report.json`：做了什么、没做什么、验证过什么。
 * 需求类工作最容易出的岔子是「做完了但不是想要的那个」，
 * 一份写清「我理解的需求是这样」的报告能在合 PR 之前拦住它。
 */
export const ISSUE_FEATURE: WorkflowTemplate = {
  id: 'github-issue-feature',
  name: 'Issue 需求开发',
  summary: '读需求 → 拆方案 → 人确认 → worktree → 实现 → 自测 → 审查 → PR → 报告',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 需求 Issue',
      position: { x: 40, y: 34 },
      config: {
        trigger: 'manual',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['issue', 'repo', 'repoPath'],
          properties: {
            issue: { type: 'string', title: 'Issue 编号' },
            repo: { type: 'object', format: 'repo', title: '仓库与分支' },
            // 与 repo 不是一回事：repo.name 是 GitHub 的 owner/name（gh 认它），
            // 这个是本机上的目录（git worktree add 认它）。填反了要跑到
            // worktree 那一步才报错
            repoPath: { type: 'string', title: '本地仓库路径' },
          },
        },
        injectedFields: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'read_issue',
      type: 'script.shell',
      title: '读需求',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        // 连评论一起读：需求类 issue 的真正约束往往在讨论里，
        // 只读正文会漏掉「这个方案我们试过了不行」
        script: [
          'set -euo pipefail',
          'gh issue view ${input.issue} --repo ${input.repo.name} --json number,title,body,labels,comments',
        ].join('\n'),
        outputParse: 'json',
        timeoutMs: 60_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'shape',
      type: 'ai.analyze',
      title: '拆解 · 要做成什么样',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        target: '${read_issue.success.parsed}',
        instruction: [
          '这是一条需求 Issue（含讨论）。先把需求拆清楚，再谈怎么做。',
          '',
          '要有四样：',
          '① **我理解的需求**：一句话，用户能一眼看出我有没有理解错',
          '② **验收标准**：怎样算做完了，写成能验证的条目',
          '③ **不做什么**：这一轮明确不覆盖的范围',
          '④ 2–3 个实现方案，每个写清改动面、风险、怎么验证',
          '',
          '讨论里如果已经排除过某个方案，**说出来并说明为什么**，',
          '不要重新提一遍。信息不够就走 insufficient_context，',
          '别猜一个需求出来 —— 需求做错了比 bug 修错了贵得多。',
        ].join('\n'),
      },
    },
    {
      op: 'addNode',
      nodeId: 'confirm_scope',
      type: 'approval',
      title: '审批 · 确认需求与方案',
      position: { x: 790, y: 34 },
      config: {
        title: '确认需求理解与实现方案',
        bodyMarkdown:
          '上一步给出了「我理解的需求」「验收标准」「不做什么」与几个方案。\n' +
          '**理解错了就在这里拦住** —— 往后每一步都建立在这个理解上。',
        interaction: 'single',
        /*
         * 标 `user`：需求确认是这条流程里唯一不该交给 AI 的一步。
         *
         * 「我理解的需求」正确与否，只有提需求的人知道 ——
         * 让 AI 自己确认自己的理解，这道门就等于没有。
         */
        decider: 'user',
        waitStrategy: 'forever',
      },
    },
    {
      op: 'addNode',
      nodeId: 'worktree',
      type: 'git.worktree',
      title: '创建 Git worktree',
      position: { x: 1040, y: 34 },
      config: {
        repoRoot: '${input.repoPath}',
        baseBranch: '${input.repo.branch}',
        branchTemplate: 'feat/${input.issue}-${run.id}',
        cleanupPolicy: 'manual',
      },
    },
    {
      op: 'addNode',
      nodeId: 'build',
      type: 'ai.execute',
      title: '实现 · 按确认的方案',
      position: { x: 1040, y: 184 },
      config: {
        agentProfileId: AGENT.builder,
        // **方案必须显式接进来**（与 `github-issue-fix.fix` 同一个坑）：
        // AI 节点之间没有共享上下文，「上一步确认的方案」不引用的话
        // 这个 agent 一个字都看不到。`shape` 只有 success 一个端口
        // 通向审批再到这里，引用它不会在别的路径上炸
        instruction: [
          '确认过的方案与验收标准：',
          '${shape.success}',
          '',
          '按上面的方案实现，小步提交，每步可单独验证。',
          '**先写测试**：验收标准里的每一条都该有一条测试对应它。',
          '偏离方案的话停下来走 needs_decision，不要自己改需求。',
        ].join('\n'),
        workdirSource: 'worktree',
        verifyCommands: ['pnpm test'],
      },
    },
    {
      op: 'addNode',
      nodeId: 'review',
      type: 'ai.review',
      title: '审查 · 对着验收标准',
      position: { x: 790, y: 184 },
      config: {
        agentProfileId: AGENT.reviewer,
        target: '${build.success}',
        instruction: [
          '只读检查。**第一件事是对着验收标准逐条核**：',
          '哪几条有测试覆盖、哪几条只是「看起来做了」。',
          '然后才是常规风险（错误分支、并发、日志脱敏）。',
        ].join('\n'),
        checklist: ['验收标准逐条对应', '测试真的会红', '错误分支', '日志脱敏'],
        severities: ['blocker', 'major', 'minor'],
      },
    },
    {
      op: 'addNode',
      nodeId: 'approve_pr',
      type: 'approval',
      title: '审批 · 开 PR',
      position: { x: 540, y: 184 },
      config: {
        title: '检查改动并开 PR',
        bodyMarkdown: '将要发生的外部写操作：commit → push → 创建 PR。不会动当前分支。',
        interaction: 'confirm',
        // 与「Issue 修复」同一条理由：推上去的分支与开出去的 PR
        // 别人立刻就看得见，撤回也是一次公开动作
        decider: 'user',
        waitStrategy: 'forever',
      },
    },
    {
      op: 'addNode',
      nodeId: 'push_pr',
      type: 'script.shell',
      title: 'Commit / Push / PR',
      position: { x: 290, y: 184 },
      config: {
        interpreter: 'zsh',
        script: [
          'set -euo pipefail',
          'ISSUE=${input.issue}',
          'cd ${worktree.success.path}',
          /*
           * **`git add -A` 会把跑验证命令时产生的副产物一起提交。**
           *
           * 实测（HuLuca1998/aiwf-issuefix-08021814 的 PR #2）：
           * agent 跑了 `npm test`，`node_modules/.package-map.json` 与
           * `.pnpm-workspace-state-v1.json` 跟着进了 PR —— 而仓库里
           * 没有 .gitignore 挡它们。审查者要在噪声里找那一行真改动。
           *
           * 与 CLAUDE.md 那条「绝不 git add -A」同一个道理：
           * 只提交**被跟踪的文件的改动** + 明确新增的源文件。
           * 常见的构建/依赖目录显式排除掉。
           */
          '# 已跟踪文件的改动全部纳入',
          'git add -u',
          '# 新文件按需纳入，但排开构建与依赖产物',
          'git ls-files --others --exclude-standard -z |',
          "  grep -zEv '^(node_modules|dist|build|target|\\.venv|__pycache__)/' |",
          '  while IFS= read -r -d \'\' f; do git add -- "$f"; done',
          "git diff --cached --quiet && { echo '没有任何改动，不建 PR'; exit 1; }",
          'git commit -qm "feat: 实现 #$ISSUE"',
          'git push -qu origin HEAD',
          'gh pr create --fill',
        ].join('\n'),
        timeoutMs: 300_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'write_report',
      type: 'ai.execute',
      title: '写出 report.json',
      position: { x: 40, y: 184 },
      config: {
        agentProfileId: AGENT.builder,
        instruction: [
          /*
           * **这里不接 `${review.…}`。**
           *
           * write_report 有三条互斥入边，`review` 的两个端口
           * （passed / changes_requested）都通向它 —— 运行时只有其中
           * 一个进作用域，引用哪个都会在另一半场景下炸
           * （`未定义的引用`）。`template-references.test.ts` 现在守着这条。
           *
           * 审查结论让 agent 自己去读：它带着系统 MCP，
           * `${run.id}` 给了它入口。
           */
          '这次运行的 id 是 ${run.id}。',
          '审查节点（review）的结论在这条运行的事件流里 —— 用系统 MCP 的',
          '`run_events` 读出来，找 `conversation.agent_message` 里 review 那条。',
          '读不到就直说读不到，别猜它写了什么。',
          '',
          REPORT_INSTRUCTION,
          '',
          '这份报告的读者是**提需求的人**。三件事必须有：',
          '① 我理解的需求（照第二步那份原样抄，别重新措辞）',
          '② 验收标准逐条的状态：做了 / 没做 / 做了但没测',
          '③ 明确没做的部分，以及为什么',
        ].join('\n'),
        workdirSource: 'inherit',
        verifyCommands: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'done',
      type: 'end',
      title: '结束',
      position: { x: 40, y: 334 },
      config: { outcome: 'success', artifacts: ['report.json'] },
    },
    {
      op: 'addNode',
      nodeId: 'stopped',
      type: 'end',
      title: '结束 · 需求不清或需要人定',
      position: { x: 790, y: 334 },
      config: { outcome: 'failure', artifacts: [] },
    },

    /*
     * 三个汇聚点，入边全是**互斥**的（走了这条就不会走那条）。
     * 默认策略是「等全部到齐」，按那个算它们永远执行不到 ——
     * 而症状是运行停在那里，状态却还是「运行中」。
     */
    {
      op: 'setJoin',
      nodeId: 'stopped',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    {
      op: 'setJoin',
      nodeId: 'write_report',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    {
      op: 'setJoin',
      nodeId: 'done',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },

    {
      op: 'connect',
      edgeId: 'e_entry_read',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'read_issue', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_read_shape',
      source: { nodeId: 'read_issue', port: 'success' },
      target: { nodeId: 'shape', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_shape_confirm',
      source: { nodeId: 'shape', port: 'success' },
      target: { nodeId: 'confirm_scope', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_shape_stopped',
      source: { nodeId: 'shape', port: 'insufficient_context' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_confirm_changes',
      source: { nodeId: 'confirm_scope', port: 'changes_requested' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_confirm_expired',
      source: { nodeId: 'confirm_scope', port: 'expired' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_confirm_worktree',
      source: { nodeId: 'confirm_scope', port: 'approved' },
      target: { nodeId: 'worktree', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_confirm_stopped',
      source: { nodeId: 'confirm_scope', port: 'rejected' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_worktree_build',
      source: { nodeId: 'worktree', port: 'success' },
      target: { nodeId: 'build', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_build_review',
      source: { nodeId: 'build', port: 'success' },
      target: { nodeId: 'review', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_build_stopped',
      source: { nodeId: 'build', port: 'needs_decision' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_review_approve',
      // ai.review 的端口是 passed / changes_requested，没有 success
      source: { nodeId: 'review', port: 'passed' },
      target: { nodeId: 'approve_pr', port: 'input' },
    },
    // 审查提了要改的地方：不自动重做（那会成环），直接出报告让人看 ——
    // 「审查说要改哪几处」正是最该送到人手上的结论
    {
      op: 'connect',
      edgeId: 'e_review_report',
      source: { nodeId: 'review', port: 'changes_requested' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_approve_push',
      source: { nodeId: 'approve_pr', port: 'approved' },
      target: { nodeId: 'push_pr', port: 'input' },
    },
    // 拒批不是失败：改动还在 worktree 里，报告照写 ——
    // 「审查完决定先不开 PR」是一个正当结果
    {
      op: 'connect',
      edgeId: 'e_approve_report',
      source: { nodeId: 'approve_pr', port: 'rejected' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_approve_changes',
      source: { nodeId: 'approve_pr', port: 'changes_requested' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_approve_expired',
      source: { nodeId: 'approve_pr', port: 'expired' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_push_report',
      source: { nodeId: 'push_pr', port: 'success' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_report_done',
      source: { nodeId: 'write_report', port: 'success' },
      target: { nodeId: 'done', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_report_done_2',
      source: { nodeId: 'write_report', port: 'needs_decision' },
      target: { nodeId: 'done', port: 'input' },
    },
  ],
};
