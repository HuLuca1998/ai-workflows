import { AGENT, REPORT_INSTRUCTION, type WorkflowTemplate } from './shared.js';

/**
 * 「PR 评论回访」。
 *
 * 每天扫一遍自己开着的 PR：哪些收到了评论还没回、哪些 CI 红了、
 * 哪些已经批了可以合、哪些已经躺了太久。
 *
 * 解决的是一个具体的浪费：**开完 PR 就忘了它**。评论静静躺三天，
 * 而作者以为在等 review、reviewer 以为在等作者改。
 *
 * 只读：不回评论、不合 PR。「该回什么」是人的判断，
 * 一个自动回复的机器人只会让 reviewer 更不想看这个 PR。
 */
export const PR_FOLLOWUP: WorkflowTemplate = {
  id: 'pr-followup',
  name: 'PR 评论回访',
  summary: '每天扫自己的开着的 PR → 哪些等你回、哪些能合 → 报告（只读）',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 每天 18:00',
      position: { x: 40, y: 34 },
      config: {
        // 傍晚而不是早上：这份清单说的是「今天收工前还该处理什么」
        trigger: 'schedule',
        scheduleTime: '18:00',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['repo'],
          properties: {
            repo: { type: 'object', format: 'repo', title: '仓库与分支' },
            author: {
              type: 'string',
              title: 'PR 作者',
              description: 'GitHub 用户名。填 @me 表示当前登录的账号',
              default: '@me',
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
      title: '拉开着的 PR 与评论',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        /*
         * 分两步：先列 PR，再逐个取评论与 CI 状态。
         *
         * `gh pr list` 的 `--json comments` 只给条数不给内容，
         * 而「最后一条评论是谁发的」正是判断「该谁动」的关键 ——
         * 所以要对每个 PR 再调一次 `gh pr view`。
         *
         * 逐个调的代价是 N 次 API 请求，所以 `--limit 20` 封顶：
         * 同时开着二十个以上 PR 的话，这份清单本身也读不完了。
         */
        script: [
          'set -euo pipefail',
          'REPO=${input.repo.name}',
          'AUTHOR=${input.author}',
          '',
          'NUMBERS=$(gh pr list --repo "$REPO" --author "$AUTHOR" --state open --limit 20 --json number --jq \'.[].number\')',
          'if [ -z "$NUMBERS" ]; then',
          '  echo \'{"pullRequests":[]}\'',
          '  exit 0',
          'fi',
          '',
          'DETAILS=""',
          // 用 `while read` 逐行读，不用 zsh 的 `${=VAR}` 分词：
          // `${…}` 会先被引擎的插值器吃掉，而认不出的引用是硬错误
          // （template-references.test.ts 守着这条）
          'while IFS= read -r N; do',
          '  ONE=$(gh pr view "$N" --repo "$REPO" --json number,title,url,isDraft,createdAt,updatedAt,reviewDecision,statusCheckRollup,comments,reviews)',
          '  DETAILS="$DETAILS$ONE",',
          'done <<< "$NUMBERS"',
          '',
          '# 去掉末尾逗号再拼成数组。用 python 而不是 sed：',
          '# PR 正文里可能有任何字符，字符串裁剪不安全',
          'DETAILS="$DETAILS" python3 -c \'import json,os; raw=os.environ["DETAILS"].rstrip(","); print(json.dumps({"pullRequests": json.loads("[" + raw + "]")}))\'',
        ].join('\n'),
        outputParse: 'json',
        timeoutMs: 180_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'triage',
      type: 'ai.analyze',
      title: '分类 · 该谁动',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        target: '${collect.success.parsed}',
        instruction: [
          '这是我开着的 PR 清单，含评论、review 结论与 CI 状态。',
          '',
          '按「今天收工前该做什么」分四类：',
          '① **等我回**：最后一条评论/review 不是我发的，且提了问题或要改',
          '② **可以合**：reviewDecision 是 APPROVED 且 CI 全绿',
          '③ **CI 红了**：statusCheckRollup 里有 FAILURE，写清是哪个 check',
          '④ **在等别人**：已经 request review 但对方还没看',
          '',
          '每条给出 PR 编号、标题、链接、以及**一句话说清下一步动作**。',
          '',
          '两条要求：',
          '· 草稿 PR（isDraft）单独归一类，不要混进「等我回」',
          '· `pullRequests` 是空数组时，那是「没有开着的 PR」，',
          '  这是好消息，直说就行 —— 别为了凑内容编出建议',
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
          REPORT_INSTRUCTION,
          '',
          '「等我回」那一类放在最前面，并且用 links 块给出可点的 PR 链接 ——',
          '这份报告的用处就是让人一点就跳过去。',
        ].join('\n'),
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
        title: 'PR 回访清单已生成',
        body: '看看收工前还有哪几个等你。',
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
      title: '结束 · 拉不到 PR',
      position: { x: 540, y: 184 },
      config: { outcome: 'failure', artifacts: [] },
    },

    {
      op: 'setJoin',
      nodeId: 'stopped',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    {
      op: 'setJoin',
      nodeId: 'done',
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
      edgeId: 'e_collect_triage',
      source: { nodeId: 'collect', port: 'success' },
      target: { nodeId: 'triage', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_triage_report',
      source: { nodeId: 'triage', port: 'success' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_triage_stopped',
      source: { nodeId: 'triage', port: 'insufficient_context' },
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
    {
      op: 'connect',
      edgeId: 'e_notify_failed_done',
      source: { nodeId: 'notify', port: 'failed' },
      target: { nodeId: 'done', port: 'input' },
    },
  ],
};
