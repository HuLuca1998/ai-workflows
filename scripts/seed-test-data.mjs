#!/usr/bin/env node
/**
 * 给本地测试环境铺一份基线数据。
 *
 * 为什么需要：很多界面元素只在「有数据」时才渲染（运行详情、模型详情、
 * 事件流卡片）。空库跑尺寸对照，一半选择器返回 -1，测的是空气。
 *
 * 这份数据是**留存**的 —— 不清库，反复跑只会补齐缺的那部分。
 * 每条记录名字里带 `[基线]`，与手工建的东西区分开。
 *
 *     node scripts/seed-test-data.mjs [--api http://127.0.0.1:5177]
 */

const api = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]
  : 'http://127.0.0.1:5177';

async function call(command, body = {}) {
  const response = await fetch(`${api}/ipc/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${command} 失败：${text}`);
  return text ? JSON.parse(text) : null;
}

const TAG = '[基线]';

/** 一条能跑通、且带审批的工作流：覆盖运行详情要显示的所有元素。 */
function graph() {
  return {
    nodes: [
      {
        id: 'entry',
        type: 'entry',
        title: '入口',
        position: { x: 40, y: 40 },
        config: {
          trigger: 'manual',
          inputSchema: {
            type: 'object',
            required: ['issue'],
            properties: {
              issue: { type: 'string', title: 'Issue 编号' },
              repo: { type: 'string', title: '仓库', default: 'atlas-api' },
            },
          },
        },
      },
      {
        id: 'read',
        type: 'script.shell',
        title: '读取输入',
        position: { x: 290, y: 40 },
        config: { interpreter: 'bash', script: 'echo issue=${input.issue}', timeoutMs: 10000 },
      },
      {
        id: 'approve',
        type: 'approval',
        title: '审批 · 确认继续',
        position: { x: 540, y: 40 },
        config: { title: '确认继续', interaction: 'confirm', bodyMarkdown: '外部写操作前的确认。' },
      },
      {
        id: 'finish',
        type: 'script.shell',
        title: '收尾',
        position: { x: 790, y: 40 },
        config: { interpreter: 'bash', script: 'echo done', timeoutMs: 10000 },
      },
      {
        id: 'end',
        type: 'end',
        title: '结束',
        position: { x: 1040, y: 40 },
        config: { outcome: 'success' },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'entry', port: 'success' },
        target: { nodeId: 'read', port: 'input' },
      },
      {
        id: 'e2',
        source: { nodeId: 'read', port: 'success' },
        target: { nodeId: 'approve', port: 'input' },
      },
      {
        id: 'e3',
        source: { nodeId: 'approve', port: 'approved' },
        target: { nodeId: 'finish', port: 'input' },
      },
      {
        id: 'e4',
        source: { nodeId: 'finish', port: 'success' },
        target: { nodeId: 'end', port: 'input' },
      },
    ],
    groups: [],
  };
}

/** 一条必定失败的工作流：失败横幅与 stderr 产物要有数据才看得见。 */
function failingGraph() {
  return {
    nodes: [
      {
        id: 'entry',
        type: 'entry',
        title: '入口',
        position: { x: 40, y: 40 },
        config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
      },
      {
        id: 'boom',
        type: 'script.shell',
        title: '会失败的脚本',
        position: { x: 290, y: 40 },
        config: { interpreter: 'bash', script: 'echo 诊断信息 >&2; exit 7', timeoutMs: 10000 },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'entry', port: 'success' },
        target: { nodeId: 'boom', port: 'input' },
      },
    ],
    groups: [],
  };
}

async function ensureWorkflow(name, graphJson) {
  const existing = await call('workflow_list');
  const found = existing.find((w) => w.name === name);
  if (found) return { id: found.id, rev: null, existed: true };

  const id = await call('workflow_create', { name });
  const rev = await call('workflow_save_draft', {
    id,
    baseRev: 0,
    graphJson: JSON.stringify(graphJson),
  });
  return { id, rev, existed: false };
}

async function waitFor(runId, wanted, limitMs = 30_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const run = await call('run_get', { runId });
    if (run && wanted.includes(run.status)) return run.status;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function main() {
  console.log(`基线数据 → ${api}`);

  // ── 模型 ────────────────────────────────────────────────────────────────
  const models = await call('model_list', { enabledOnly: false });
  const wanted = [
    {
      name: `${TAG} Opus 5 · high`,
      runtime: 'acp.claude',
      modelId: 'claude-opus-5',
      effort: 'high',
    },
    {
      name: `${TAG} Sonnet 5 · medium`,
      runtime: 'acp.claude',
      modelId: 'claude-sonnet-5',
      effort: 'medium',
    },
    { name: `${TAG} Codex · high`, runtime: 'acp.codex', modelId: 'gpt-5-codex', effort: 'high' },
  ];
  for (const model of wanted) {
    if (models.some((m) => m.name === model.name)) continue;
    await call('model_create', {
      ...model,
      contextWindow: 200_000,
      capabilities: ['结构化输出', '工具调用'],
      credentialRef: 'keychain://baseline',
      enabled: true,
    });
    console.log(`  + 模型 ${model.name}`);
  }

  // ── Agent 角色 ──────────────────────────────────────────────────────────
  const agents = await call('agent_list');
  if (!agents.some((a) => a.name === `${TAG} 分析 Agent`)) {
    await call('agent_create', {
      name: `${TAG} 分析 Agent`,
      role: '分析师',
      goal: '定位根因，给出可验证的方案',
      persona: '先读代码再下结论；不确定时说不确定。',
      runtime: 'acp.claude',
      modelRef: 'model_baseline',
      tools: ['read', 'grep'],
      capabilities: { fileRead: true, fileWrite: false, network: 'none' },
      outputContract: '结构化 JSON',
    });
    console.log(`  + Agent ${TAG} 分析 Agent`);
  }

  // ── 提示词 ──────────────────────────────────────────────────────────────
  const prompts = await call('prompt_list');
  const promptSeeds = [
    {
      group: '系统内建 · 节点',
      name: `${TAG} 分析 · 根因`,
      sections: [
        { title: 'Role', body: '你是一名代码分析师。' },
        { title: 'Task', body: '定位 ${input.issue} 的根因，给出 2–3 个可选方案。' },
        { title: 'Constraints', body: '信息不足时列出还缺什么，不要猜。' },
      ],
      vars: [{ name: '${input.issue}', source: '启动表单', onMissing: 'empty_and_log' }],
    },
    {
      group: '系统内建 · 记忆',
      name: `${TAG} 记忆提议`,
      sections: [{ title: 'Task', body: '从这次运行里挑出值得长期记住的事实。' }],
      vars: [],
    },
  ];
  for (const seed of promptSeeds) {
    if (prompts.some((p) => p.name === seed.name)) continue;
    await call('prompt_create', {
      group: seed.group,
      name: seed.name,
      sectionsJson: JSON.stringify(seed.sections),
      varsJson: JSON.stringify(seed.vars),
    });
    console.log(`  + 提示词 ${seed.name}`);
  }

  // ── 成功的运行（含审批走完）────────────────────────────────────────────
  const ok = await ensureWorkflow(`${TAG} 带审批的流程`, graph());
  if (!ok.existed) {
    const runId = await call('run_start', {
      workflowId: ok.id,
      draftRev: ok.rev,
      inputsJson: JSON.stringify({ issue: '561', repo: 'atlas-api' }),
    });
    console.log(`  + 运行 ${runId}（等审批）`);
    await waitFor(runId, ['waiting_approval']);
    await call('approval_decide', { runId, nodeId: 'approve', decision: 'approved' });
    const status = await waitFor(runId, ['succeeded', 'failed']);
    console.log(`    → ${status}`);
  }

  // ── 挂在审批上的运行（审批面板要有数据才显示）──────────────────────────
  const pending = await ensureWorkflow(`${TAG} 停在审批的流程`, graph());
  if (!pending.existed) {
    const runId = await call('run_start', {
      workflowId: pending.id,
      draftRev: pending.rev,
      inputsJson: JSON.stringify({ issue: '999', repo: 'atlas-api' }),
    });
    const status = await waitFor(runId, ['waiting_approval']);
    console.log(`  + 运行 ${runId} → ${status}（留在审批点，不批准）`);
  }

  // ── 失败的运行（失败横幅 + stderr 产物）────────────────────────────────
  const bad = await ensureWorkflow(`${TAG} 会失败的流程`, failingGraph());
  if (!bad.existed) {
    const runId = await call('run_start', {
      workflowId: bad.id,
      draftRev: bad.rev,
      inputsJson: '{}',
    });
    const status = await waitFor(runId, ['failed', 'succeeded']);
    console.log(`  + 运行 ${runId} → ${status}`);
  }

  const workflows = await call('workflow_list');
  const runs = await call('run_list', { statuses: [] });
  console.log(`\n现有：${workflows.length} 个工作流、${runs.length} 次运行`);
}

main().catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(1);
});
