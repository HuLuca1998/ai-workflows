import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRules } from './_specBudget.js';

/**
 * 只读的值不能长得和能改的输入框一模一样。
 *
 * 第三方巡检把这条列为**贯穿全站的系统性毛病**：`models__value` 这个类
 * 用在「上下文窗口」「Turn 上限」「角色」「接入方式」上，视觉上带边框
 * 带底色，与真输入框无异 —— 用户点进去没光标、打字没反应、界面也不解释。
 * 一条样式同时制造了三个独立问题（C-03 / C-06 / C-17）：
 *
 * - 模型详情写着「需要的话可在详情里手动补填」，而那个「字段」是个 `<p>`
 * - 「Turn 上限」显示成输入框，全界面无处可设
 * - 记忆编辑态的 Key 是 readOnly，与旁边 disabled 的「作用域」两种表现
 *
 * 判据：只读值的**背景**必须与输入框不同。边框可以留（它划定了值的范围），
 * 但「可以往里打字」这个暗示来自填充色。
 */

const CSS = await readFile(join(process.cwd(), 'apps/web/src/styles.css'), 'utf-8');

/** 取一条规则的某个属性值。 */
function prop(selector: string, name: string): string | undefined {
  const rule = parseRules(CSS).find((entry) => entry.selector === selector);
  if (!rule) return undefined;
  return new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`, 'u').exec(rule.body)?.[1]?.trim();
}

describe('只读值与输入框在视觉上分得开', () => {
  it('只读值有自己的背景，不套用输入框那一套', () => {
    const readonlyBg = prop('.models__value', 'background');
    const inputBg = prop('.models__field input,\n.models__field select', 'background');

    expect(readonlyBg, '.models__value 没有自己的背景 —— 它会与输入框长得一样').toBeTruthy();
    expect(readonlyBg).not.toBe(inputBg);
  });

  it('只读值的文字颜色比输入框弱一档 —— 那是「这是结果不是入口」的信号', () => {
    expect(prop('.models__value', 'color')).toBeTruthy();
  });

  it('readOnly 的输入框要与可编辑的分得开', () => {
    // 记忆页的 Key 在编辑态是 readOnly：点了出光标、能打字、
    // 打的字一个都进不去，而旁边同样不可改的「作用域」是 disabled（正常置灰）
    const rule = parseRules(CSS).find((entry) => entry.selector.includes('input[readonly]'));
    expect(rule, 'readOnly 的输入框没有专门的样式 —— 用户会对着它敲字而界面毫无反应').toBeTruthy();
  });

  it('这条守卫自己会红', () => {
    const 假的 = `.models__value { height: 34px; border: 1px solid var(--color-divider); }`;
    const rules = parseRules(假的);
    const bg = /background:/u.test(rules[0]?.body ?? '');
    expect(bg, '没有 background 时守卫该判它与输入框长得一样').toBe(false);
  });
});
