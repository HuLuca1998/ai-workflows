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

  /*
   * **门禁有了不等于被读了。**
   *
   * `PORT_NO_DOWNSTREAM` 一直在正确地报 —— 实测它对八个内置模板
   * 一共报了 21 条，一条不漏 —— 只是从来没有人去看它报了什么。
   *
   * 「走到没有下游的端口」在 O-27 修完之后是**响亮的失败**，
   * 所以留着一个不接的 `failed` 端口等于说「走到这里就算这条运行失败」。
   * 那对多数节点是对的（读不到 issue、建不了 worktree、push 不上去），
   * 所以这条白名单会比较长 —— 但每一条都得是**有人想过**的。
   */
  const 有意留空: Record<string, string> = {
    ...Object.fromEntries(
      [
        'github-issue-fix.read_issue',
        'github-issue-fix.worktree',
        'github-issue-fix.fix',
        'github-issue-fix.push_pr',
        'github-issue-feature.read_issue',
        'github-issue-feature.worktree',
        'github-issue-feature.build',
        'github-issue-feature.push_pr',
      ].map((k) => [
        k,
        '这一步失败就该让整条运行失败：读不到 Issue / 建不了 worktree / ' +
          '改不动代码 / push 不上去，后面每一步都没有意义。' +
          '走到没下游的端口现在是响亮的失败（O-27），事件里会点名停在哪。',
      ]),
    ),
    ...Object.fromEntries(
      [
        'repo-digest.collect',
        'server-log-triage.collect',
        'dep-upgrade-audit.scan',
        'release-checklist.check',
        'pr-followup.collect',
      ].map((k) => [
        k,
        '采集这一步失败就没有材料可分析，整条运行该失败。' +
          '这些模板的「材料不足」终点接的是 AI 判断那一档，不是采集失败这一档。',
      ]),
    ),
    ...Object.fromEntries(
      [
        'github-issue-feature.write_report',
        'repo-digest.write_report',
        'server-log-triage.write_report',
        'dep-upgrade-audit.write_report',
        'release-checklist.write_report',
        'pr-followup.write_report',
        'release-pipeline.write_report',
      ].map((k) => [
        k,
        '报告写不出来就是这条运行没有交付物 —— 该失败。' +
          '把它接到成功终点等于「报告没写出来但算跑成了」，那正是这个仓库要防的那种谎。',
      ]),
    ),
  };

  for (const item of BUILTIN) {
    it(`${item.templateId} 的空端口都是有人想过的`, () => {
      const 没想过 = validateGraph(item.graph as never)
        .issues.filter((i) => i.code === 'PORT_NO_DOWNSTREAM')
        .filter((i) => !(`${item.templateId}.${i.nodeId}` in 有意留空))
        .map((i) => `${i.nodeId}：${i.message}`);
      expect(没想过, `\n  ${没想过.join('\n  ')}\n`).toEqual([]);
    });
  }

  it('空端口白名单里每一条都写了理由', () => {
    for (const [key, reason] of Object.entries(有意留空)) {
      expect(reason.length, `${key} 的理由太短，等于没写`).toBeGreaterThan(20);
    }
  });

  it('白名单里每一条都写了理由', () => {
    for (const [key, reason] of Object.entries(有意不引用)) {
      expect(reason.length, `${key} 的理由太短，等于没写`).toBeGreaterThan(20);
    }
  });
});
