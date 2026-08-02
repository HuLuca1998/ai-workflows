import { AGENT, REPORT_INSTRUCTION, type WorkflowTemplate } from './shared.js';

/**
 * 「发布前检查单」。
 *
 * 发布前跑一遍：测试、构建、以及**上一个 tag 到现在的改动**，
 * 让审查者对着改动核一遍风险，出一份「能不能发」的报告。
 *
 * 与「跑一遍 CI」的区别是最后那一步：CI 回答「有没有红」，
 * 这条流程回答「**这次发的是什么，有什么风险**」——
 * 而后者才是按下发布按钮之前真正要知道的。
 *
 * 手动触发。发布是有人做的决定，定时跑一份没人看的检查单
 * 只会让它变成背景噪声。
 */
export const RELEASE_CHECKLIST: WorkflowTemplate = {
  id: 'release-checklist',
  name: '发布前检查单',
  summary: '跑测试与构建 → 列出上个 tag 以来的改动 → AI 核风险 → 能不能发',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 手动',
      position: { x: 40, y: 34 },
      config: {
        trigger: 'manual',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['repoPath'],
          properties: {
            repoPath: { type: 'string', title: '本地仓库路径' },
            testCommand: {
              type: 'string',
              title: '测试命令',
              default: 'pnpm verify',
            },
            buildCommand: {
              type: 'string',
              title: '构建命令',
              description: '留空则跳过构建这一段',
              default: '',
            },
          },
        },
        injectedFields: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'check',
      type: 'script.shell',
      title: '跑测试与构建，列改动',
      position: { x: 290, y: 34 },
      config: {
        interpreter: 'zsh',
        /*
         * 测试与构建**允许失败**，退出码收进 JSON 交给下一步判断。
         *
         * 让节点直接红掉的话，流程停在这里，而「测试红了」恰恰是
         * 这份报告最该说清楚的那一条 —— 用户要的是「能不能发、
         * 为什么不能」，不是一个失败的节点。
         *
         * 真正该让节点失败的只有「路径不对」这类前提问题。
         */
        script: [
          'set -uo pipefail',
          'cd ${input.repoPath} || { echo "仓库路径不存在" >&2; exit 1; }',
          'TEST_CMD=${input.testCommand}',
          'BUILD_CMD=${input.buildCommand}',
          '',
          'TEST_OUT=$(eval "$TEST_CMD" 2>&1 | tail -80); TEST_CODE=$?',
          'if [ -n "$BUILD_CMD" ]; then',
          '  BUILD_OUT=$(eval "$BUILD_CMD" 2>&1 | tail -40); BUILD_CODE=$?',
          'else',
          '  BUILD_OUT="（没配构建命令，跳过）"; BUILD_CODE=0',
          'fi',
          '',
          '# 上一个 tag 到现在。一个 tag 都没有时退回最近 50 条',
          'LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")',
          'if [ -n "$LAST_TAG" ]; then',
          '  RANGE="$LAST_TAG..HEAD"',
          'else',
          '  RANGE="HEAD~50..HEAD"',
          'fi',
          'CHANGES=$(git log --no-merges --pretty=format:"%h %s" "$RANGE" 2>/dev/null | head -100 || echo "")',
          'FILES=$(git diff --stat "$RANGE" 2>/dev/null | tail -30 || echo "")',
          '',
          'TEST_OUT="$TEST_OUT" TEST_CODE="$TEST_CODE" BUILD_OUT="$BUILD_OUT" BUILD_CODE="$BUILD_CODE" \\',
          'LAST_TAG="$LAST_TAG" CHANGES="$CHANGES" FILES="$FILES" python3 -c \'import json,os; print(json.dumps({k.lower(): os.environ[k] for k in ["TEST_OUT","TEST_CODE","BUILD_OUT","BUILD_CODE","LAST_TAG","CHANGES","FILES"]}))\'',
        ].join('\n'),
        outputParse: 'json',
        timeoutMs: 900_000,
      },
    },
    {
      op: 'addNode',
      nodeId: 'assess',
      type: 'ai.review',
      title: '核一遍 · 能不能发',
      position: { x: 540, y: 34 },
      config: {
        agentProfileId: AGENT.reviewer,
        target: '${check.success.parsed}',
        instruction: [
          '这是一次发布前的检查结果：测试输出与退出码、构建输出与退出码、',
          '上一个 tag 以来的提交与改动文件。',
          '',
          '回答一个问题：**这次能不能发**。',
          '',
          '· `test_code` 非零 = 测试没过。**那就是不能发**，别找补',
          '· 逐条看提交，标出风险高的那几条（改了数据迁移、',
          '  改了对外接口、改了权限判断、动了发布脚本本身）',
          '· 如果 `last_tag` 是空的，说明这个仓库还没打过 tag，',
          '  改动范围是「最近 50 条」而不是「上次发布以来」—— 说出来',
          '',
          '结论写成三选一：可以发 / 有条件可发（列出条件）/ 不能发。',
        ].join('\n'),
        checklist: ['测试退出码', '数据迁移', '对外接口', '权限判断', '发布脚本本身'],
        severities: ['blocker', 'major', 'minor'],
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
          '这份报告要在**第一屏**回答「能不能发」：',
          'outcome 用 success（可以发）/ warning（有条件）/ failed（不能发），',
          'summary 第一句就是结论本身，不要铺垫。',
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
      edgeId: 'e_entry_check',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'check', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_check_assess',
      source: { nodeId: 'check', port: 'success' },
      target: { nodeId: 'assess', port: 'input' },
    },
    // 两个端口都进报告：审查说「有问题」正是最该写进报告的结论，
    // 而不是让流程停在那里
    {
      op: 'connect',
      edgeId: 'e_assess_report',
      source: { nodeId: 'assess', port: 'passed' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_assess_changes_report',
      source: { nodeId: 'assess', port: 'changes_requested' },
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
