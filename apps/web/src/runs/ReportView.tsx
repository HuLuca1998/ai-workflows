import { RichText } from '@aiwf/ui';
import type { ReportBlock, RunReport } from '@aiwf/contracts';

/**
 * 运行报告的渲染层。
 *
 * agent 产出的是结构化数据（`packages/contracts/src/report.ts` 的白名单），
 * 这里按应用自己的设计令牌把它画出来 —— **没有任何 innerHTML**。
 * 理由与 `RichText.tsx` 一样：生成报告的那个 agent 连着系统 MCP，
 * 而报告会被反复打开、分享、导出。
 *
 * 每条工作流的报告长得不一样，不一样体现在**块的组合**上：
 * 日志巡检是「指标 + 表格 + 时间线」，Issue 修复是「摘要 + diff 统计 + 链接」。
 */

export function ReportView({ report }: { report: RunReport }) {
  return (
    <article className="report">
      <header className="report__head">
        <span className="report__outcome" data-outcome={report.outcome}>
          {report.outcome === 'success' ? '完成' : report.outcome === 'warning' ? '有提醒' : '失败'}
        </span>
        <h2 className="report__title">{report.title}</h2>
        <p className="report__summary">{report.summary}</p>
      </header>

      {report.blocks.map((block, index) => (
        <Block key={`${block.kind}:${index}`} block={block} />
      ))}
    </article>
  );
}

function Block({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case 'metrics':
      return (
        <section className="report__block report__metrics">
          {block.title ? <h3>{block.title}</h3> : null}
          <div className="report__metric-row">
            {block.items.map((metric) => (
              <div key={metric.label} className="report__metric" data-tone={metric.tone}>
                <span className="report__metric-value">{metric.value}</span>
                <span className="report__metric-label">{metric.label}</span>
                {/* 副文本承载口径（「同比」「本周」）—— 光有数字读不出含义 */}
                {metric.note ? <span className="report__metric-note">{metric.note}</span> : null}
              </div>
            ))}
          </div>
        </section>
      );

    case 'prose':
      return (
        <section className="report__block">
          {block.title ? <h3>{block.title}</h3> : null}
          {/* 走 markdown 子集，HTML 标签按原文显示 */}
          <RichText text={block.body} />
        </section>
      );

    case 'table':
      return (
        <section className="report__block">
          {block.title ? <h3>{block.title}</h3> : null}
          {/* 表格自己横向滚 —— 页面本身绝不横向滚动 */}
          <div className="report__table-scroll">
            <table className="report__table">
              <thead>
                <tr>
                  {block.columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {/* 按 columns 对齐：多的截掉、少的补空 ——
                        错位的表格比缺一格更难读 */}
                    {block.columns.map((column, cellIndex) => (
                      <td key={column}>{row[cellIndex] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );

    case 'timeline':
      return (
        <section className="report__block">
          {block.title ? <h3>{block.title}</h3> : null}
          <ol className="report__timeline">
            {block.items.map((item, index) => (
              <li key={index} data-tone={item.tone}>
                {item.at ? <span className="report__timeline-at">{item.at}</span> : null}
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
        </section>
      );

    case 'code':
      return (
        <section className="report__block">
          {block.title ? <h3>{block.title}</h3> : null}
          <pre className="report__code" data-lang={block.lang || undefined}>
            {block.body}
          </pre>
        </section>
      );

    case 'links':
      return (
        <section className="report__block">
          {block.title ? <h3>{block.title}</h3> : null}
          <ul className="report__links">
            {block.items.map((item) => (
              <li key={item.href}>
                {/* 协议已经在 Schema 那层过过白名单（只收 http/https）——
                    这里再挂 noreferrer 是防「报告里的链接把来源带出去」 */}
                <a href={item.href} target="_blank" rel="noreferrer noopener">
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      );
  }
}
