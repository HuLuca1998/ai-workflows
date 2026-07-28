#!/usr/bin/env node
/**
 * 清掉旧的运行记录，只留最近的几次。
 *
 * 为什么需要它：运行记录只增不减。一条 AI 工作流跑一次是几十条事件加
 * 一堆产物，跑上几百次之后「执行记录」那一屏要翻很久才找得到有用的那次，
 * 而磁盘上的 `runs/` 也一直在涨。
 *
 * **默认只看不删**：这个脚本删的是用户跑过的真实记录，误删没有撤销。
 * 要真删得显式加 `--yes`。
 *
 * 用法：
 *   node scripts/prune-runs.mjs <aiwf.sqlite> [--keep N] [--workflow ID] [--yes]
 *
 * 事件与产物记录跟着运行走（外键 ON DELETE CASCADE），不用单独删。
 * 磁盘上的运行目录**不动** —— 那里可能有用户还要的产出，
 * 而这个脚本只管数据库。要一起清的话它会把路径列出来。
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

if (!dbPath) {
  console.error(
    '用法：node scripts/prune-runs.mjs <aiwf.sqlite> [--keep N] [--workflow ID] [--yes]',
  );
  process.exit(1);
}

const keep = Number(flag('keep', '1'));
const workflow = flag('workflow', null);
const confirmed = args.includes('--yes');

if (!Number.isInteger(keep) || keep < 0) {
  console.error(`--keep 要是一个非负整数，收到的是 ${flag('keep', '')}`);
  process.exit(1);
}

const query = (sql) => {
  const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return raw ? JSON.parse(raw) : [];
};

const where = workflow ? `WHERE workflow_id = '${workflow}'` : '';
// 按 rowid 排而不是 started_at：还没开始跑的运行 started_at 是 NULL，
// 按它排会让那几条排到最前面、然后被当成「最近的」留下来
const runs = query(
  `SELECT id, workflow_id, status, started_at FROM run ${where} ORDER BY rowid DESC`,
);

if (runs.length === 0) {
  console.log('没有运行记录。');
  process.exit(0);
}

const 留下 = runs.slice(0, keep);
const 删掉 = runs.slice(keep);

console.log(`共 ${runs.length} 次运行${workflow ? `（工作流 ${workflow}）` : ''}\n`);
console.log(`留下 ${留下.length} 次：`);
for (const run of 留下) console.log(`  ${run.id}  ${run.status}  ${run.started_at ?? '未开始'}`);

if (删掉.length === 0) {
  console.log('\n没有要删的。');
  process.exit(0);
}

console.log(`\n要删 ${删掉.length} 次：`);
for (const run of 删掉) console.log(`  ${run.id}  ${run.status}  ${run.started_at ?? '未开始'}`);

const 事件数 = query(
  `SELECT COUNT(*) AS n FROM run_event WHERE run_id IN (${删掉.map((r) => `'${r.id}'`).join(',')})`,
)[0].n;
console.log(`\n连带删掉 ${事件数} 条事件与它们的产物记录（外键级联）。`);

const 目录 = query(
  `SELECT DISTINCT workdir FROM run WHERE workdir IS NOT NULL AND id IN (${删掉
    .map((r) => `'${r.id}'`)
    .join(',')})`,
).map((row) => row.workdir);
if (目录.length > 0) {
  console.log('\n磁盘上的运行目录**不会**动 —— 那里可能有你还要的产出：');
  for (const dir of 目录) console.log(`  ${dir}`);
}

if (!confirmed) {
  console.log('\n这是预览。真要删的话加 --yes。');
  process.exit(0);
}

execFileSync('sqlite3', [
  dbPath,
  `DELETE FROM run WHERE id IN (${删掉.map((r) => `'${r.id}'`).join(',')})`,
]);
console.log(`\n已删掉 ${删掉.length} 次运行。`);
