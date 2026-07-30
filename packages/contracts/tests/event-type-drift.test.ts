import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { RUN_EVENT_TYPES } from '../src/events.js';

/**
 * 引擎发射的事件类型，必须是契约里声明过的。
 *
 * 这是 CLAUDE.md 三条接缝守卫里的**第三条**（前两条是节点类型与配置字段）。
 * 在补它之前，引擎发一个契约里不存在的类型没有任何一处会拦：
 * 存储层不校验 `kind`，而既有的 `contract_sync_test` 只检查
 * 「契约里的类型都是 `分类.动作` 形式」—— 方向是反的，
 * 它守的是契约自身，不是引擎有没有守着契约。
 *
 * 这个洞是真踩到的：给「回答被截断」加事件时顺手写了个
 * `system.warning`，编译过、测试绿、事件照样写进库 ——
 * 而界面按契约投影时认不出它。
 */

const 仓库根 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 会发事件的引擎源码。 */
function 引擎源码(): string {
  const 目录 = [join(仓库根, 'crates/engine/src'), join(仓库根, 'crates/core-api/src')];
  const 文件: string[] = [];
  for (const dir of 目录) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isFile() && name.name.endsWith('.rs')) 文件.push(join(dir, name.name));
    }
  }
  return 文件.map((path) => readFileSync(path, 'utf8')).join('\n');
}

/**
 * 从 Rust 源码里找出所有被当成事件类型用的字符串字面量。
 *
 * 两种写法：
 * - `kind: "xxx"` —— `NodeEvent` 结构体字面量
 * - `emit(store, run_id, "分类.动作", …)` —— runner 的那几个 helper，
 *   事件类型固定是第三个参数
 *
 * **按调用形状认，不按「长得像事件类型」认**。一开始图省事写成
 * 「带点的短字符串 + 前缀在九类里」，结果 `script.shell`（节点类型）、
 * `reasoning.md`（产物文件名）全被当成事件 —— 那种守卫每次加个文件名
 * 都要来改一次，很快就没人信了。
 */
export function 发射的事件类型(源码: string): string[] {
  const 命中 = new Set<string>();

  for (const m of 源码.matchAll(/kind:\s*"([a-z_]+\.[a-z_]+)"/gu)) {
    if (m[1]) 命中.add(m[1]);
  }
  // emit / emit_node / emit_full：跳过前两个参数（store、run_id），取第三个
  for (const m of 源码.matchAll(
    /\bemit(?:_node|_full)?\(\s*(?:[^,()]+,\s*){2}"([a-z_]+\.[a-z_]+)"/gu,
  )) {
    if (m[1]) 命中.add(m[1]);
  }
  return [...命中].sort();
}

describe('事件类型的接缝', () => {
  it('引擎发射的每一种，契约里都声明过', () => {
    const 声明过 = new Set<string>(RUN_EVENT_TYPES);
    const 没声明 = 发射的事件类型(引擎源码()).filter((kind) => !声明过.has(kind));

    expect(
      没声明,
      `引擎在发这些事件，而契约里没有它们 —— 存储层不校验 kind，\n` +
        `所以它们会照样写进库，而界面按契约投影时认不出：\n${没声明.join('\n')}`,
    ).toEqual([]);
  });

  it('守卫认得出契约里没有的类型', () => {
    // 门禁证明不了自己会红就不是门禁。两种写法各来一个
    expect(发射的事件类型('NodeEvent { kind: "system.no_such_thing", node_id: x }')).toContain(
      'system.no_such_thing',
    );
    expect(
      发射的事件类型('self.emit(store, run_id, "run.no_such_thing", None, "engine", "x")'),
    ).toContain('run.no_such_thing');
  });

  it('不把节点类型与文件名误认成事件', () => {
    // 一开始按「带点 + 前缀在九类里」认，结果 script.shell（节点类型）、
    // reasoning.md（产物文件名）全中招 —— 那种守卫每加个文件名就要改一次
    const 源码 = `
      let a = "script.shell"; let b = "reasoning.md"; let c = "1.0";
      let d = self.save_output(&node.id, "agent.md", &text);
    `;
    expect(发射的事件类型(源码)).toEqual([]);
  });
});
