import { REPORT_INSTRUCTION, AGENT, type WorkflowTemplate } from './shared.js';

/**
 * 「发布编排」—— 唯一一条**嵌套调用**的内置流程。
 *
 * 串起两条已有的标准流程：先跑依赖升级巡检，再跑发布前检查单，
 * 最后把两份结论合成一句「能不能发」。
 *
 * ## 为什么内置模板引用得到别的内置工作流
 *
 * 出厂工作流的 id 是**写死**的（`workflow:<模板 id>`，见
 * `crates/store/src/builtin_workflows.rs`）—— 重装或重置之后指的
 * 还是同一条。没有这一点，子工作流节点只能填一个用户工作区里
 * 现查的 id，内置模板就无从引用。
 *
 * ## 用户删掉了被调用的那条会怎样
 *
 * 子工作流节点会明确失败并说清「工作流 X 既没有发布版本也没有草稿」，
 * 走 `failed` 端口到失败终点 —— 不是静默跳过。
 */
export const RELEASE_PIPELINE: WorkflowTemplate = {
  id: 'release-pipeline',
  name: '发布编排（嵌套调用）',
  summary: '依赖巡检 → 发布前检查 → 合并结论。两步都是独立子运行',
  operations: [
    {
      op: 'addNode',
      nodeId: 'entry',
      type: 'entry',
      title: '入口 · 手动',
      position: { x: 40, y: 34 },
      config: {
        // 手动：发布是有人做的决定
        trigger: 'manual',
        workdirSource: 'prompt',
        inputSchema: {
          type: 'object',
          required: ['repoPath'],
          properties: {
            repoPath: { type: 'string', title: '本地仓库路径', default: '.' },
          },
        },
        injectedFields: [],
      },
    },
    {
      op: 'addNode',
      nodeId: 'deps',
      type: 'subworkflow',
      title: '子流程 · 依赖升级巡检',
      position: { x: 290, y: 34 },
      config: {
        // 出厂 id，写死的（builtin_workflows.rs）
        workflowId: 'workflow:dep-upgrade-audit',
        versionRef: 'latest',
        mode: 'sync',
        inputMapping: { repoPath: '${input.repoPath}' },
        outputMapping: {},
        concurrencyLimit: 1,
        // 依赖有问题不该挡住发布检查 —— 那是两件事，
        // 让它继续跑完，两份结论一起交给人判断
        onFailure: 'continue',
        approvalInheritance: 'inherit',
      },
    },
    {
      op: 'addNode',
      nodeId: 'checklist',
      type: 'subworkflow',
      title: '子流程 · 发布前检查单',
      position: { x: 540, y: 34 },
      config: {
        workflowId: 'workflow:release-checklist',
        versionRef: 'latest',
        mode: 'sync',
        inputMapping: { repoPath: '${input.repoPath}' },
        outputMapping: {},
        concurrencyLimit: 1,
        // 检查单跑不起来就没得判了，这一步失败要拖停整条
        onFailure: 'fail_parent',
        approvalInheritance: 'inherit',
      },
    },
    {
      op: 'addNode',
      nodeId: 'merge',
      type: 'ai.analyze',
      title: '合并两份结论',
      position: { x: 790, y: 34 },
      config: {
        agentProfileId: AGENT.analyst,
        // 两个子运行的产出。子工作流节点把 {runId, status} 放进作用域，
        // 详细结论在各自子运行的产物里 —— 这里给的是「跑没跑成」，
        // agent 拿着 runId 可以经系统 MCP 去读那条运行的报告
        target: '依赖巡检：${deps.failed}\n发布前检查：${checklist.success}',
        instruction: [
          '这是两条子流程的运行结果，每条带着自己的 runId 与状态。',
          '',
          '两份详细结论在各自子运行的 `report.json` 产物里 ——',
          '用系统 MCP 的 `run_artifacts` / `run_artifact_content` 按 runId 读。',
          '',
          '合成一句话回答：**这次能不能发**。',
          '',
          '· 发布前检查说「不能发」→ 就是不能发，依赖那份再好也不改变结论',
          '· 依赖巡检失败（status 不是 succeeded）→ 说清「这一项没查成」，',
          '  **不要当成「依赖没问题」** —— 那是两回事',
          '· 读不到某份报告就直说读不到，别猜里面写了什么',
        ].join('\n'),
      },
    },
    {
      op: 'addNode',
      nodeId: 'write_report',
      type: 'ai.execute',
      title: '写出 report.json',
      position: { x: 1040, y: 34 },
      config: {
        agentProfileId: AGENT.builder,
        instruction: [
          '上一步的结论：',
          '${merge.success}',
          '',
          REPORT_INSTRUCTION,
          '',
          '第一屏就回答「能不能发」：outcome 用 success / warning / failed，',
          'summary 第一句就是结论。用 links 块给出两条子运行的链接。',
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
      position: { x: 1290, y: 34 },
      config: { outcome: 'success', artifacts: ['report.json'] },
    },
    {
      op: 'addNode',
      nodeId: 'stopped',
      type: 'end',
      title: '结束 · 子流程跑不起来',
      position: { x: 540, y: 184 },
      config: { outcome: 'failure', artifacts: [] },
    },

    {
      op: 'setJoin',
      nodeId: 'stopped',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    // checklist 的两条入边来自 deps 的互斥端口（成功 / 失败都往下走）
    {
      op: 'setJoin',
      nodeId: 'checklist',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    {
      op: 'setJoin',
      nodeId: 'merge',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },
    {
      op: 'setJoin',
      nodeId: 'done',
      join: { strategy: 'any', merge: 'namespaced', onPartialFailure: 'fail' },
    },

    {
      op: 'connect',
      edgeId: 'e_entry_deps',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'deps', port: 'input' },
    },
    // 依赖巡检成功或失败都往下走（onFailure: continue）——
    // 「这一项没查成」是结论的一部分，不是终止理由
    {
      op: 'connect',
      edgeId: 'e_deps_checklist',
      source: { nodeId: 'deps', port: 'success' },
      target: { nodeId: 'checklist', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_deps_failed_checklist',
      source: { nodeId: 'deps', port: 'failed' },
      target: { nodeId: 'checklist', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_checklist_merge',
      source: { nodeId: 'checklist', port: 'success' },
      target: { nodeId: 'merge', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_checklist_stopped',
      source: { nodeId: 'checklist', port: 'failed' },
      target: { nodeId: 'stopped', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_merge_report',
      source: { nodeId: 'merge', port: 'success' },
      target: { nodeId: 'write_report', port: 'input' },
    },
    {
      op: 'connect',
      edgeId: 'e_merge_stopped',
      source: { nodeId: 'merge', port: 'insufficient_context' },
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
