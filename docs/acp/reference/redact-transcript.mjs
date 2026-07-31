#!/usr/bin/env node
/**
 * transcript 脱敏器 —— 跑完探针**必须**过一遍再提交。
 *
 * 起因是一次真实事故：`session/list` 一调下去，codex 把**本机全部会话**
 * 都回了过来（实测 25 条，全部属于别的项目），`title` 字段是那些会话的
 * 完整 prompt 正文。那份记录当时已经落进了要提交的 jsonl。
 *
 * 同理 `available_commands_update` 会带上用户本机装的全部 skill 及其描述。
 *
 * 两样都是**用户的东西，不是协议的东西**。协议结构要留下（那是文档价值），
 * 内容要抹掉。
 *
 * 用法：node docs/acp/reference/redact-transcript.mjs [文件…]
 * 不给文件就处理 transcripts/ 下全部 jsonl。幂等，可以反复跑。
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'transcripts');

/** 本机会话清单：只留形状。 */
function redactSessions(holder) {
  if (!Array.isArray(holder?.sessions)) return 0;
  const list = holder.sessions;
  if (list[0]?.$脱敏) return 0; // 已经处理过
  const n = list.length;
  holder.sessions = [
    {
      $脱敏: 'session/list 返回本机全部会话（含其他项目），内容已移除',
      $原始条数: n,
      $每条的字段: Object.keys(list[0] ?? {}),
      $示例形状: {
        sessionId: '019f…（uuid v7）',
        cwd: '/绝对路径',
        title: '该会话第一条 prompt 的正文，可能很长',
        updatedAt: 'ISO 时间',
      },
    },
  ];
  if (holder.nextCursor) holder.nextCursor = '<脱敏>';
  return n;
}

/**
 * 斜杠命令：**整个折叠**，只留形状。
 *
 * 第一版按 `$` 前缀挑「用户装的 skill」——那是 codex 的命名习惯，
 * **claude 侧不带前缀**（内置命令与用户自己装的 skill
 * 混在同一张 83 条的表里，名字上分不开）。分不开就不要分：
 * 命令表是用户环境，协议价值只在「这个通知长什么样」，一条样例就够。
 */
function redactCommands(update) {
  const list = update?.availableCommands;
  if (!Array.isArray(list)) return 0;
  if (list[0]?.$脱敏) return 0; // 已经处理过
  const n = list.length;
  update.availableCommands = [
    {
      $脱敏: 'available_commands_update 会列出用户本机装的全部命令与 skill，内容已移除',
      $原始条数: n,
      $每条的字段: [...new Set(list.flatMap((c) => Object.keys(c ?? {})))],
      $示例形状: {
        name: 'plan',
        description: '这条命令做什么',
        input: { hint: '还没输入时显示的提示' },
        _meta: '（可选）runtime 私有字段，如 codex 的 commandAction',
      },
    },
  ];
  return n;
}

function walk(node, stats) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, stats);
    return;
  }
  if (!node || typeof node !== 'object') return;
  stats.sessions += redactSessions(node);
  stats.commands += redactCommands(node);
  for (const value of Object.values(node)) walk(value, stats);
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(DIR, f));

let total = { sessions: 0, commands: 0 };
for (const file of files) {
  const stats = { sessions: 0, commands: 0 };
  const out = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const entry = JSON.parse(line);
      walk(entry, stats);
      return JSON.stringify(entry);
    });
  writeFileSync(file, `${out.join('\n')}\n`);
  if (stats.sessions || stats.commands) {
    console.log(
      `${path.basename(file)}：会话清单 ${stats.sessions} 条、用户 skill ${stats.commands} 条已脱敏`,
    );
  }
  total.sessions += stats.sessions;
  total.commands += stats.commands;
}
console.log(`合计：会话 ${total.sessions} · skill ${total.commands}`);
