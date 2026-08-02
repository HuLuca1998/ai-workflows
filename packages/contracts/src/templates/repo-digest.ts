import { AGENT, REPORT_INSTRUCTION, type WorkflowTemplate } from './shared.js';

/**
 * 「仓库动态日报 / 周报 / 月报」。
 *
 * 定时触发的第一个真实用例：每天早上把过去一段时间的 issue、PR、commit
 * 拉下来，让分析师归纳成一份结构化报告，报告抽屉里能直接看。
 *
 * 周期做成**入口参数**而不是三个模板：日报周报月报的差别只有
 * `--since` 一个值，拆成三份的话改一处措辞要改三遍。
 */
export const REPO_DIGEST: WorkflowTemplate = {
  id: 'repo-digest',
  name: '仓库动态报告（日报 / 周报 / 月报）',
  summary: '定时拉 issue / PR / commit → AI 归纳 → 结构化报告',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 每天 09:00',
      position: { x: 40, y: 34 },
      config: {
        /*
         * 默认每天 09:00。**注意两条前提**（入口节点的配置弹层里也写着）：
         * 只跑已发布版本、只在应用开着时触发。
         * 想改成手动的话把 trigger 换成 manual —— 那时这两个字段会被忽略。
         */
        trigger: 'schedule',
        scheduleTime: '09:00',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          /*
           * 定时触发时**没有人在场填表** —— 调度器只能拿这里的
           * `default`。必填字段没有默认值的话，一到点就死在第一个
           * 用到它的节点上（`未定义的引用 ${input.repo.name}`），
           * 而手动跑一切正常，所以问题只在半夜发生。
           * `TRIGGER_INPUT_NO_DEFAULT` 在发布时就会拦下这种图。
           */
          required: ['repo', 'sinceDays'],
          properties: {
            repo: {
              type: 'object',
              format: 'repo',
              title: '仓库与分支',
              // 定时跑用的默认仓库。手动跑时表单里可以改
              default: { name: 'cli/cli', branch: 'trunk' },
            },
            sinceDays: {
              type: 'string',
              title: '回看几天',
              description: '日报填 1，周报填 7，月报填 30',
              default: '1',
            },
          },
        },
        injectedFields: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'collect',
      type: 'script.shell',
      title: '拉取仓库动态',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        /*
         * 一次 shell 拉三样，输出成一份 JSON。
         *
         * pipefail 必须有：这段里有 `gh … | jq`，管道的退出码默认取最后一节，
         * gh 认证失效时 jq 照样成功，节点变绿而 issues 是空数组 ——
         * 用户看到的是「这周没有任何动静」，而真相是没连上。
         *
         * `--jq` 用 gh 自带的而不是外部 jq：jq 不一定装了，
         * 而 gh 是这条流程的硬依赖，反正都要有。
         */
        script: [
          'set -euo pipefail',
          'REPO=${input.repo.name}',
          '# 分支也要用上。只用 repo.name 的话 `gh api …/commits` 走默认分支 ——',
          '# 用户在表单里选了别的分支，拿到的却是默认分支的提交（填了不生效）',
          'BRANCH=${input.repo.branch}',
          'DAYS=${input.sinceDays}',
          // shell 变量一律写成 `$VAR` 不带花括号：`${…}` 会先被引擎的
          // 插值器吃掉，而认不出的引用是**硬错误**（interp.rs）——
          // 症状是节点起手就报「未定义的引用 ${DAYS}」。
          //
          // 起始时间用 python3 算而不是 date：BSD 的 `date -v-7d` 与
          // GNU 的 `date -d "-7 days"` 语法不通用，macOS 上跑 GNU 那套
          // 会报 `illegal option -- d`（实测）。python3 两边都有
          'FROM=$(DAYS="$DAYS" python3 -c \'import datetime,os; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=int(os.environ["DAYS"]))).strftime("%Y-%m-%dT%H:%M:%SZ"))\')',
          'echo "统计区间自 $FROM" >&2',
          // createdAt 必须要：没有它就算不出「新开了多少 issue」。
          // 第一次实跑时漏了，agent 老老实实在报告里写了「新开 issue 数
          // 没有查到：issue 数据缺少 createdAt」—— 提示词里那句
          // 「没有数据支撑的不要写」起作用了，但缺的数据还是得补上
          'ISSUES=$(gh issue list --repo "$REPO" --state all --search "updated:>$FROM" --limit 50 --json number,title,state,createdAt,updatedAt,closedAt)',
          'PRS=$(gh pr list --repo "$REPO" --state all --search "updated:>$FROM" --limit 50 --json number,title,state,createdAt,updatedAt,mergedAt,author)',
          'COMMITS=$(gh api "repos/$REPO/commits?sha=$BRANCH&since=$FROM&per_page=50" --jq \'[.[] | {sha: .sha[0:7], message: (.commit.message | split("\\n")[0]), author: .commit.author.name, date: .commit.author.date}]\')',
          '# 三处都封顶 50。**把上限说出来**：AI 被要求写「合了多少 PR」，',
          '# 而它无从知道 50 是天花板还是真实值 —— 那个数字会被当成事实读',
          'printf \'{"from":"%s","limitPerList":50,"issues":%s,"pullRequests":%s,"commits":%s}\' "$FROM" "$ISSUES" "$PRS" "$COMMITS"',
        ].join('\n'),
        outputParse: 'json',
        timeoutMs: 120_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'digest',
      type: 'ai.analyze',
      title: '归纳 · 这段时间发生了什么',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        // 取 `.parsed` 而不是整个 `.success`：后者里 stdout 与 parsed
        // 各有一份同样的内容，agent 得先自己判断该看哪份
        target: '${collect.success.parsed}',
        instruction: [
          '把这段时间的仓库动态归纳成一份报告，给一个没跟进这个仓库的人看。',
          '要有：整体节奏（合了多少 PR、开了多少 issue）、值得注意的变化、',
          '卡住的事（长时间没动的 issue / PR）。',
          '**没有数据支撑的话不要写** —— 这份报告会被当成事实读。',
          '',
          '`limitPerList` 是每份清单的取数上限。某一类**正好等于**它时，',
          '真实数量可能更多 —— 那时写「至少 N 条」，不要写成确切数字。',
        ].join('\n'),
      },
    },
    {
      op: 'addNode',
      nodeId: 'write_report',
      type: 'ai.execute',
      title: '写出 report.json',
      position: { x: 790, y: 34 },
      config: {
        agentProfileId: AGENT.builder,
        instruction: [
          // **上一步的结论必须显式接进来。**
          // `ai.execute` 的契约里没有 `target` 字段，而每个 AI 节点
          // 各开一条 ACP 会话、没有跨节点上下文 —— 不接的话它的提示词里
          // 只有角色 + 记忆 + 这段指令，「把上一步的结论写成报告」
          // 说的那个「上一步」它一个字都看不到，只能编一份格式完美的空报告
          // （与 B-5 的 `ai.analyze.target` 完全同构）
          '上一步的结论：',
          '${digest.success}',
          '',
          REPORT_INSTRUCTION,
        ].join('\n'),
        // inherit：写进**运行目录**，结束节点从那里收。
        // worktree 那档会写进一个临时工作树，结束节点找不到
        workdirSource: 'inherit',
        verifyCommands: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'notify',
      type: 'notify',
      title: '系统通知',
      position: { x: 1040, y: 34 },
      config: {
        title: '仓库动态报告已生成',
        body: '点开看这段时间发生了什么。',
        clickAction: 'open_run',
      },
    },
    {
      op: 'addNode',
      nodeId: 'done',
      type: 'end',
      title: '结束',
      position: { x: 1290, y: 34 },
      config: { outcome: 'success', artifacts: ['report.json'] },
    },
    {
      op: 'addNode',
      nodeId: 'stopped',
      type: 'end',
      title: '结束 · 材料不足',
      position: { x: 540, y: 184 },
      config: { outcome: 'failure', artifacts: [] },
    },

    /*
     * `done` 的两条入边来自 notify 的**互斥**端口（发出去 / 没发出去）。
     * 默认策略是「等全部到齐」，按那个算它永远执行不到 ——
     * 整条流程会停在通知那一步，运行状态却是「运行中」。
     */
    {
      op: 'setJoin',
      nodeId: 'done',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    /* `stopped` 同理：材料不足与需要人工决定是两条互斥的路。 */
    {
      op: 'setJoin',
      nodeId: 'stopped',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },

    {
      op: 'connect',
      edgeId: 'e_entry_collect',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'collect', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_collect_digest',
      source: { nodeId: 'collect', port: 'success' },
      target: { nodeId: 'digest', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_digest_report',
      source: { nodeId: 'digest', port: 'success' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    // 材料不够时明确停在失败终点，而不是走到端口就没路了 ——
    // 后者会让运行「以成功结束而什么都没做」
    {
      op: 'connect',
      edgeId: 'e_digest_stopped',
      source: { nodeId: 'digest', port: 'insufficient_context' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_report_notify',
      source: { nodeId: 'write_report', port: 'success' },
      target: { nodeId: 'notify', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_report_stopped',
      source: { nodeId: 'write_report', port: 'needs_decision' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_notify_done',
      source: { nodeId: 'notify', port: 'success' },
      target: { nodeId: 'done', port: 'input' },
    },
    // 通知发不出去不该把整份报告丢掉 —— 报告已经写好了
    {
      op: 'connect',
      edgeId: 'e_notify_failed_done',
      source: { nodeId: 'notify', port: 'failed' },
      target: { nodeId: 'done', port: 'input' },
    },
  ],
};
