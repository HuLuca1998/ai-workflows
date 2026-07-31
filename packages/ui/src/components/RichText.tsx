import { Fragment, createElement, type ReactNode } from 'react';

/**
 * AI 输出的展示组件 —— **受限 markdown 子集，不是渲染通道**。
 *
 * agent 的输出直接进这里。给它完整 HTML（dangerouslySetInnerHTML、
 * 引一个吃原生 HTML 的渲染库）等于把渲染通道接到 agent 的权限面上 ——
 * 与提问卡「组件目录是白名单」同一条理由（那个 agent 连着系统 MCP、
 * 读得到工作流、改得动草稿）。
 *
 * 三条底线：
 * - 全部经 React 元素构造，没有任何 innerHTML —— HTML 标签按原文显示
 * - 链接协议过白名单，`javascript:` / `data:` 降级成原文
 * - 认不出的语法按原文显示，不吞掉 —— 用户至少要看到 agent 写了什么
 */

export interface RichTextProps {
  /** markdown 子集原文。 */
  text: string;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

/** 表格的分隔行（`| --- | :-: |`）。有它，上一行才算表头。 */
const TABLE_DIVIDER = /^\|?[\s:|-]+$/;

const HEADING = /^(#{1,4})\s+(.*)$/;
const UNORDERED_ITEM = /^[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\d+\.\s+(.*)$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    // 循环不变式：每一轮 index 必须前进。块判据将来再分岔
    // （围栏那次就是：识别与段落 break 用了两个不等价的正则，
    // 一行畸形围栏让 index 停在原地，无限推空段落直到内存耗尽），
    // 这道兜底保证代价只是渲染难看，不是界面冻死
    const startedAt = index;
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // info string 允许带参数（```js title="a.js"）—— 只取第一个词当语言。
    // 这个判据必须比段落 break 的 startsWith('```') 更宽：
    // 任何以 ``` 开头的行都要进这个分支，两处不等价就是死循环
    const fence = /^```(\S*)(?:\s.*)?$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      // 没闭合就收到文末 —— 吞掉的话 agent 写的代码整段消失
      index += 1;
      blocks.push({ kind: 'code', lang: fence[1] ?? '', body: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    if (
      line.startsWith('|') &&
      TABLE_DIVIDER.test(lines[index + 1] ?? '') &&
      (lines[index + 1] ?? '').includes('-')
    ) {
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const item = (isOrdered ? ORDERED_ITEM : UNORDERED_ITEM).exec(lines[index] ?? '');
        if (!item) break;
        items.push(item[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    if (line.startsWith('>')) {
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        HEADING.test(current) ||
        UNORDERED_ITEM.test(current) ||
        ORDERED_ITEM.test(current) ||
        current.startsWith('>') ||
        current.startsWith('```') ||
        // 段落后面紧跟的表格要能断开 —— 「结果如下：」+ 表格
        // 是最常见的写法，漏了它整块变成一坨竖线纯文本
        (current.startsWith('|') &&
          TABLE_DIVIDER.test(lines[index + 1] ?? '') &&
          (lines[index + 1] ?? '').includes('-'))
      ) {
        break;
      }
      body.push(current);
      index += 1;
    }
    if (body.length > 0) {
      blocks.push({ kind: 'paragraph', text: body.join('\n') });
    }

    if (index === startedAt) {
      // 兜底：没有任何分支消费这一行。按段落显示并强制前进
      blocks.push({ kind: 'paragraph', text: line });
      index += 1;
    }
  }

  return blocks;
}

/**
 * 链接只认这些开头。`javascript:` / `data:` 一律按原文显示。
 * 相对路径的 `/` 后面不许再来 `/` 或 `\` —— `//evil.example`
 * 是协议相对 URL，会被浏览器解析成任意外站，不是站内路径。
 */
const SAFE_LINK = /^(https?:\/\/|#|\/(?![/\\])|\.\.?\/)/i;

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g;

function parseInline(text: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, at) => {
    const key = `${at}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      if (href && SAFE_LINK.test(href)) {
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" title="在新窗口打开">
            {label}
          </a>
        );
      }
      // 协议不在白名单里：按原文显示，不吞掉 —— 用户要看到 agent 写了什么
      return <Fragment key={key}>{part}</Fragment>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function renderBlock(block: Block, at: number): ReactNode {
  const key = `${block.kind}-${at}`;
  switch (block.kind) {
    case 'heading':
      // agent 的 `#` 不该在宿主页面里造出 <h1> —— 读屏用户的标题导航
      // 会变成 agent 写的。整体降两级：# → h3，#### 封顶 h6
      return createElement(`h${Math.min(block.level + 2, 6)}`, { key }, parseInline(block.text));
    case 'code':
      return (
        <pre key={key} {...(block.lang === '' ? {} : { 'data-lang': block.lang })}>
          <code>{block.body}</code>
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, n) => <li key={`${key}-${n}`}>{parseInline(item)}</li>);
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case 'quote':
      return (
        <blockquote key={key}>
          <p>{parseInline(block.text)}</p>
        </blockquote>
      );
    case 'table':
      return (
        <div key={key} className="aiwf-richtext__scroll">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, n) => (
                  <th key={`${key}-h${n}`}>{parseInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${key}-r${r}`}>
                  {row.map((cell, c) => (
                    <td key={`${key}-r${r}c${c}`}>{parseInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'paragraph':
      return <p key={key}>{parseInline(block.text)}</p>;
    default:
      return null;
  }
}

/**
 * 超过它就不解析，整段按原文显示。行内正则对病态输入是二次的 ——
 * 这个组件为对话摘要设计（存储层的摘要上限是 2000 字符），
 * 几百 KB 的产物全文该走产物视图，不该拿它渲染。
 */
const MAX_CHARS = 20_000;

export function RichText({ text }: RichTextProps) {
  if (text.length > MAX_CHARS) {
    return (
      <div className="aiwf-richtext">
        <pre>
          <code>{text}</code>
        </pre>
      </div>
    );
  }
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;
  return <div className="aiwf-richtext">{blocks.map(renderBlock)}</div>;
}
