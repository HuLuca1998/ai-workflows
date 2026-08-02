import { describe, expect, it } from 'vitest';

import { validateGraph } from '../src/graph.js';
import BUILTIN from '../generated/builtin-workflows.json' with { type: 'json' };

/**
 * 内置模板自己要过 `UPSTREAM_UNUSED` 这条检查。
 *
 * 校验器替所有人查「上一个的输出在下一个节点用到了吗」
 * （`graph.ts` 的那段），而**我们自己的模板是第一批用户**。
 * 它们不过自己的检查的话，用户照着学的就是错的接法。
 *
 * 有意不引用的进白名单**并写明理由**。
 */
const 有意不引用: Record<string, string> = {
  'release-checklist.write_report':
    'assess 的两个端口（passed / changes_requested）都通向它，运行时只有一个进作用域，' +
    '引用哪个都会在另一半场景下炸。改成让它用系统 MCP 的 run_events 自己读 —— 模板注释里写着。',
  'github-issue-feature.write_report': '同上：review 的两个端口都通向它，所以不能直接引用 review。',
};

describe('内置模板过自己的上下文检查', () => {
  for (const item of BUILTIN) {
    it(`${item.templateId} 的 AI 节点都接上了上游`, () => {
      const 漏了 = validateGraph(item.graph as never)
        .issues.filter((i) => i.code === 'UPSTREAM_UNUSED')
        .filter((i) => !(`${item.templateId}.${i.nodeId}` in 有意不引用))
        .map((i) => `${i.nodeId}：${i.message}`);
      expect(漏了, `\n  ${漏了.join('\n  ')}\n`).toEqual([]);
    });
  }

  it('白名单里每一条都写了理由', () => {
    for (const [key, reason] of Object.entries(有意不引用)) {
      expect(reason.length, `${key} 的理由太短，等于没写`).toBeGreaterThan(20);
    }
  });
});
