import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunReport } from '@aiwf/contracts';

import { ReportView } from '../src/runs/ReportView.js';

/**
 * 报告的渲染层。
 *
 * 核心约束：**没有任何 innerHTML**。生成报告的 agent 连着系统 MCP，
 * 而报告会被反复打开、分享、导出 —— 与 `RichText.tsx` 同一条理由。
 */

const 报告 = (blocks: RunReport['blocks']): RunReport => ({
  schemaVer: 1,
  title: '日志巡检 · 2026-08-02',
  summary: '过去 24 小时 3 类错误共 812 次。',
  outcome: 'warning',
  blocks,
});

describe('报告头', () => {
  it('标题与一句话结论都显示', () => {
    render(<ReportView report={报告([{ kind: 'prose', body: 'x' }])} />);
    expect(screen.getByText('日志巡检 · 2026-08-02')).toBeTruthy();
    expect(screen.getByText(/812 次/u)).toBeTruthy();
  });

  it('结论语气用文字表达，不只是颜色', () => {
    // 色觉障碍用户与黑白截图同样要读得出来
    render(<ReportView report={报告([{ kind: 'prose', body: 'x' }])} />);
    expect(screen.getByText('有提醒')).toBeTruthy();
  });
});

describe('六种块都画得出来', () => {
  it('指标：数字、标签与口径都在', () => {
    render(
      <ReportView
        report={报告([
          {
            kind: 'metrics',
            items: [{ label: '错误总数', value: '812', note: '较昨日 +12%', tone: 'danger' }],
          },
        ])}
      />,
    );
    expect(screen.getByText('812')).toBeTruthy();
    expect(screen.getByText('错误总数')).toBeTruthy();
    expect(screen.getByText('较昨日 +12%')).toBeTruthy();
  });

  it('表格：表头与单元格', () => {
    render(
      <ReportView
        report={报告([
          {
            kind: 'table',
            columns: ['时间', '次数'],
            rows: [
              ['01:00', '12'],
              ['02:00', '30'],
            ],
          },
        ])}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('时间')).toBeTruthy();
    expect(within(table).getByText('02:00')).toBeTruthy();
  });

  it('表格的行按列对齐 —— 多的截掉、少的补空', () => {
    render(
      <ReportView
        report={报告([
          {
            kind: 'table',
            columns: ['a', 'b'],
            // 一行多一格、一行少一格
            rows: [['1', '2', '3'], ['4']],
          },
        ])}
      />,
    );
    const rows = screen.getAllByRole('row');
    // 表头 + 2 行；每行都恰好 2 格
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getAllByRole('cell')).toHaveLength(2);
    expect(within(rows[2]!).getAllByRole('cell')).toHaveLength(2);
  });

  it('时间线：时刻与内容', () => {
    render(
      <ReportView
        report={报告([
          {
            kind: 'timeline',
            items: [{ at: '01:12', text: '数据库连接超时', tone: 'danger' as const }],
          },
        ])}
      />,
    );
    expect(screen.getByText('01:12')).toBeTruthy();
    expect(screen.getByText('数据库连接超时')).toBeTruthy();
  });

  it('代码块原样显示', () => {
    render(<ReportView report={报告([{ kind: 'code', lang: 'sql', body: 'SELECT 1' }])} />);
    expect(screen.getByText('SELECT 1')).toBeTruthy();
  });

  it('链接带 noopener noreferrer —— 报告里的链接不该把来源带出去', () => {
    render(
      <ReportView
        report={报告([
          { kind: 'links', items: [{ label: '那个 PR', href: 'https://example.com/pr/1' }] },
        ])}
      />,
    );
    const link = screen.getByRole('link', { name: '那个 PR' });
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });
});

describe('不给 agent 渲染通道', () => {
  it('prose 里的 HTML 标签按原文显示，不解释', () => {
    render(
      <ReportView report={报告([{ kind: 'prose', body: '<img src=x onerror="alert(1)">危险' }])} />,
    );
    // 没有 img 元素被创建出来
    expect(document.querySelector('img')).toBeNull();
    // 而那段文字用户看得到（吞掉的话用户不知道 agent 写了什么）
    expect(document.body.textContent).toContain('危险');
  });

  it('表格单元格里的 HTML 同样不解释', () => {
    render(
      <ReportView
        report={报告([{ kind: 'table', columns: ['x'], rows: [['<script>alert(1)</script>']] }])}
      />,
    );
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('<script>');
  });

  it('代码块里的 HTML 也不解释', () => {
    render(
      <ReportView
        report={报告([{ kind: 'code', lang: '', body: '<iframe src="https://evil"></iframe>' }])}
      />,
    );
    expect(document.querySelector('iframe')).toBeNull();
  });
});
