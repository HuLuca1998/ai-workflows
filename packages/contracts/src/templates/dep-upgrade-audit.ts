import { AGENT, REPORT_INSTRUCTION, type WorkflowTemplate } from './shared.js';

/**
 * 「依赖升级巡检」。
 *
 * 每周扫一遍过期依赖与已知漏洞，让 AI 判「哪些该现在升、哪些先别动」，
 * 出一份报告。**只读**：不改 package.json、不跑安装、不开 PR。
 *
 * 刻意不带「顺手升级」那一步 —— 依赖升级的风险不在升级本身，
 * 在「升了什么、为什么、验证了没有」。一份让人五分钟看完做决定的报告，
 * 比一个自动开出来、没人敢合的 PR 有用。
 */
export const DEP_UPGRADE_AUDIT: WorkflowTemplate = {
  id: 'dep-upgrade-audit',
  name: '依赖升级巡检',
  summary: '每周扫过期依赖与漏洞 → AI 判优先级 → 报告（只读，不改仓库）',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 每周一 10:00',
      position: { x: 40, y: 34 },
      config: {
        // 每周一次靠「每天定时 + AI 自己判断今天该不该出报告」不靠谱。
        // 契约现在只有「每天几点」与「每隔多少分钟」——
        // 用 10080 分钟（7 天）表达「每周」，从发布那一刻起算
        trigger: 'interval',
        intervalMinutes: 10_080,
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['repoPath'],
          properties: {
            repoPath: {
              type: 'string',
              title: '本地仓库路径',
              description: '含 package.json 的目录。只读，不会改动任何文件',
              // 定时触发没人填表，必填字段必须有默认值。
              // `.` 是运行目录 —— 不改的话扫的是运行目录本身，
              // 那里没有 package.json，脚本会明确报「仓库路径不存在」
              default: '.',
            },
          },
        },
        injectedFields: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'scan',
      type: 'script.shell',
      title: '扫过期依赖与漏洞',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        /*
         * 两条命令都**故意允许非零退出**：
         *
         * `pnpm outdated` 有过期包时退出码是 1，`pnpm audit` 有漏洞时
         * 也非零。按失败处理的话，「有东西要升」反而让节点红掉 ——
         * 而那正是这条流程要找的东西。所以显式 `|| true`，
         * 并把真正的失败（命令不存在、目录不对）交给 `cd` 那一步兜。
         *
         * 不用 set -e 全局：它会在第一条 outdated 非零时直接退出。
         */
        script: [
          'set -uo pipefail',
          'cd ${input.repoPath} || { echo "仓库路径不存在" >&2; exit 1; }',
          'command -v pnpm >/dev/null || { echo "这台机器上没有 pnpm" >&2; exit 1; }',
          '',
          '# --json 在有过期包时退出码 1，这里是预期结果不是失败',
          'OUTDATED=$(pnpm outdated --format json 2>/dev/null || true)',
          '[ -z "$OUTDATED" ] && OUTDATED="{}"',
          'AUDIT=$(pnpm audit --json 2>/dev/null || true)',
          '[ -z "$AUDIT" ] && AUDIT="{}"',
          '',
          'OUTDATED="$OUTDATED" AUDIT="$AUDIT" python3 -c \'import json,os; print(json.dumps({"outdated": os.environ["OUTDATED"], "audit": os.environ["AUDIT"]}))\'',
        ].join('\n'),
        outputParse: 'json',
        timeoutMs: 300_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'triage',
      type: 'ai.analyze',
      title: '判优先级 · 哪些该现在升',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        target: '${scan.success.parsed}',
        instruction: [
          '这是一个仓库的过期依赖清单与安全审计结果。',
          '',
          '分成三档，每档给出具体包名与版本跨度：',
          '① **现在就升**：有已知漏洞，或补丁版本（patch）且改动面小',
          '② **排期升**：跨了 minor / major，要读 changelog 与跑回归',
          '③ **先别动**：升级成本明显大于收益，说清为什么',
          '',
          '三条要求：',
          '· 每一条都要写**验证方式**（跑哪个测试、看哪个页面）',
          '· major 版本跨越必须单独列出来，不要混进「现在就升」',
          '· 输入里如果两份 JSON 都是空对象 `{}`，那不是「没有过期依赖」',
          '  而是**没扫到** —— 直说扫描失败，别报平安',
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
          '${triage.success}',
          '',
          REPORT_INSTRUCTION,
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
      position: { x: 1040, y: 34 },
      config: { outcome: 'success', artifacts: ['report.json'] },
    },
    {
      op: 'addNode',
      nodeId: 'stopped',
      type: 'end',
      title: '结束 · 没扫到',
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
      edgeId: 'e_entry_scan',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'scan', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_scan_triage',
      source: { nodeId: 'scan', port: 'success' },
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
