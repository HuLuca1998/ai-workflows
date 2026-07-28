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

  it('没有页面自己写防抖 —— 那会长出第二种节奏', () => {
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
        const text = readFileSync(path, 'utf8');
        // 搜索场景里自己 setTimeout 攒输入 = 又一份防抖
        if (/setTimeout\([^)]*\bquery\b/u.test(text)) 违规.push(path);
      }
    };
    扫(join(import.meta.dirname, '../src'));

    expect(违规, `这些文件自己实现了搜索防抖：${违规.join('、')}`).toEqual([]);
  });
});
