import { AGENT, REPORT_INSTRUCTION, type WorkflowTemplate } from './shared.js';

/**
 * 「服务器日志巡检」。
 *
 * 每天定时上线上机器抓两样东西：最近反复出现的错误，以及慢查询。
 * 归因交给分析师，结论落成报告。
 *
 * **只读。** 整条流程里没有一条会改线上状态的命令 —— 抓日志、
 * 统计、读慢查询日志，全是 read。要在线上做处置是另一回事，
 * 那需要一道审批节点，而这份模板刻意不带：一份「巡检」模板
 * 顺手能改线上，是最容易被误用的形态。
 *
 * ## 一份真实的填法
 *
 * 以 pp-game 的 live 环境为例（配置见它仓库的 `deploy/live.sh`）：
 *
 * | 字段         | 填什么                          |
 * | ------------ | ------------------------------- |
 * | SSH 目标     | `root@<live 机器 IP>`           |
 * | SSH 端口     | `2220`（**不是 22**）           |
 * | 应用日志路径 | `/srv/pp-game-live/logs/*.log`  |
 * | 慢查询日志   | 数据库那台上的 slow log 绝对路径 |
 * | 回看几小时   | `24`                            |
 *
 * **具体的机器地址不写进模板**：这份种子数据会进每一个用户的库，
 * 把某个人的生产 IP 塞进去既没用又危险。上面那几个值填进启动表单即可，
 * 表单里的值只存在这一次运行的 inputs 里（而且会过一遍脱敏器）。
 *
 * 前提是那台机器**配好了免密登录** —— 脚本用 `BatchMode=yes`，
 * 没配好会立刻失败而不是挂在密码提示上（挂着的那种最难查：
 * 节点显示「运行中」十分钟，日志里什么都没有）。
 */
export const SERVER_LOG_TRIAGE: WorkflowTemplate = {
  id: 'server-log-triage',
  name: '服务器日志巡检',
  summary: '定时 SSH 抓错误与慢查询 → AI 归因 → 报告（只读，不改线上）',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 每天 08:30',
      position: { x: 40, y: 34 },
      config: {
        trigger: 'schedule',
        scheduleTime: '08:30',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['sshTarget', 'logPath'],
          properties: {
            sshTarget: {
              type: 'string',
              title: 'SSH 目标',
              description: '形如 root@1.2.3.4。端口不是 22 时在下面单独填',
            },
            sshPort: {
              type: 'string',
              title: 'SSH 端口',
              description: '很多线上机器改过端口（pp-game 的 live 是 2220）',
              default: '22',
            },
            logPath: {
              type: 'string',
              title: '应用日志路径',
              description: '服务器上的绝对路径，支持通配。例：/srv/pp-game-live/logs/*.log',
            },
            slowLogPath: {
              type: 'string',
              title: '慢查询日志路径',
              description:
                '留空则跳过慢查询那一段。MySQL 常见位置 /var/log/mysql/slow.log；' +
                'MongoDB 的慢查询在 mongod.log 里，路径填它即可',
              default: '',
            },
            hours: { type: 'string', title: '回看几小时', default: '24' },
          },
        },
        injectedFields: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'collect',
      type: 'script.shell',
      title: '抓错误与慢查询',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        /*
         * 一次 ssh 会话把两样都抓回来，输出成 JSON。
         *
         * 几个刻意的选择：
         *
         * - `BatchMode=yes`：没配好免密时**立刻失败**，而不是挂在
         *   密码提示上直到超时。挂着的那种最难查 —— 节点显示「运行中」
         *   十分钟，日志里什么都没有
         * - `ConnectTimeout=15`：机器不通时快点失败
         * - 错误行按「去掉数字与时间戳」归一化再计数：不归一的话
         *   同一个错误因为 request-id 不同会被算成一千种
         * - 只取前 20 类：一份读得完的报告比一份完整的有用
         */
        /*
         * shell 变量一律写成 `$VAR`，**不带花括号**。
         *
         * `${…}` 会先被引擎的插值器吃掉，而认不出的引用是硬错误
         * （`crates/engine/src/interp.rs`）—— 症状是节点起手就报
         * 「未定义的引用 ${HOURS}」，而脚本本身一个字都没错。
         * 这条被 `template-references.test.ts` 守着。
         */
        script: [
          'set -euo pipefail',
          'TARGET=${input.sshTarget}',
          'PORT=${input.sshPort}',
          'LOG=${input.logPath}',
          'SLOW=${input.slowLogPath}',
          'HOURS=${input.hours}',
          'MINUTES=$(( HOURS * 60 ))',
          '',
          '# 远端那段拼成一行字符串再发过去。用 heredoc 的话，',
          '# 里面的 $ 会在本地先展开一轮，远端拿到的是空变量',
          'REMOTE="set -u;',
          'files=\\$(find $LOG -type f -mmin -$MINUTES 2>/dev/null | head -20);',
          '[ -z \\"\\$files\\" ] && { echo NO_LOG_FILES; exit 0; };',
          "grep -hiE 'error|exception|fatal|panic|traceback' \\$files 2>/dev/null",
          "  | sed -E 's/[0-9-]{10}[T ][0-9:.,]+//g; s/[0-9a-f]{8,}/<id>/g; s/[0-9]+/<n>/g'",
          '  | sort | uniq -c | sort -rn | head -20"',
          '',
          'ERRORS=$(ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "$REMOTE" || echo SSH_FAILED)',
          'if [ -n "$SLOW" ]; then',
          '  SLOWQ=$(ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" "tail -c 200000 $SLOW 2>/dev/null | grep -A3 -i Query_time | head -100" || echo SSH_FAILED)',
          'else',
          '  SLOWQ=""',
          'fi',
          '',
          '# 用 python 拼 JSON：日志正文里有引号和反斜杠，printf 拼不安全',
          'ERRORS="$ERRORS" SLOWQ="$SLOWQ" HOURS="$HOURS" python3 -c \'import json,os; print(json.dumps({"hours": os.environ["HOURS"], "errors": os.environ["ERRORS"], "slowQueries": os.environ["SLOWQ"]}))\'',
        ].join('\n'),
        outputParse: 'json',
        timeoutMs: 180_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'triage',
      type: 'ai.analyze',
      title: '归因 · 哪些要今天处理',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        target: '${collect.success.parsed}',
        instruction: [
          '这是一台线上机器最近的错误统计与慢查询片段。',
          '',
          '按「今天该不该处理」排序，每条说清：出现了多少次、',
          '最可能的原因、以及**怎么验证这个猜测**（一条只读命令或一处代码位置）。',
          '',
          '两条要求：',
          '① 计数是归一化之后的（时间戳与 id 被替换成占位符），',
          '  所以「同一类」不等于「同一次」，别把次数当成受影响用户数',
          '② 输出里如果出现 SSH_FAILED 或 NO_LOG_FILES，',
          '  那不是「没有错误」而是**没抓到** —— 直说抓取失败，别报平安',
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
        instruction: REPORT_INSTRUCTION,
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
        title: '服务器日志巡检完成',
        body: '点开看今天该先处理什么。',
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
      title: '结束 · 没抓到日志',
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
