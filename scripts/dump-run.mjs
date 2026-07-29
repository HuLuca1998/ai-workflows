#!/usr/bin/env node
/**
 * 把一次运行的**全部**数据导成一份 Markdown 报告。
 *
 * 界面上的「执行记录」是三栏交互视图，适合边跑边看；这个脚本适合
 * 「事后把整件事完整读一遍」——评审、复盘、贴进工单。
 *
 * 一条原则：**只打印数据库里真有的东西**。查不到就写「（没有）」，
 * 不补一个看起来合理的默认值 —— 那会让读的人以为验证过了。
 *
 * 用法：
 *   node scripts/dump-run.mjs <aiwf.sqlite> [runId]
 *
 * 不给 runId 就取最近一次。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dbPath, wantRun] = process.argv.slice(2);
if (!dbPath) {
  console.error('用法：node scripts/dump-run.mjs <aiwf.sqlite> [runId]');
  process.exit(1);
}

/**
 * 查一次库。
 *
 * 走 sqlite3 命令行而不是 node 的驱动：这个脚本要能在没跑过
 * `pnpm install` 的机器上直接用（比如从诊断包里拿到一个 .sqlite）。
 */
function query(sql) {
  const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return raw ? JSON.parse(raw) : [];
}

const one = (sql) => query(sql)[0] ?? null;

/** 产物目录是 `<run>/<节点>/<文件>` 两层。 */
function 列出文件(root) {
  const out = [];
  for (const node of readdirSync(root)) {
    const dir = join(root, node);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      out.push({ node, name, bytes: statSync(join(dir, name)).size });
    }
  }
  return out;
}
const esc = (text) =>
  String(text ?? '')
    .replace(/\|/gu, '\\|')
    .replace(/\n/gu, ' ');

// ── 运行 ────────────────────────────────────────────────────────────────────

const run = wantRun
  ? one(`SELECT * FROM run WHERE id = '${wantRun}'`)
  : one('SELECT * FROM run ORDER BY started_at DESC, rowid DESC LIMIT 1');

if (!run) {
  console.error('这个库里没有运行记录。');
  process.exit(1);
}

const workflow = one(`SELECT * FROM workflow WHERE id = '${run.workflow_id}'`);
const version = run.version_id
  ? one(`SELECT * FROM workflow_version WHERE id = '${run.version_id}'`)
  : null;

const graphJson = version
  ? version.graph_json
  : (one(
      `SELECT graph_json FROM workflow_revision
       WHERE workflow_id = '${run.workflow_id}' AND rev = ${run.draft_rev ?? 0}`,
    )?.graph_json ?? '{}');
const graph = JSON.parse(graphJson);

const events = query(`SELECT * FROM run_event WHERE run_id = '${run.id}' ORDER BY seq`);

console.log(`# 运行报告 · ${workflow?.name ?? '(工作流已删除)'}\n`);

console.log('## 这一次跑的是什么\n');
console.log('| | |');
console.log('| --- | --- |');
console.log(`| 工作流 | ${esc(workflow?.name)} \`${run.workflow_id}\` |`);
console.log(
  `| 版本 | ${version ? `v${version.version} \`${version.id}\`（config_hash \`${version.config_hash?.slice(0, 12)}\`）` : `草稿 rev ${run.draft_rev}`} |`,
);
console.log(`| 运行 | \`${run.id}\` |`);
console.log(`| 状态 | **${run.status}** |`);
console.log(`| 开始 / 结束 | ${run.started_at ?? '—'} → ${run.ended_at ?? '—'} |`);
console.log(`| 入参 | \`${esc(run.inputs_json)}\` |`);
console.log(`| 工作目录 | \`${run.workdir ?? '—'}\` |`);
console.log(`| 节点 / 连线 | ${graph.nodes?.length ?? 0} / ${graph.edges?.length ?? 0} |`);
console.log(`| 事件 | ${events.length} 条 |\n`);

// ── 事件流完整性 ────────────────────────────────────────────────────────────
//
// 「事件流可完整回放」是 M2 的出口标准。缺口意味着有事发生过而没被记下，
// 那时下面所有的统计都不可信 —— 所以先验它，再谈别的。

const gaps = [];
events.forEach((event, index) => {
  if (event.seq !== index + 1) gaps.push(`第 ${index + 1} 条的 seq 是 ${event.seq}`);
});
const started = events.filter((e) => e.type === 'node.started').map((e) => e.node_id);
const ended = events
  .filter((e) =>
    ['node.succeeded', 'node.failed', 'node.skipped', 'node.cancelled'].includes(e.type),
  )
  .map((e) => e.node_id);
const dangling = started.filter((id) => !ended.includes(id));

console.log('## 事件流完整性\n');
console.log(`- seq 连续：${gaps.length === 0 ? '✅ 无缺口' : `❌ ${gaps.join('、')}`}`);
console.log(
  `- 每个 node.started 都有结束事件：${dangling.length === 0 ? '✅' : `❌ 悬空：${dangling.join('、')}`}`,
);
console.log(
  `- 生命周期：${events
    .filter((e) => e.type.startsWith('run.'))
    .map((e) => e.type)
    .join(' → ')}\n`,
);

// ── 节点 ────────────────────────────────────────────────────────────────────

console.log('## 每个节点发生了什么\n');
console.log('| 节点 | 类型 | 结果 | 说明 |');
console.log('| --- | --- | --- | --- |');
for (const node of graph.nodes ?? []) {
  const mine = events.filter((e) => e.node_id === node.id);
  const last = [...mine].reverse().find((e) => e.type.startsWith('node.'));
  const 结果 = last
    ? ({
        'node.succeeded': '✅ 成功',
        'node.failed': '❌ 失败',
        'node.skipped': '⤼ 跳过',
        'node.cancelled': '⊘ 取消',
        'node.started': '⏳ 开始了但没结束',
        'node.waiting': '⏸ 等待',
      }[last.type] ?? last.type)
    : '— 没跑到';
  console.log(
    `| ${esc(node.title)} \`${node.id}\` | \`${node.type}\` | ${结果} | ${esc(last?.summary ?? '')} |`,
  );
}
console.log();

// ── 可解释性 ────────────────────────────────────────────────────────────────
//
// 「用了哪个模型 / 提示词 / 注入了哪些记忆 / 谁批准了什么」——
// 执行记录那一屏承诺的四件事，答案全在 system.* 事件里。

console.log('## 为什么这么做（可解释性证据）\n');
const 可解释 = events.filter((e) => e.type.startsWith('system.') || e.type.startsWith('approval.'));
if (可解释.length === 0) {
  console.log('（没有）—— 这次运行没有 AI 节点，也没有审批。\n');
} else {
  console.log('| seq | 类型 | 节点 | 内容 |');
  console.log('| --- | --- | --- | --- |');
  for (const event of 可解释) {
    console.log(
      `| ${event.seq} | \`${event.type}\` | ${event.node_id ?? '—'} | ${esc(event.summary)} |`,
    );
  }
  console.log();
}

// ── 逐个节点 ────────────────────────────────────────────────────────────────
//
// 「每个节点的信息全部分开，不同节点展示方式不同」——报告与界面同一个原则。
// 一张按时间排的大表看不出「这一步到底干了什么」：一次 AI 分析有几十条
// 工具调用事件，结论那一条淹在中间。

/** 事件里挑一条。 */
const pick = (list, type) => list.find((e) => e.type === type);

console.log('## 逐个节点\n');
for (const node of graph.nodes ?? []) {
  const mine = events.filter((e) => e.node_id === node.id);
  if (mine.length === 0) continue;

  const last = [...mine].reverse().find((e) => e.type.startsWith('node.'));
  const 结果 =
    {
      'node.succeeded': '✅ 成功',
      'node.failed': '❌ 失败',
      'node.skipped': '⤼ 跳过',
      'node.cancelled': '⊘ 取消',
    }[last?.type ?? ''] ?? '⏳ 未结束';

  console.log(`### ${node.title} · \`${node.id}\`（${node.type}）${结果}\n`);

  const 失败 = pick(mine, 'node.failed');
  if (失败) console.log(`> **失败原因**：${esc(失败.summary)}\n`);

  if (node.type.startsWith('ai.')) {
    const 用了谁 = pick(mine, 'system.model_resolved');
    if (用了谁) console.log(`**这一步用了谁**：${esc(用了谁.summary)}\n`);

    // 它到底动了哪些文件。放在对话之前 —— 读报告的人先要知道
    // 「这一步有没有真的做事」，再去看它是怎么说的。
    // 曾经有一次 AI 节点报成功而工作区一个字节没变，一路过了审查、
    // 分级与人工审批，直到 git push 才暴露
    const 改动 = pick(mine, 'node.output_emitted');
    if (改动) console.log(`**改了什么**：${esc(改动.summary)}\n`);

    const 对话 = mine.filter(
      (e) => e.type.startsWith('conversation.') || e.type.startsWith('reasoning.'),
    );
    for (const item of 对话) {
      const 谁 =
        {
          'conversation.user_message': '提问',
          'reasoning.summary': '推理',
          'conversation.agent_message': '回答',
        }[item.type] ?? item.type;
      console.log(
        `**${谁}**（seq ${item.seq}${item.payload_ref ? ` · 全文 \`${item.payload_ref}\`` : ''}）\n`,
      );
      console.log('```');
      console.log(item.summary);
      console.log('```\n');
    }

    const 工具 = mine.filter((e) => e.type.startsWith('tool.'));
    if (工具.length > 0) {
      const 完成 = 工具.filter((e) => e.type === 'tool.call_finished').length;
      const 失败数 = 工具.filter((e) => e.type === 'tool.call_failed').length;
      console.log(`**工具活动**：${完成 + 失败数} 次调用（失败 ${失败数} 次）\n`);
      console.log('| seq | 状态 | 调了什么 |');
      console.log('| --- | --- | --- |');
      for (const item of 工具.filter((e) => e.type !== 'tool.call_started')) {
        console.log(
          `| ${item.seq} | ${item.type === 'tool.call_failed' ? '失败' : '完成'} | ${esc(item.summary)} |`,
        );
      }
      console.log();
    }
  } else if (node.type.startsWith('script.')) {
    for (const [标题, type] of [
      ['跑的是什么', 'script.started'],
      ['结果', 'script.exited'],
      ['标准输出', 'script.stdout'],
      ['标准错误', 'script.stderr'],
    ]) {
      const item = pick(mine, type);
      if (!item) continue;
      console.log(`**${标题}**${item.payload_ref ? `（全文 \`${item.payload_ref}\`）` : ''}\n`);
      console.log('```');
      console.log(item.summary);
      console.log('```\n');
    }
  } else if (node.type === 'git.worktree') {
    const 输出 = pick(mine, 'node.output_emitted');
    console.log(`**隔离工作区**：${esc(输出?.summary ?? '（没有留下分支信息）')}\n`);
  } else if (node.type === 'approval') {
    const 决定 = pick(mine, 'approval.decided');
    console.log(
      决定
        ? `**审批**：${esc(决定.summary)} · 由 ${决定.actor} 于 ${决定.ts}\n`
        : '**审批**：还在等人决定\n',
    );
  } else {
    console.log(`${esc(last?.summary ?? '')}\n`);
  }
}

// ── 产物 ────────────────────────────────────────────────────────────────────

// 产物的真源是**磁盘**，不是 `artifact` 表 —— `run.artifacts` 也是扫目录的。
// 第一版这里查了那张表，于是报告写着「产物（没有）」而磁盘上躺着 12 个文件。
// 表里空着是既有事实（没有代码往里写），报告不该跟着它一起说假话。
const 产物根 = run.workdir ? join(run.workdir, '.aiwf-artifacts', run.id) : null;
const artifacts = 产物根 && existsSync(产物根) ? 列出文件(产物根) : [];

console.log('## 产物\n');
if (artifacts.length === 0) {
  console.log('（没有）\n');
} else {
  console.log(`目录：\`${产物根}\`\n`);
  console.log('| 节点 | 文件 | 字节 |');
  console.log('| --- | --- | --- |');
  for (const item of artifacts) {
    console.log(`| ${esc(item.node)} | \`${esc(item.name)}\` | ${item.bytes} |`);
  }
  console.log();
}

// ── 完整事件流 ──────────────────────────────────────────────────────────────

console.log('## 完整事件流\n');
console.log('| seq | 类型 | 节点 | actor | 摘要 |');
console.log('| --- | --- | --- | --- | --- |');
for (const event of events) {
  console.log(
    `| ${event.seq} | \`${event.type}\` | ${event.node_id ?? '—'} | ${event.actor} | ${esc(event.summary)} |`,
  );
}
console.log();

// ── 工作区 ──────────────────────────────────────────────────────────────────

console.log('## 这个工作区里还有什么\n');
for (const [label, sql] of [
  ['工作流', 'SELECT id, name FROM workflow'],
  ['Agent 角色', 'SELECT id, name, runtime, model_ref FROM agent_profile ORDER BY id'],
  ['模型', 'SELECT id, name, runtime, enabled FROM model ORDER BY id'],
  ['提示词', 'SELECT id, "group", name FROM prompt ORDER BY id'],
  ['记忆', 'SELECT id, key, enabled FROM memory ORDER BY id'],
]) {
  const rows = query(sql);
  console.log(`### ${label}（${rows.length}）\n`);
  if (rows.length === 0) {
    console.log('（没有）\n');
    continue;
  }
  const keys = Object.keys(rows[0]);
  console.log(`| ${keys.join(' | ')} |`);
  console.log(`| ${keys.map(() => '---').join(' | ')} |`);
  for (const row of rows) console.log(`| ${keys.map((k) => esc(row[k])).join(' | ')} |`);
  console.log();
}
