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

/**
 * 状态语义与颜色不能反着来。
 *
 * 上面那条 bug（已启用的芯片是红的）是两条选择器串在了一起 ——
 * 「查硬编码十六进制」的守卫看不出这种错，因为用的确实是令牌。
 * 这条守卫查的是**语义**：选择器说的是「成了」，颜色就不能是失败色。
 */
describe('状态色不能与状态语义反着来', () => {
  /*
   * 判据要看**属性名 + 值**，不能只看值。
   *
   * `data-danger='true'` 的 true 说的是「有危险」，配失败色是对的；
   * `data-enabled='true'` 的 true 说的是「开着」，配失败色就反了。
   * 第一版只匹配 `='true'`，于是把六处正确的规则报成了错。
   */
  const 说成了 =
    /\[(?:data-)?(?:enabled|ready|ok|valid|passed|active)=['"]?true['"]?\]|=['"]?(?:succeeded|success|ready|passed)['"]?\]/u;
  const 说崩了 =
    /\[(?:data-)?(?:issue|invalid|danger|missing|error|failed|denied|truncated)=['"]?true['"]?\]|\[(?:data-)?(?:enabled|ready|ok|valid)=['"]?false['"]?\]|=['"]?(?:failed|error|missing|denied)['"]?\]/u;
  const 说等着 = /=['"]?(?:waiting|pending|paused|attention)['"]?\]/u;

  const 用了 = (body: string, tone: string) =>
    new RegExp(`--color-status-${tone}\\b`, 'u').test(body);

  it.each([
    ['说「成了」却配失败色', 说成了, 'failed'],
    ['说「崩了」却配成功色', 说崩了, 'success'],
    ['说「等着」却配成功色', 说等着, 'success'],
  ])('%s', (_名字, 选择器规律, tone) => {
    const 冲突 = parseRules(CSS)
      .filter((entry) => 选择器规律.test(entry.selector) && 用了(entry.body, tone))
      .map((entry) => entry.selector);
    expect(冲突, `这些规则的状态语义与颜色对不上：${冲突.join(' / ')}`).toEqual([]);
  });

  it('这条守卫自己会红', () => {
    // 故意违反：说「开着」却给失败色 —— 正是上面那条真 bug 的形状
    const 假的 = `.x[data-enabled='true'] { color: var(--color-status-failed); }`;
    expect(
      parseRules(假的).filter((entry) => 说成了.test(entry.selector) && 用了(entry.body, 'failed')),
    ).toHaveLength(1);
  });

  it('不会把 data-danger=true 这类正确写法报成错', () => {
    const 对的 = `.x[data-danger='true'] { color: var(--color-status-failed); }`;
    expect(parseRules(对的).filter((entry) => 说成了.test(entry.selector))).toEqual([]);
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
