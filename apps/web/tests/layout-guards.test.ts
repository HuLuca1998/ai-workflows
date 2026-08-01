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

/**
 * 首次配置页是 column-flex 滚动容器，而 `.onboarding__block` 自带
 * `overflow: hidden`（裁圆角）—— 这会把 flex 项的自动最小高度归零，
 * 于是内容装不下时**子块被压扁裁切**而不是触发容器滚动：
 * 页面总高恰好塞满容器，滚动条永远不出现，内容看不全也滚不动。
 * 1440×900 实测：五个块合计约 300px 内容被藏掉，Python 行拦腰截断。
 */
describe('首次配置页的子块不能被压扁', () => {
  const 压扁陷阱 = (css: string): boolean => {
    const rules = parseRules(css);
    const container = rules.find((entry) => entry.selector === '.onboarding');
    const isFlexScroll =
      container !== undefined &&
      /display:\s*flex/u.test(container.body) &&
      /overflow(?:-y)?:\s*auto/u.test(container.body);
    if (!isFlexScroll) return false;
    const childRule = rules.find((entry) => /\.onboarding\s*>\s*\*/u.test(entry.selector));
    return childRule === undefined || !/flex-shrink:\s*0/u.test(childRule.body);
  };

  it('滚动容器的直接子项必须 flex-shrink: 0', () => {
    expect(
      压扁陷阱(CSS),
      '.onboarding 是 flex 列滚动容器，但没有 `.onboarding > * { flex-shrink: 0 }` ——' +
        '子块（overflow:hidden）会被压扁裁切，页面永远不出滚动条',
    ).toBe(false);
  });

  it('这条守卫自己会红', () => {
    const 假的 = `.onboarding { display: flex; flex-direction: column; overflow: auto; }
      .onboarding__block { overflow: hidden; }`;
    expect(压扁陷阱(假的)).toBe(true);
  });

  it('不是滚动容器时不误报', () => {
    const 对的 = `.onboarding { display: block; }`;
    expect(压扁陷阱(对的)).toBe(false);
  });
});

/**
 * 模态弹层必须按**视口**定位并限高。
 *
 * `.cfg__backdrop` 原来是 `position: absolute` —— 定位上下文是画布那层，
 * 而画布可以比视口大、可以有偏移，于是 900×600 下弹窗落在 x=258 宽 728
 * （右边界 986 > 视口 900）：「应用改动」只露 7px、关闭按钮整个飞出屏幕，
 * 而 body 禁了横向滚动 —— **改了配置存不下去**。
 *
 * 限高同理：`max-height: 660px` 是死数，640 高的视口下 footer 在屏幕外，
 * 用户打开弹窗就以为没有保存按钮。
 */
describe('模态弹层不能被视口裁掉', () => {
  const 视口定位 = (css: string, selector: string): boolean => {
    const rule = parseRules(css).find((entry) => entry.selector === selector);
    return rule !== undefined && /position:\s*fixed/u.test(rule.body);
  };

  /** 限高里出现视口单位或 min()，就说明它会跟着窗口缩。 */
  const 跟着视口限高 = (css: string, selector: string): boolean => {
    const rule = parseRules(css).find((entry) => entry.selector === selector);
    if (rule === undefined) return false;
    const maxHeight = /max-height:\s*([^;]+)/u.exec(rule.body)?.[1] ?? '';
    return /\d+(?:dv|s|l)?vh|min\(|calc\([^)]*vh/u.test(maxHeight);
  };

  it('配置弹窗的遮罩按视口定位', () => {
    expect(
      视口定位(CSS, '.cfg__backdrop'),
      'position:absolute 时定位上下文是画布 —— 900×600 下弹窗右边界超出视口，' +
        '「应用改动」只露 7px 且横向滚不动',
    ).toBe(true);
  });

  it('配置弹窗的高度跟着视口缩', () => {
    expect(
      跟着视口限高(CSS, '.cfg'),
      'max-height 是死像素值时，矮视口（1024×640）下整条 footer 在屏幕外',
    ).toBe(true);
  });

  it('这两条守卫自己会红', () => {
    const 假的 = `.cfg__backdrop { position: absolute; inset: 0; }
      .cfg { max-height: 660px; }`;
    expect(视口定位(假的, '.cfg__backdrop')).toBe(false);
    expect(跟着视口限高(假的, '.cfg')).toBe(false);
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

/**
 * neutral-700 在 bg 上只有 2.69:1，在 surface 上 2.49:1 ——
 * 低于 WCAG 对文字的 4.5:1，也低于对图形元素的 3:1。
 *
 * 规范 §7 本身没说清这一条（VISUAL-SPEC 的 A-1/A-2 记着这个缺陷），
 * 所以这里定规矩：它只能用在**看不清也没关系**的地方 ——
 * 禁用态（规范明确允许降对比）与纯装饰（分隔符、空态大图标）。
 * 承载信息的文字一律 neutral-500 以上。
 */
describe('最低一档中性色的用法', () => {
  /**
   * 允许用 neutral-700 的选择器。每一条都要能回答「看不清为什么没关系」。
   */
  const 白名单: { 匹配: RegExp; 理由: string }[] = [
    { 匹配: /:disabled|\[aria-disabled|\[disabled\]/u, 理由: '禁用态，规范 §5.4 明确允许降对比' },
    { 匹配: /\.title-bar__slash/u, 理由: '面包屑里的「/」，纯分隔符，不承载信息' },
    { 匹配: /\.empty i\b/u, 理由: '空态的 32px 大图标，旁边就是同样内容的文字' },
    { 匹配: /\.editor__status-dot/u, 理由: '状态圆点的「无状态」态，本来就是「这里没东西」' },
  ];

  it('只出现在禁用态与纯装饰上', () => {
    const 违规 = parseRules(CSS)
      // 前面不能是连字符 —— border-color 是描边不是文字，2.5:1 的边框可以接受
      .filter((entry) => /(?<![-\w])color:\s*var\(--color-neutral-700\)/u.test(entry.body))
      .filter((entry) => !白名单.some((allow) => allow.匹配.test(entry.selector)))
      .map((entry) => entry.selector);
    expect(
      违规,
      `这些地方用了对比度只有 2.5:1 的 neutral-700：${违规.join(' / ')}。` +
        '承载信息的文字要 neutral-500 以上；确实是装饰的话加进白名单并写明理由',
    ).toEqual([]);
  });

  it('不会把 border-color 报成文字色', () => {
    const 对的 = `.x:hover { border-color: var(--color-neutral-700); }`;
    expect(
      parseRules(对的).filter((entry) =>
        /(?<![-\w])color:\s*var\(--color-neutral-700\)/u.test(entry.body),
      ),
    ).toEqual([]);
  });

  it('这条守卫自己会红', () => {
    const 假的 = `.some__label { color: var(--color-neutral-700); }`;
    const 命中 = parseRules(假的)
      .filter((entry) => /(?<![-\w])color:\s*var\(--color-neutral-700\)/u.test(entry.body))
      .filter((entry) => !白名单.some((allow) => allow.匹配.test(entry.selector)));
    expect(命中).toHaveLength(1);
  });
});
