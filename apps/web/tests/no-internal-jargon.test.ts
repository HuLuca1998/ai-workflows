import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 界面上不出现内部里程碑代号。
 *
 * codex 第四轮：「对话空状态显示『对话视图要等 AI 节点接上 ACP（M3）』……
 * `M3` 更像内部项目阶段名，对普通用户没有帮助」。
 *
 * 用户不知道 M2/M3/M5 是什么，也不该知道 —— 那是我们排期的说法。
 * 该说的是「还不能用」和「在等什么」，用他听得懂的话。
 */

const 源: { path: string; text: string }[] = [];
const 扫 = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) 扫(path);
    else if (/\.tsx?$/.test(entry.name)) 源.push({ path, text: readFileSync(path, 'utf8') });
  }
};
扫(join(import.meta.dirname, '../src'));

/** 面向用户的文本里出现里程碑代号就算违规。注释里提它是可以的。 */
const 代号 = /（M[0-9]）|\(M[0-9]\)|M[0-9] · /u;

describe('界面文案不露内部代号', () => {
  it('没有一处用户可见文本写着 M0–M9', () => {
    const 违规: string[] = [];
    for (const { path, text } of 源) {
      for (const [index, line] of text.split('\n').entries()) {
        const 去注释 = line.replace(/^\s*(\/\/|\*|\/\*).*/u, '');
        if (代号.test(去注释)) 违规.push(`${path}:${index + 1} ${去注释.trim()}`);
      }
    }

    expect(违规, `这些文案对用户露出了内部里程碑代号：\n${违规.join('\n')}`).toEqual([]);
  });
});
