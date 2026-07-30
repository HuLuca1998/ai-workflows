// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findAnimatedLayoutProps,
  findAnimationOnlyHighlights,
  findBackdropFilters,
  findExcessGradientLayers,
  findExcessShadowLayers,
  findHardcodedHexColors,
  findHoverOverlays,
  findInfiniteAnimations,
  findOutlineNone,
  findOverAnimatedScreens,
  parseRules,
  splitTopLevel,
} from './_specBudget.js';

/**
 * 视觉与交互规范 v1.0（`docs/archive/design/client/视觉与交互规范.dc.html`）
 * 的 §2.5 / §4.1 / §8 里可机械校验的部分。
 *
 * 这些约束此前一条守卫都没有 —— 于是状态色分叉、悬停值发散、
 * 全屏 backdrop-filter 都能长期绿着。DEBT.md 里 7 条坏账有 5 条是这个形态。
 *
 * 每道门禁下面都跟着一条「元测试」：喂一段故意违反的 CSS，
 * 断言门禁函数真的会把它挑出来。守卫不能证明自己会红，就不是守卫。
 */

const webCss = readFileSync(join(process.cwd(), 'apps/web/src/styles.css'), 'utf8');
const uiComponentsCss = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/components.css'),
  'utf8',
);
const uiBaseCss = readFileSync(join(process.cwd(), 'packages/ui/src/styles/base.css'), 'utf8');

/** 失败信息里带上文件:行号，直接可跳转。 */
function report(list: { selector: string; line: number; detail: string }[], file: string): string {
  return list.map((v) => `  ${file}:${v.line}  ${v.selector} — ${v.detail}`).join('\n');
}

describe('规范 §4.1 · 动效硬性约束', () => {
  it('只动 opacity/transform/stroke-dashoffset/box-shadow，不动 width/height/top/left/filter', () => {
    const hits = [
      ...findAnimatedLayoutProps(webCss).map((v) => ({ ...v, file: 'apps/web/src/styles.css' })),
      ...findAnimatedLayoutProps(uiComponentsCss).map((v) => ({
        ...v,
        file: 'packages/ui/src/styles/components.css',
      })),
    ];
    expect(
      hits,
      `动画/过渡触发布局的属性会让每一帧都重排：\n${hits
        .map((v) => `  ${v.file}:${v.line}  ${v.selector} — ${v.detail}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('【元测试】动了 width 的 transition 会被挑出来', () => {
    const bad = `.bar { transition: width 0.3s ease; }`;
    const hits = findAnimatedLayoutProps(bad);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain('width');
  });

  it('【元测试】keyframes 里动 filter 会被挑出来', () => {
    const bad = `@keyframes glow { from { filter: blur(0) } to { filter: blur(4px) } }`;
    expect(findAnimatedLayoutProps(bad).length).toBeGreaterThan(0);
  });

  it('【元测试】只动 opacity/transform 的不报', () => {
    const good = `
      .dot { transition: opacity 160ms ease, transform 180ms ease; }
      @keyframes dotrun { 0% { opacity: .25 } 50% { opacity: 1 } }
    `;
    expect(findAnimatedLayoutProps(good)).toEqual([]);
  });

  it('不使用 backdrop-filter —— 规范只豁免标题栏', () => {
    const hits = findBackdropFilters(webCss, ['.title-bar']);
    expect(
      hits,
      `全屏遮罩上的 backdrop-filter 每帧都要重采样整屏背景，正是「性能优先 8:2」要挡的开销：\n${report(hits, 'apps/web/src/styles.css')}`,
    ).toEqual([]);
  });

  it('【元测试】非豁免选择器上的 backdrop-filter 会被挑出来', () => {
    const bad = `.cfg__backdrop { backdrop-filter: blur(3px); }`;
    expect(findBackdropFilters(bad, ['.title-bar'])).toHaveLength(1);
  });

  it('【元测试】豁免的标题栏不报', () => {
    const ok = `.title-bar { backdrop-filter: blur(20px); }`;
    expect(findBackdropFilters(ok, ['.title-bar'])).toEqual([]);
  });

  it('循环动画同屏不超过 3 个 —— 同屏注意力只能有一个焦点', () => {
    // 按屏统计：常驻外壳（标题栏/侧栏）计入每一屏，页面级的只计自己那屏
    const over = [...findOverAnimatedScreens(webCss), ...findOverAnimatedScreens(uiComponentsCss)];
    expect(
      over,
      `规范 §4.1 限同屏 ≤3、§9 写明「不在同一屏出现两个以上呼吸/脉冲元素」：\n${over
        .map((o) => `  [${o.screen}] ${o.count} 个：${o.selectors.join(', ')}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('【元测试】数得出无限动画', () => {
    const bad = `
      .a { animation: pulse 1.6s infinite; }
      .b { animation: pulse 1.6s infinite; }
      .c { animation: spin 2s linear infinite; }
      .d { animation: fade 1s infinite; }
    `;
    expect(findInfiniteAnimations(bad)).toHaveLength(4);
  });

  it('【元测试】同一屏超预算会被挑出来', () => {
    const bad = `
      .wf-node-a { animation: a 1s infinite; }
      .wf-node-b { animation: b 1s infinite; }
      .react-flow__x { animation: c 1s infinite; }
      .title-bar__dot { animation: d 1s infinite; }
    `;
    const over = findOverAnimatedScreens(bad);
    expect(over).toHaveLength(1);
    expect(over[0]?.screen).toBe('canvas');
    expect(over[0]?.count).toBe(4); // 3 个画布的 + 1 个常驻标题栏的
  });

  it('【元测试】互斥组折叠成 1 个 —— 但只对表里写明理由的那些生效', () => {
    // 「等待」与「AI 提议」两种连线不会同屏（运行卡住 vs 编辑改草稿）
    const exclusive = `
      .title-bar__dot { animation: a 1s infinite; }
      .wf-node[data-tone='wait'] { animation: b 1s infinite; }
      .react-flow__edge--waiting .react-flow__edge-path { animation: c 1s infinite; }
      .react-flow__edge--proposed .react-flow__edge-path { animation: d 1s infinite; }
    `;
    expect(findOverAnimatedScreens(exclusive)).toEqual([]);

    // 没进互斥表的照样超 —— 后门不能随便开
    const notExclusive = `
      .title-bar__dot { animation: a 1s infinite; }
      .wf-node-x { animation: b 1s infinite; }
      .wf-node-y { animation: c 1s infinite; }
      .wf-node-z { animation: d 1s infinite; }
    `;
    expect(findOverAnimatedScreens(notExclusive)).toHaveLength(1);
  });

  it('【元测试】分散在不同屏的循环动画不算超', () => {
    const ok = `
      .title-bar__dot { animation: a 1s infinite; }
      .wf-node[data-tone='wait'] { animation: b 1s infinite; }
      .react-flow__edge--flow { animation: c 1s infinite; }
      .runs__dot { animation: d 1s infinite; }
    `;
    // canvas 屏 = shell(1) + canvas(2) = 3 ✓；runs 屏 = shell(1) + runs(1) = 2 ✓
    expect(findOverAnimatedScreens(ok)).toEqual([]);
  });

  it('【元测试】只播一次的入场动画不计入循环预算', () => {
    const ok = `.drawer { animation: slidein 220ms ease-out; }`;
    expect(findInfiniteAnimations(ok)).toEqual([]);
  });

  it('prefers-reduced-motion 下等待节点仍有静态高亮，而不是什么都不剩', () => {
    const hits = findAnimationOnlyHighlights(webCss, ["[data-tone='wait']"]);
    expect(
      hits,
      `规范 §4.1 要求降级为「静态高亮」而不是抹掉动画。waitpulse 是全画布唯一的强提醒，\n光环若只活在 keyframes 里，开了减少动效的用户就完全收不到审批提示：\n${report(hits, 'apps/web/src/styles.css')}`,
    ).toEqual([]);
  });

  it('【元测试】光环只在 keyframes 里的会被挑出来', () => {
    const bad = `.wf-node[data-tone='wait'] { border-color: #796cbf; animation: waitpulse 2.4s infinite; }`;
    expect(findAnimationOnlyHighlights(bad, ["[data-tone='wait']"])).toHaveLength(1);
  });

  it('【元测试】基础规则里带静态 box-shadow 的不报', () => {
    const ok = `.wf-node[data-tone='wait'] { box-shadow: 0 0 20px rgba(145,132,217,.5); animation: waitpulse 2.4s infinite; }`;
    expect(findAnimationOnlyHighlights(ok, ["[data-tone='wait']"])).toEqual([]);
  });
});

describe('规范 §8 · 性能预算', () => {
  it('单元素阴影不超过 4 层', () => {
    const hits = findExcessShadowLayers(webCss);
    expect(hits, report(hits, 'apps/web/src/styles.css')).toEqual([]);
  });

  it('【元测试】5 层阴影会被挑出来', () => {
    const bad = `.card { box-shadow: 0 0 0 1px #000, 0 1px 0 #111, 0 2px 4px #222, 0 4px 8px #333, 0 8px 16px #444; }`;
    expect(findExcessShadowLayers(bad)).toHaveLength(1);
  });

  it('【元测试】4 层不报（含 inset 与 rgba 里的逗号）', () => {
    const ok = `.shell { box-shadow: 0 0 0 1px rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.07) inset, 0 50px 120px -24px rgba(0,0,0,.9), 0 0 100px -40px rgba(145,132,217,.5); }`;
    expect(findExcessShadowLayers(ok)).toEqual([]);
  });

  it('单元素渐变不超过 3 个', () => {
    const hits = findExcessGradientLayers(webCss);
    expect(hits, report(hits, 'apps/web/src/styles.css')).toEqual([]);
  });

  it('【元测试】4 个渐变会被挑出来', () => {
    const bad = `.bg { background: radial-gradient(#000,#111), radial-gradient(#222,#333), linear-gradient(#444,#555), radial-gradient(#666,#777); }`;
    expect(findExcessGradientLayers(bad)).toHaveLength(1);
  });

  it('【元测试】3 个渐变不报 —— 环境光配方正好三层', () => {
    const ok = `.canvas { background: radial-gradient(#000,#111), radial-gradient(#222,#333), radial-gradient(#444,#555); }`;
    expect(findExcessGradientLayers(ok)).toEqual([]);
  });
});

describe('规范 §2.5 · 叠加层是穷举清单', () => {
  it('列表项悬停统一 4.5% —— 低于 3% 感知不到，高于 6% 暗场发白', () => {
    const overlays = findHoverOverlays(webCss);
    const offenders = overlays.filter((entry) => {
      // 允许：规范穷举的 .035 / .045 / .06–.09 三档文字色叠加，以及紫色选中底
      if (/rgba\(\s*233\s*,\s*233\s*,\s*237\s*,\s*0?\.0(35|45)\s*\)/u.test(entry.value))
        return false;
      if (/rgba\(\s*145\s*,\s*132\s*,\s*217\s*,/u.test(entry.value)) return false;
      if (/^(transparent|none|inherit)$/u.test(entry.value)) return false;
      return true;
    });
    expect(
      offenders,
      `§2.5 把悬停定死在 rgba(233,233,237,.045)，理由写着「高于 6% 在暗场里会显得发白」：\n${offenders
        .map((o) => `  apps/web/src/styles.css:${o.line}  ${o.selector} — ${o.value}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('【元测试】认得出偏离规范的悬停值', () => {
    const bad = `
      .a:hover { background: rgba(233, 233, 237, 0.07); }
      .b:hover { background: color-mix(in srgb, var(--color-surface) 45%, transparent); }
      .ok:hover { background: rgba(233, 233, 237, 0.045); }
    `;
    const overlays = findHoverOverlays(bad);
    expect(overlays).toHaveLength(3);
    expect(overlays.filter((o) => o.value.includes('0.045'))).toHaveLength(1);
  });
});

describe('规范前言 · 只允许引用 var(--*)，不得新增品牌色', () => {
  it('业务样式表里没有硬编码十六进制 —— 色值只该活在令牌文件里', () => {
    const hits = findHardcodedHexColors(webCss);
    expect(
      hits,
      `硬编码会让同一语义在不同页面漂成不同的色（实测已有两种绿、四种红）：\n${report(hits, 'apps/web/src/styles.css')}`,
    ).toEqual([]);
  });

  it('【元测试】认得出硬编码色值', () => {
    const bad = `.ok { color: #7fb894; }`;
    expect(findHardcodedHexColors(bad)).toHaveLength(1);
  });

  it('【元测试】var() 引用不报', () => {
    const ok = `.ok { color: var(--color-status-success); }`;
    expect(findHardcodedHexColors(ok)).toEqual([]);
  });

  it('引用的语义色令牌必须真的存在 —— 否则 fallback 会永久生效', () => {
    const referenced = [...webCss.matchAll(/var\(\s*(--color-[\w-]+)/gu)].map((m) => m[1] ?? '');
    const tokensCss = readFileSync(
      join(process.cwd(), 'packages/ui/src/styles/tokens.css'),
      'utf8',
    );
    const missing = [...new Set(referenced)].filter(
      (name) =>
        !new RegExp(`${name}\\s*:`, 'u').test(tokensCss) &&
        !new RegExp(`${name}\\s*:`, 'u').test(webCss),
    );
    expect(
      missing,
      `var(--不存在的令牌, fallback) 是合法语法，CSS 不报错、lint 也不报 —— \nfallback 于是成了唯一真值，而它多半不在规范色板里：${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('规范 §5.4 / §7 · 焦点环', () => {
  it('不移除 outline —— 全局 :focus-visible 环不能被类选择器压掉', () => {
    const hits = findOutlineNone(webCss);
    expect(
      hits,
      `全局环在 packages/ui/src/styles/base.css 是 :focus-visible（特异度 0,1,0），\n挂在类上的 outline:none（0,1,1 起）会逐条压过它：\n${report(hits, 'apps/web/src/styles.css')}`,
    ).toEqual([]);
  });

  it('【元测试】认得出 outline: none', () => {
    const bad = `.search input { outline: none; }`;
    expect(findOutlineNone(bad)).toHaveLength(1);
  });

  it('组件库保留了全局 focus-visible 2px 强调环', () => {
    expect(uiBaseCss).toContain(':focus-visible');
    expect(uiBaseCss).toContain('outline: 2px solid var(--color-accent)');
  });
});

describe('解析器自身', () => {
  it('顶层逗号切分不会被括号里的逗号骗到', () => {
    expect(splitTopLevel('0 0 0 1px rgba(0,0,0,.5), 0 1px 0 #fff')).toEqual([
      '0 0 0 1px rgba(0,0,0,.5)',
      '0 1px 0 #fff',
    ]);
  });

  it('注释被剥掉但行号不错位', () => {
    const css = `/* 一行注释\n还是注释 */\n.a { color: red; }`;
    const rules = parseRules(css);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.line).toBe(3);
  });

  it('@media 里的规则也解析得到', () => {
    const css = `@media (prefers-contrast: more) { .a { color: red; } }`;
    expect(parseRules(css).some((r) => r.selector.includes('.a'))).toBe(true);
  });
});
