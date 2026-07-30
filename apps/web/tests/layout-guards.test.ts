import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRules } from './_specBudget.js';

/**
 * `display: contents` 会把元素从盒模型里抹掉，它的子元素直接成为
 * **祖父**的布局子项。用在一个 column flex 容器的行上，就等于把
 * 「4 个字段 × 3 个元素」摊成 12 个竖排的行 ——
 * 而同一段代码的注释说的是「每行一个下拉」。
 *
 * 这类问题在 jsdom 里测不出来（它不做布局），所以守在 CSS 源码上。
 */

const CSS = await readFile(join(process.cwd(), 'apps/web/src/styles.css'), 'utf-8');

describe('权限块的行布局', () => {
  it('每个字段是一行，不是被 display:contents 摊开的三行', () => {
    const rule = parseRules(CSS).find((entry) => entry.selector.includes('.agents__kv-row'));
    expect(rule, '.agents__kv-row 不见了 —— 权限块的行结构变了').toBeTruthy();
    expect(
      rule!.body,
      'display:contents 会把 label / 说明 / 下拉直接摊给 .agents__caps，' +
        '于是 4 个字段变成 12 个竖排的行',
    ).not.toMatch(/display:\s*contents/u);
  });

  it('行内是横排的，label 与下拉在同一行', () => {
    const rule = parseRules(CSS).find((entry) => entry.selector.includes('.agents__kv-row'));
    expect(rule!.body).toMatch(/display:\s*flex/u);
  });
});

describe('模型的启用状态色', () => {
  const rules = parseRules(CSS).filter((entry) => entry.selector.includes('models__item-state'));

  it('「已启用」不能落在失败色那条规则里', () => {
    const wrong = rules.find(
      (entry) =>
        entry.selector.includes("[data-enabled='true']") &&
        /--color-status-failed/u.test(entry.body),
    );
    expect(
      wrong?.selector,
      '列表里「已启用」的芯片是红的 —— 选择器串到失败色那条规则上了',
    ).toBeUndefined();
  });

  it('列表项与详情徽章的停用色一致 —— 同一个状态不能两种表达', () => {
    const disabled = rules.find((entry) => entry.selector.includes("[data-enabled='false']"));
    expect(disabled, '列表项的「已停用」没有任何状态色').toBeTruthy();
    expect(disabled!.body).toMatch(/--color-status-failed/u);
  });
});
