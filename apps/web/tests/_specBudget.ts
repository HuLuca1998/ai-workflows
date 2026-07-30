/**
 * 视觉与交互规范 §4.1 / §8 / §2.5 里可机械校验的约束，抽成纯函数。
 *
 * 抽出来的理由是纪律三的推论：每加一道门禁，要配一条故意违反它、
 * 断言它变红的元测试。门禁若只会对真实 CSS 断言，它自己会不会红就无从证明。
 * 这些函数吃 CSS 字符串、吐违规项，于是元测试可以喂一段假 CSS。
 */

export interface Violation {
  /** 出问题的选择器，解析不出来时是 '(unknown)' */
  selector: string;
  /** 1 起算的行号，便于直接跳过去 */
  line: number;
  /** 违反了什么，用于测试失败信息 */
  detail: string;
}

interface Rule {
  selector: string;
  body: string;
  line: number;
}

/** 剥注释但保留换行，行号才不会错位。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '));
}

function lineOf(css: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < css.length; i += 1) {
    if (css[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 拆出顶层规则块。@media / @keyframes 这类包裹块会连同内部规则一起再拆一层，
 * 所以嵌套在里面的声明也进得来。
 */
export function parseRules(rawCss: string): Rule[] {
  const css = stripComments(rawCss);
  const rules: Rule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1;
  const stack: { selector: string; start: number }[] = [];

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        selectorStart = css.lastIndexOf('}', i - 1) + 1;
        bodyStart = i + 1;
        stack.push({ selector: css.slice(selectorStart, i).trim(), start: bodyStart });
      } else {
        // 嵌套块（@media 内部）：单独记一条
        const innerSelStart =
          Math.max(css.lastIndexOf('{', i - 1), css.lastIndexOf('}', i - 1)) + 1;
        stack.push({ selector: css.slice(innerSelStart, i).trim(), start: i + 1 });
      }
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      const frame = stack.pop();
      if (frame) {
        const body = css.slice(frame.start, i);
        // 只收真正含声明的块（@media 外壳本身不含 `:` 直属声明）
        if (/[a-z-]+\s*:/u.test(body.replace(/\{[\s\S]*?\}/gu, ''))) {
          rules.push({
            selector: frame.selector,
            body: body.replace(/\{[\s\S]*?\}/gu, ''),
            line: lineOf(css, frame.start),
          });
        }
      }
      if (depth < 0) depth = 0;
      continue;
    }
    void selectorStart;
    void bodyStart;
  }
  return rules;
}

/** 取某条声明的值（同名多次取最后一次，与 CSS 层叠一致）。 */
function declValue(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'giu');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = (m[1] ?? '').trim();
  return last;
}

/** 按顶层逗号切分（忽略括号内的逗号）。 */
export function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * §4.1「只动 opacity / transform / stroke-dashoffset / 小元素的 box-shadow；
 * 禁止动画 width/height/top/left/filter」。
 *
 * 覆盖 transition 的属性位与 @keyframes 内部的声明两处。
 */
const FORBIDDEN_ANIMATED = ['width', 'height', 'top', 'left', 'right', 'bottom', 'filter'];

export function findAnimatedLayoutProps(rawCss: string): Violation[] {
  const css = stripComments(rawCss);
  const out: Violation[] = [];

  // 1) transition 的属性位
  for (const rule of parseRules(css)) {
    const value = declValue(rule.body, 'transition');
    if (!value) continue;
    for (const part of splitTopLevel(value)) {
      const prop = part.trim().split(/\s+/u)[0] ?? '';
      if (FORBIDDEN_ANIMATED.includes(prop)) {
        out.push({
          selector: rule.selector,
          line: rule.line,
          detail: `transition 动了布局属性 \`${prop}\`（规范 §4.1 只允许 opacity/transform/stroke-dashoffset/box-shadow）`,
        });
      }
    }
  }

  // 2) @keyframes 内部
  const kf = /@keyframes\s+([\w-]+)\s*\{/gu;
  let m: RegExpExecArray | null;
  while ((m = kf.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      i += 1;
    }
    const block = css.slice(start, i - 1);
    for (const prop of FORBIDDEN_ANIMATED) {
      const hit = new RegExp(`(?:^|[;{\\s])${prop}\\s*:`, 'u').exec(block);
      if (hit) {
        out.push({
          selector: `@keyframes ${m[1] ?? ''}`,
          line: lineOf(css, m.index),
          detail: `keyframes 里动了布局属性 \`${prop}\`（规范 §4.1）`,
        });
      }
    }
  }
  return out;
}

/**
 * §4.1「不使用 backdrop-filter（仅标题栏可选）」+ §8「单处 ≤ 64k px²」。
 * 静态只能校验「出现在哪个选择器上」，面积交给人工，所以这里用白名单。
 */
export function findBackdropFilters(rawCss: string, allowedSelectors: string[]): Violation[] {
  return parseRules(rawCss)
    .filter((rule) => declValue(rule.body, 'backdrop-filter') !== null)
    .filter((rule) => !allowedSelectors.some((allowed) => rule.selector.includes(allowed)))
    .map((rule) => ({
      selector: rule.selector,
      line: rule.line,
      detail: `用了 backdrop-filter（规范 §4.1 只豁免标题栏，§8 限单处 ≤64k px²）`,
    }));
}

/** §8「阴影层数单元素 ≤4」。 */
export function findExcessShadowLayers(rawCss: string, max = 4): Violation[] {
  const out: Violation[] = [];
  for (const rule of parseRules(rawCss)) {
    const value = declValue(rule.body, 'box-shadow');
    if (!value || value === 'none') continue;
    const layers = splitTopLevel(value).length;
    if (layers > max) {
      out.push({
        selector: rule.selector,
        line: rule.line,
        detail: `box-shadow ${layers} 层，超过 §8 的 ${max} 层预算`,
      });
    }
  }
  return out;
}

/** §8「渐变层数单元素 ≤3」。 */
export function findExcessGradientLayers(rawCss: string, max = 3): Violation[] {
  const out: Violation[] = [];
  for (const rule of parseRules(rawCss)) {
    for (const prop of ['background', 'background-image']) {
      const value = declValue(rule.body, prop);
      if (!value) continue;
      const count = (value.match(/(radial|linear|conic)-gradient/gu) ?? []).length;
      if (count > max) {
        out.push({
          selector: rule.selector,
          line: rule.line,
          detail: `${prop} 里有 ${count} 个渐变，超过 §8 的 ${max} 个预算`,
        });
      }
    }
  }
  return out;
}

/**
 * §4.1 + §8「循环动画**同屏** ≤3」。
 *
 * 全局数一个总数是不对的：标题栏的运行指示点与运行页的分组圆点永远不会
 * 与画布的等待脉冲挤在同一屏。所以按「屏」分组 —— 常驻外壳（标题栏、侧栏）
 * 计入每一屏的预算，页面级的只计自己那一屏。
 */
export function findInfiniteAnimations(rawCss: string): Violation[] {
  return parseRules(rawCss)
    .filter((rule) => {
      const value =
        declValue(rule.body, 'animation') ?? declValue(rule.body, 'animation-iteration-count');
      return value !== null && /\binfinite\b/u.test(value);
    })
    .map((rule) => ({
      selector: rule.selector,
      line: rule.line,
      detail: '挂了无限循环动画',
    }));
}

/** 一个选择器属于哪一「屏」。常驻外壳返回 'shell'，它计入每一屏。 */
export function screenOf(selector: string): string {
  if (/\.title-bar|\.side-nav|\.app-shell/u.test(selector)) return 'shell';
  if (/\.wf-|\.react-flow|\.editor|\.node-lib|\.cfg__|\.ctx__/u.test(selector)) return 'canvas';
  if (/\.runs__|\.conv__|\.ndetail/u.test(selector)) return 'runs';
  if (/\.supervisor|\.memory__/u.test(selector)) return 'supervisor';
  return 'other';
}

/**
 * 互斥组：同组内的选择器不会在同一时刻同屏出现，按 1 个计入预算。
 *
 * 进这份表要写明「为什么它们互斥」，否则它就成了绕开预算的后门。
 * 参照 `crates/mcp/src/catalog.rs` 的 `DELIBERATELY_HIDDEN` 的做法。
 */
const MUTUALLY_EXCLUSIVE: { members: string[]; why: string }[] = [
  {
    members: ['react-flow__edge--waiting', 'react-flow__edge--proposed'],
    why: '「指向等待审批节点」出现在运行卡住时，「AI 提议」出现在编辑时改草稿 —— 两个场景不重叠',
  },
];

/** 把互斥组折叠成 1 个，返回折叠后的列表。 */
function collapseExclusive(selectors: string[]): string[] {
  const out: string[] = [];
  const usedGroups = new Set<number>();
  for (const selector of selectors) {
    const groupIndex = MUTUALLY_EXCLUSIVE.findIndex((group) =>
      group.members.some((member) => selector.includes(member)),
    );
    if (groupIndex === -1) {
      out.push(selector);
      continue;
    }
    if (usedGroups.has(groupIndex)) continue;
    usedGroups.add(groupIndex);
    out.push(selector);
  }
  return out;
}

/**
 * 按屏统计循环动画，返回超预算的屏。
 * 常驻外壳（shell）计入每一屏 —— 标题栏在任何页面上都亮着。
 */
export function findOverAnimatedScreens(
  rawCss: string,
  max = 3,
): { screen: string; count: number; selectors: string[] }[] {
  const all = findInfiniteAnimations(rawCss);
  const byScreen = new Map<string, string[]>();
  const shell: string[] = [];

  for (const hit of all) {
    const screen = screenOf(hit.selector);
    if (screen === 'shell') {
      shell.push(hit.selector);
      continue;
    }
    byScreen.set(screen, [...(byScreen.get(screen) ?? []), hit.selector]);
  }

  const out: { screen: string; count: number; selectors: string[] }[] = [];
  // 每一屏 = 它自己的 + 常驻外壳的，互斥组折叠成 1 个
  for (const [screen, selectors] of byScreen) {
    const combined = collapseExclusive([...shell, ...selectors]);
    if (combined.length > max) out.push({ screen, count: combined.length, selectors: combined });
  }
  // 外壳自己也不能超
  if (shell.length > max) out.push({ screen: 'shell', count: shell.length, selectors: shell });
  return out;
}

/**
 * §2.5 的叠加层是穷举清单。这里校验 `:hover` 规则里的背景叠加，
 * 规范定死列表项悬停为 4.5%，且「高于 6% 在暗场里会显得发白」。
 */
export function findHoverOverlays(
  rawCss: string,
): { selector: string; line: number; value: string }[] {
  return parseRules(rawCss)
    .filter((rule) => /:hover\b/u.test(rule.selector))
    .map((rule) => ({ rule, value: declValue(rule.body, 'background') }))
    .filter((entry): entry is { rule: Rule; value: string } => entry.value !== null)
    .filter((entry) => entry.value !== 'none' && !entry.value.startsWith('var('))
    .map((entry) => ({ selector: entry.rule.selector, line: entry.rule.line, value: entry.value }));
}

/**
 * 规范前言：「实现时只允许引用 var(--*) 与本文列出的少量 rgba 叠加层，
 * 不得新增品牌色」。业务样式表里出现任何十六进制都算违反 ——
 * 色值只该活在令牌文件里。
 */
export function findHardcodedHexColors(rawCss: string): Violation[] {
  const css = stripComments(rawCss);
  const out: Violation[] = [];
  const re = /#[0-9a-fA-F]{3,8}\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({
      selector: '(inline)',
      line: lineOf(css, m.index),
      detail: `硬编码色值 ${m[0]}（规范前言：只允许引用 var(--*)）`,
    });
  }
  return out;
}

/**
 * §5.4「不移除 outline」+ §7「所有可交互元素保留 focus-visible 2px 强调环」。
 * `:focus { outline: none }` 这种全局兜底是允许的（base.css 里有一条），
 * 挂在具体类上的才算把全局环压掉了。
 */
export function findOutlineNone(rawCss: string): Violation[] {
  return parseRules(rawCss)
    .filter((rule) => {
      const value = declValue(rule.body, 'outline');
      return value !== null && /^none\b|^0\b/u.test(value);
    })
    .map((rule) => ({
      selector: rule.selector,
      line: rule.line,
      detail: 'outline: none 压过了全局 :focus-visible 强调环（规范 §5.4「不移除 outline」）',
    }));
}

/**
 * §4.1「遵守 prefers-reduced-motion：关闭 dotrun/waitpulse/flow，
 * 改为静态高亮」——关键在「改为静态高亮」，只把 duration 压到 0 是不够的：
 * 等待审批的光环若只存在于 keyframes 里，降级后就什么都不剩。
 */
export function findAnimationOnlyHighlights(rawCss: string, selectors: string[]): Violation[] {
  const rules = parseRules(rawCss);
  return selectors
    .filter((selector) => {
      const own = rules.filter((rule) => rule.selector.includes(selector));
      if (own.length === 0) return false;
      const hasAnimation = own.some((rule) => declValue(rule.body, 'animation') !== null);
      const hasStaticShadow = own.some((rule) => declValue(rule.body, 'box-shadow') !== null);
      return hasAnimation && !hasStaticShadow;
    })
    .map((selector) => ({
      selector,
      line: rules.find((rule) => rule.selector.includes(selector))?.line ?? 0,
      detail: '高亮只存在于 keyframes 里，prefers-reduced-motion 降级后不剩静态提示（规范 §4.1）',
    }));
}
