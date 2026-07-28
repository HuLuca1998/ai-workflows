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

/**
 * 面向用户的文本里出现里程碑代号就算违规。注释里提它是可以的。
 *
 * **不要用「M2 后面跟什么」来判**。第一版就是那么写的（只认
 * `（M2）` / `(M2)` / `M2 · ` 三种带括号或带间隔号的形式），
 * 结果「M2 阶段接入」「M3 随后」这类最自然的写法全部漏过 ——
 * 界面上三处代号照旧在，而守卫绿着，给人「这类问题不会再有」的错觉。
 * **比没有测试更糟：没有测试至少不会有人以为它被守住了。**
 *
 * 现在的判据是「M + 一位数字，且它是一个独立的词」：
 * 前后不能紧挨着字母数字（避免 `M2M`、`FM3` 这类误伤）。
 */
const 代号 = /(?<![A-Za-z0-9])M[0-9](?![A-Za-z0-9])/u;

describe('界面文案不露内部代号', () => {
  it('没有一处用户可见文本写着 M0–M9', () => {
    const 违规: string[] = [];
    for (const { path, text } of 源) {
      // 先整段去掉注释再扫。逐行扫会被 JSX 的换行绕过 ——
      // 「…在 M3\n 随节点配置一起做」这种拆成两行就检测不到
      const 去注释 = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

      for (const [index, line] of 去注释.split('\n').entries()) {
        if (代号.test(line)) 违规.push(`${path}:${index + 1} ${line.trim()}`);
      }
    }

    expect(违规, `这些文案对用户露出了内部里程碑代号：\n${违规.join('\n')}`).toEqual([]);
  });

  it('这条守卫认得出不带括号的写法 —— 第一版就漏在这儿', () => {
    // 守卫本身也要有测试：它绿着但守不住，比没有更糟
    for (const 写法 of ['M2 阶段接入', '在 M3 随后做', '（M2）', 'M5 · 可交付', '等 M4']) {
      expect(代号.test(写法), `漏过了「${写法}」`).toBe(true);
    }
  });

  it('不误伤正常的英文与型号', () => {
    for (const 正常 of ['M2M 通信', 'FM3 模式', 'HDMI2', 'ARM64', '第 M 项']) {
      expect(代号.test(正常), `误伤了「${正常}」`).toBe(false);
    }
  });
});

describe('生产代码的标识符用英文', () => {
  /**
   * CLAUDE.md：「注释与文档用中文，标识符用英文」。
   *
   * 第 5 轮审查 F3（第 21 条）指出生产代码里混进了中文标识符。
   * 测试文件不在此列 —— 那里的中文名是描述性的，读起来比
   * `const filtered2` 清楚得多。
   */
  it('src 下没有中文的变量名与函数名', () => {
    const 违规: string[] = [];
    for (const { path, text } of 源) {
      const 无注释 = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
      for (const m of 无注释.matchAll(/\b(?:const|let|var|function)\s+([一-龥][^\s(=:,)]*)/gu)) {
        违规.push(`${path}: ${m[1]}`);
      }
    }

    expect(违规, `这些标识符是中文的，改成英文：\n${违规.join('\n')}`).toEqual([]);
  });
});
