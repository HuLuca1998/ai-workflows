import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 六个列表页的搜索必须是同一套交互。
 *
 * 第 5 轮审查（第 19 条）：「搜索三种行为 —— 概览/执行记录/Agent 输入即搜，
 * 提示词/记忆只有回车，模型页没有搜索框」。
 *
 * 用户每换一屏都要重新试一次「这里到底怎么搜」，而三种里有两种
 * 会让他以为搜索坏了：输入完没反应（其实要回车）、找不到框（其实没有）。
 */

const 列表页 = [
  'pages/OverviewPage.tsx',
  'runs/RunsPage.tsx',
  'agents/AgentsPage.tsx',
  'prompts/PromptsPage.tsx',
  'memory/MemoryPage.tsx',
  'models/ModelsPage.tsx',
];

const 读 = (rel: string) => readFileSync(join(import.meta.dirname, '../src', rel), 'utf8');

describe('搜索交互一致', () => {
  it('每个列表页都有搜索框', () => {
    const 缺的 = 列表页.filter((rel) => !/placeholder="搜索/u.test(读(rel)));
    expect(缺的, `这些页没有搜索框：${缺的.join('、')}`).toEqual([]);
  });

  it('每个搜索框都是输入即搜 —— 走同一个 useDebouncedSearch', () => {
    const 缺的 = 列表页.filter((rel) => !读(rel).includes('useDebouncedSearch'));
    expect(缺的, `这些页的搜索要按回车才生效，与其余几页不一致：${缺的.join('、')}`).toEqual([]);
  });
});

/**
 * 一段代码里有没有「自己攒输入」的防抖。
 *
 * 原来的判据是 `/setTimeout\([^)]*\bquery\b/`，而真实写法是
 * `setTimeout(() => { setQuery(v) }, 300)` —— `[^)]*` 在 `() =>`
 * 那个右括号处就停了，**没有任何一种常见写法能匹配上**。
 * 于是这条门禁对任何实现都绿：它不是在守，它只是在跑。
 *
 * 抽成函数是为了能就地自检（下面那条用例）—— 一条抓不住违规的
 * 静态扫描比没有更糟，它占着「这里有覆盖」的位置。
 */
export function 疑似自写防抖(text: string): boolean {
  // setTimeout 之后 200 字符内出现 query / search / keyword。
  // 跨行匹配：回调体几乎总是换行写的
  return /setTimeout\([\s\S]{0,200}?\b(set)?(query|search|keyword)\b/iu.test(text);
}

describe('那条静态扫描本身抓得住违规', () => {
  // 判据自身的元测试。改坏 `疑似自写防抖` 时这里先红
  it('认得出常见的自写防抖写法', () => {
    const 样本 = [
      'const t = setTimeout(() => {\n  setQuery(value);\n}, 300);',
      'setTimeout(function () { search(input) }, 200)',
      'timer.current = setTimeout(\n  () => onSearch(keyword),\n  250,\n);',
    ];
    for (const 一段 of 样本) {
      expect(疑似自写防抖(一段), `没认出来：${一段}`).toBe(true);
    }
  });

  it('不误伤与搜索无关的 setTimeout', () => {
    const 样本 = [
      'setTimeout(() => setOpen(false), 3000);',
      'const id = setTimeout(重试, 1000);',
      'await new Promise((r) => setTimeout(r, 50));',
    ];
    for (const 一段 of 样本) {
      expect(疑似自写防抖(一段), `误伤了：${一段}`).toBe(false);
    }
  });
});

describe('没有页面自己写防抖', () => {
  it('那会长出第二种节奏', () => {
    const 违规: string[] = [];
    const 扫 = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          扫(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (path.includes('useDebouncedSearch')) continue;
        if (疑似自写防抖(readFileSync(path, 'utf8'))) 违规.push(path);
      }
    };
    扫(join(import.meta.dirname, '../src'));

    expect(违规, `这些文件自己实现了搜索防抖：${违规.join('、')}`).toEqual([]);
  });
});
