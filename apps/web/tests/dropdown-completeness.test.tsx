import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMethodSpec } from '@aiwf/contracts';

/**
 * 「列全部」的下拉不能被分页默认值截断。
 *
 * codex 第二轮报的原话：模型页有 70 条、第二页那三个基线模型是启用的，
 * 但主管 AI 的模型下拉「恰好只有 50 个选项，三个已启用的基线模型
 * 一个都没有」。界面上写着「只列出这里已启用的条目」，
 * 实际行为却是「只列出第一页里已启用的条目」。
 *
 * 根因是分页的默认 limit：列表页要分页，下拉要全量，而两者调的是
 * 同一个方法。**下拉必须显式写出它要多少**，不写就拿到默认值 ——
 * 而那个默认值是给列表页定的。
 */

const 源 = new Map<string, string>();
const 扫 = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) 扫(path);
    else if (/\.tsx?$/.test(entry.name)) 源.set(path, readFileSync(path, 'utf8'));
  }
};
扫(join(import.meta.dirname, '../src'));

describe('下拉列表不被分页截断', () => {
  it('model.list 的每一处「只列已启用」调用都显式写了 limit', () => {
    const 违规: string[] = [];
    for (const [path, 内容] of 源) {
      // 找 call('model.list', { … }) 的调用，逐个看它带没带 limit
      for (const m of 内容.matchAll(/call\(\s*'model\.list'\s*,\s*(\{[\s\S]{0,200}?\})\s*\)/g)) {
        const 入参 = m[1]!;
        // 只管下拉：enabledOnly: true 才是「只列已启用的那份清单」。
        // 列表页传 false（要全部）并且自己分页，不在这条守卫的范围里
        if (/enabledOnly:\s*true/u.test(入参) && !入参.includes('limit')) {
          违规.push(path);
        }
      }
    }

    expect(
      违规,
      `这些地方要「全部已启用的模型」却没写 limit，会被默认分页截断：${违规.join('、')}`,
    ).toEqual([]);
  });

  it('契约的分页默认值确实会截断 —— 这条守卫不是杞人忧天', () => {
    const parsed = getMethodSpec('model.list').input.parse({ enabledOnly: true });
    const limit = (parsed as { limit?: number }).limit;

    expect(limit, '不带 limit 时应该有个默认值').toBeDefined();
    expect(limit).toBeLessThan(200);
  });

  it('下拉写的 limit 不能超过契约上限，否则整个请求被拒', () => {
    const spec = getMethodSpec('model.list');
    for (const [path, 内容] of 源) {
      for (const m of 内容.matchAll(/call\(\s*'model\.list'\s*,\s*\{([\s\S]{0,200}?)\}\s*\)/g)) {
        const limit = /limit:\s*(\d+)/.exec(m[1]!);
        if (!limit) continue;
        expect(
          spec.input.safeParse({ enabledOnly: true, limit: Number(limit[1]) }).success,
          `${path} 写的 limit=${limit[1]} 过不了契约校验`,
        ).toBe(true);
      }
    }
  });
});
