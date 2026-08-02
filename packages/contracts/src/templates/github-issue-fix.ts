import { AGENT, type WorkflowTemplate } from './shared.js';

/**
 * 「GitHub Issue 修复」模板。
 *
 * 「GitHub Issue 修复」是 M1 的出口标准：这个模板必须能完整搭出、校验通过、
 * 发布为 v1。节点与连线取自图纸「02 画布编辑器」里的示例工作流
 * （原型的 nodes / edges 数组），包括那段并行探索（3 路分析汇聚到子工作流）。
 *
 * 模板以**结构化操作**的形式给出，而不是一份现成的图：
 * 这样新建时走的是与手工搭建、与 AI 改图完全相同的路径（applyPatch），
 * 模板本身也就被同一套校验守住了。
 */

/** 图纸里那条 9 节点主线 + 3 路并行探索。 */
export const ISSUE_FIX: WorkflowTemplate = {
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
          required: ['issue', 'repo', 'repoPath'],
          properties: {
            issue: { type: 'string', title: 'Issue 编号' },
            // `format: 'repo'` —— 启动表单据此渲染仓库与分支两个联动下拉，
            // 列表来自本机已登录的 gh。值是 `{name, branch}`：
            // 分支只有在某个仓库里才有意义，拆成两个字段填的话，
            // 用户可以给 A 仓库配上一个 B 仓库才有的分支，
            // 而那要等运行跑到 git checkout 才报错
            repo: { type: 'object', format: 'repo', title: '仓库与分支' },
            /**
             * 本地仓库路径。**与上面那个不是一回事**，两个都要。
             *
             * `repo.name` 是 GitHub 上的 `owner/name`，`gh issue view --repo`
             * 和 `gh pr create` 认它；`git worktree add` 认的是这台机器上
             * 的一个目录。把前者填给 worktree 的话，git 会去找一个叫
             * `owner/name` 的相对路径 —— 报错发生在运行跑到第四个节点时，
             * 而原因在第一个节点填的参数里。
             *
             * 这正是内置示例此前跑不通的一处：`repoRoot: '${input.repo.name}'`。
             */
            repoPath: { type: 'string', format: 'directory', title: '本地仓库路径' },
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
        /**
         * 变量走 `${…}` 插值，不走环境变量。
         *
         * 这里原本写的是 `"$ISSUE" --repo "$REPO"` —— 而引擎注入的环境变量
         * 叫 `AIWF_ISSUE` / `AIWF_REPO`（`interp.rs` 的 `env_vars`）。
         * 名字对不上，两个都是空串，gh 报 `invalid issue format: ""`。
         * 就算名字对上也没用：`repo` 是个对象，`AIWF_REPO` 会是一整段 JSON，
         * `--repo` 吃不下。
         *
         * 实测这条：run_18c740d6394b3c70 就死在这一步。
         *
         * `${…}` 的值由引擎加过单引号（`interp.rs` 的 `shell_quote`），
         * 所以外面**不要**再套引号 —— 套了会变成 `"'573'"`。
         */
        // `set -euo pipefail` 不是仪式：没有它，后面有人加一个
        // `| head` 裁输出时，gh 的失败会被管道最后一节的退出码盖掉 ——
        // 节点显示成功，而分析师收到的是空字符串
        script: [
          'set -euo pipefail',
          'gh issue view ${input.issue} --repo ${input.repo.name} --json title,body,labels',
        ].join('\n'),
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
        /**
         * 取 `.parsed`，不是整个 `.success`。
         *
         * 脚本节点的输出形状是
         * `{stdout, stderr, parsed, parseError, truncated}`。引用整个对象
         * 时，分析师收到的是一坨 JSON —— 里面 issue 正文出现**两次**
         * （`stdout` 里一份带 `\n` 转义的，`parsed` 里一份），
         * 而它得先自己判断该看哪一份。
         *
         * 实测：`crates/engine/tests/template_e2e_test.rs` 那条断言拿真实
         * issue 跑出来的整个对象有 1.6KB，其中一半是重复的转义正文。
         */
        target: '${read_issue.success.parsed}',
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
        // 「探索完成 → 开始编辑」之间这一道。
        //
        // 跟随全局档位：这一步的性质是「从几个方案里挑一个」，
        // AI 有能力挑（它刚写完那几个方案），而用户想自己挑的时候
        // 把设置调到最严那档就行
        decider: 'auto',
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
        // 本地路径，不是 `owner/name`。原来写的是 `${input.repo.name}`，
        // git 会拿它当相对路径去找一个叫 `owner/name` 的目录
        repoRoot: '${input.repoPath}',
        baseBranch: '${input.repo.branch}',
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
        /*
         * **上一步的产出必须显式接进来。**
         *
         * 原来这里只有「按选定方案修改代码」一句 —— 而 AI 节点之间
         * 没有共享上下文，那个 agent 手上一个字的方案都没有。
         * 实测（真仓库 issue 修复）：它什么也改不了，跑了一次
         * `pnpm test` 留下个锁文件就走 `needs_decision`，
         * 而流程照样把那个锁文件开成了 PR。
         *
         * `analyze` 是 `${analyze.success}`——  它只有 success 一个端口
         * 通向审批再到这里，引用它不会在别的路径上炸。
         */
        instruction: [
          '要修的 Issue：',
          '${read_issue.success.stdout}',
          '',
          '分析给出的方案（已经过人工选定）：',
          '${analyze.success}',
          '',
          '按上面的方案改代码。小步提交，每步可验证。',
          '',
          '**改完自己核一遍**：真的动了要动的那个文件吗？',
          '一个字都没改的话，直说「没有改动」并说明为什么 ——',
          '不要跑一遍测试就当交差。',
        ].join('\n'),
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
        // 审查结论要接进来 —— 不接的话它按什么分级？
        // `review` 只有 passed 一个端口通向这里
        instruction: [
          '审查结论：',
          '${review.passed}',
          '',
          '按影响面给出 L1–L3 分级；push 与建 PR 属于 L3。',
        ].join('\n'),
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
        /**
         * 「编码完成 → 开 PR」之间这一道，**标成必须人批**。
         *
         * 权限由流程管：引擎不再替你拦 `git push`，拦它的就是这一道门。
         * 标 `user` 的意思是「即使全局档位是 AI 审批，这一道也停下来问我」——
         * 推上去的分支与开出去的 PR 别人立刻就看得见，撤回也是一次公开动作。
         *
         * 想让它也自动跑的话，把全局档位调到「无人值守」。
         * 那一档的含义就是「连标了必须我批的也交给 AI」，
         * 而做出那个选择的是用户，不是这份模板。
         */
        decider: 'user',
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
    /**
     * 走不下去时的明确终点。
     *
     * `ai.analyze` 的 `insufficient_context` 端口此前没有下游 ——
     * 分析师说「材料不够，没法定位根因」的那一支走到端口就停了，
     * 运行**以成功状态结束**，而什么都没做。
     *
     * 有一个 outcome 为 failed 的终点，用户至少能在运行列表里
     * 一眼看出这次没成，以及停在哪一步。
     */
    {
      op: 'addNode',
      nodeId: 'stopped',
      type: 'end',
      title: '结束 · 材料不足',
      position: { x: 1040, y: 34 },
      config: { outcome: 'failure' },
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
    /**
     * 决策判定为低风险时直接提交，不再多问一次。
     *
     * 这条边此前**不存在** —— `decide` 有 `auto_decided` 与 `escalated`
     * 两个端口，模板只连了后者。于是 AI 判定「这次改动够小，可以自动放行」
     * 的那一支走到端口就没路了：节点成功、运行结束、PR 没建，
     * 而事件流里看不出哪里断的。
     *
     * 「会不会有人在这里偷偷 push」由审批档管，不靠工作流自己多摆一个审批节点。
     */
    {
      op: 'connect',
      edgeId: 'e_decide_push',
      source: { nodeId: 'decide', port: 'auto_decided' },
      target: { nodeId: 'push_pr', port: 'input' },
    },

    /**
     * 两个汇聚点都改成「任一到达即可」。
     *
     * 默认策略是 `All`（`graph.rs` 的 `join_strategy`）—— 而这两个节点
     * 的入边**互斥**：`review` 只走 passed 或 changes_requested 之一，
     * `decide` 只走 auto_decided 或 escalated 之一。按「等全部到齐」算，
     * 它们**永远凑不齐**，于是从 `approve_diff` 往后整条尾巴
     * （审批 → 提交 → PR → 通知 → 结束）一次都执行不到。
     *
     * 这一条比变量名写错那处更根本：那个报错至少停在第二个节点上，
     * 这个是安静地跑完然后什么都没发生。
     */
    {
      op: 'setJoin',
      nodeId: 'approve_diff',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    {
      op: 'setJoin',
      nodeId: 'push_pr',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },

    /**
     * 所有「走不下去」的分支都收到同一个终点。
     *
     * 这些端口此前**全部悬空**：分析说材料不够、用户拒绝审批、
     * 用户要求先改改再说 —— 每一种都是「节点成功地走了某个端口，
     * 而那个端口没有下游」。运行就此结束，状态是**成功**。
     *
     * 用户拒绝了一次审批，运行记录上显示这次跑成功了 ——
     * 这是最典型的「假装成功」，而且它藏在图的形状里，
     * 不在任何一段代码里。
     */
    {
      op: 'connect',
      edgeId: 'e_analyze_stopped',
      source: { nodeId: 'analyze', port: 'insufficient_context' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_plan_changes_stopped',
      source: { nodeId: 'approve_plan', port: 'changes_requested' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_plan_rejected_stopped',
      source: { nodeId: 'approve_plan', port: 'rejected' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_plan_expired_stopped',
      source: { nodeId: 'approve_plan', port: 'expired' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_diff_changes_stopped',
      source: { nodeId: 'approve_diff', port: 'changes_requested' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_diff_rejected_stopped',
      source: { nodeId: 'approve_diff', port: 'rejected' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_diff_expired_stopped',
      source: { nodeId: 'approve_diff', port: 'expired' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_fix_needs_decision',
      source: { nodeId: 'fix', port: 'needs_decision' },
      target: { nodeId: 'approve_diff', port: 'input' },
    },
    // 这些入边一条都不会同时到达 —— 必须是「任一到达即可」
    {
      op: 'setJoin',
      nodeId: 'stopped',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
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
