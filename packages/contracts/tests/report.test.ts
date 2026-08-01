import { describe, expect, it } from 'vitest';
import { REPORT_ARTIFACT_NAME, RunReportSchema, parseRunReport } from '../src/report.js';

/**
 * 运行报告的 Schema。
 *
 * 它同时是**组件白名单** —— agent 产出结构化数据，应用按自己的设计令牌
 * 渲染。不让 agent 写 HTML 的理由与 `RichText.tsx` 一样：那个 agent
 * 连着系统 MCP、读得到工作流、改得动草稿，而报告会被反复打开与分享。
 */

const 最小报告 = {
  title: '日志巡检 · 2026-08-02',
  summary: '过去 24 小时 3 类错误共 812 次，最频繁的是数据库连接超时。',
  blocks: [{ kind: 'prose' as const, body: '没什么特别的。' }],
};

describe('报告的基本形状', () => {
  it('标题 + 一句话结论 + 至少一块内容', () => {
    const parsed = RunReportSchema.safeParse(最小报告);
    expect(parsed.success).toBe(true);
  });

  it('没有块的报告不算报告 —— 那是一个空抽屉', () => {
    expect(RunReportSchema.safeParse({ ...最小报告, blocks: [] }).success).toBe(false);
  });

  it('缺结论不行 —— 列表页要显示它', () => {
    const { summary: _summary, ...没结论 } = 最小报告;
    expect(RunReportSchema.safeParse(没结论).success).toBe(false);
  });

  it('默认是「成功」的语气，可以显式说成有问题', () => {
    expect(RunReportSchema.parse(最小报告).outcome).toBe('success');
    expect(RunReportSchema.parse({ ...最小报告, outcome: 'warning' }).outcome).toBe('warning');
  });

  it('版本号带默认值 —— 老报告不写它也读得出来', () => {
    expect(RunReportSchema.parse(最小报告).schemaVer).toBe(1);
  });
});

describe('块的白名单', () => {
  it('六种块都认', () => {
    const blocks = [
      { kind: 'metrics', items: [{ label: '错误', value: '812' }] },
      { kind: 'prose', body: '说明' },
      { kind: 'table', columns: ['时间', '次数'], rows: [['01:00', '12']] },
      { kind: 'timeline', items: [{ text: '开始' }] },
      { kind: 'code', body: 'SELECT 1' },
      { kind: 'links', items: [{ label: 'PR', href: 'https://example.com/pr/1' }] },
    ];
    const parsed = RunReportSchema.safeParse({ ...最小报告, blocks });
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
  });

  it('认不出的 kind 被挡在门外 —— 这就是白名单的意思', () => {
    const parsed = RunReportSchema.safeParse({
      ...最小报告,
      blocks: [{ kind: 'iframe', src: 'https://evil.example.com' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('块里塞 HTML 只是普通文本 —— 渲染方按 markdown 子集处理', () => {
    const parsed = RunReportSchema.safeParse({
      ...最小报告,
      blocks: [{ kind: 'prose', body: '<script>alert(1)</script>' }],
    });
    // Schema 不拒绝这段字符串（它就是一段文本），
    // 安全由渲染层保证 —— RichText 从不用 innerHTML
    expect(parsed.success).toBe(true);
  });
});

describe('链接只收 http/https', () => {
  it.each(['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd'])(
    '%s 被挡掉',
    (href) => {
      const parsed = RunReportSchema.safeParse({
        ...最小报告,
        blocks: [{ kind: 'links', items: [{ label: '点我', href }] }],
      });
      expect(parsed.success, `${href} 应该被 Schema 拒绝，不能留给渲染层去记得过滤`).toBe(false);
    },
  );

  it('正常链接照收', () => {
    const parsed = RunReportSchema.safeParse({
      ...最小报告,
      blocks: [{ kind: 'links', items: [{ label: 'PR', href: 'https://github.com/a/b/pull/1' }] }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('尺寸上限', () => {
  it('块数有上限 —— 一份报告不该是一本书', () => {
    const blocks = Array.from({ length: 31 }, () => ({ kind: 'prose' as const, body: 'x' }));
    expect(RunReportSchema.safeParse({ ...最小报告, blocks }).success).toBe(false);
  });

  it('表格行数有上限 —— 界面渲染不了三千行', () => {
    const rows = Array.from({ length: 201 }, (_, i) => [String(i)]);
    const parsed = RunReportSchema.safeParse({
      ...最小报告,
      blocks: [{ kind: 'table', columns: ['n'], rows }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('解析失败不抛', () => {
  it('坏报告返回 null，不是抛异常', () => {
    // 一份坏报告不该让运行详情页整个打不开
    expect(parseRunReport({ 这不是报告: true })).toBeNull();
    expect(parseRunReport(null)).toBeNull();
    expect(parseRunReport('一段字符串')).toBeNull();
  });

  it('好报告返回解析后的对象（带默认值）', () => {
    const report = parseRunReport(最小报告);
    expect(report?.title).toBe(最小报告.title);
    expect(report?.outcome).toBe('success');
  });
});

describe('产物名是固定的', () => {
  it('引擎按它认、界面按它找 —— 两边不能各写一个字面量', () => {
    expect(REPORT_ARTIFACT_NAME).toBe('report.json');
  });
});
