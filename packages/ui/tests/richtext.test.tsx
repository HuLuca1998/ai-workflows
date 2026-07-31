import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from '../src/index.js';

/**
 * AI 输出的展示组件 —— **受限 markdown 子集，不是渲染通道**。
 *
 * agent 的输出直接进这里。给它完整 HTML（dangerouslySetInnerHTML、
 * rehype-raw 之类）等于把渲染通道接到 agent 的权限面上 ——
 * 与提问卡「组件目录是白名单」同一条理由。所以：
 * 全部经 React 元素构造，HTML 标签按原文显示，链接协议要过白名单。
 */

describe('块级语法', () => {
  it('标题、列表、引用各渲染成对应元素', () => {
    render(
      <RichText text={['## 结论', '- 第一条', '- 第二条', '> 引用的话', '普通段落'].join('\n')} />,
    );
    // 标题整体降两级（## → h4）：agent 的 # 不该在宿主页面里
    // 造出 <h1>，读屏用户的标题导航会变成 agent 写的
    expect(screen.getByRole('heading', { level: 4, name: '结论' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('引用的话').closest('blockquote')).not.toBeNull();
    expect(screen.getByText('普通段落').tagName).toBe('P');
  });

  it('有序列表保留编号语义', () => {
    render(<RichText text={'1. 先跑测试\n2. 再改实现'} />);
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('代码块整段原样显示，内部的 markdown 不被解析', () => {
    const { container } = render(<RichText text={'```rust\nlet **x** = 1;\n# 不是标题\n```'} />);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('let **x** = 1;');
    expect(pre?.textContent).toContain('# 不是标题');
    // 语言标签要显示出来 —— 读代码的人第一眼要知道这是什么语言
    expect(pre?.getAttribute('data-lang')).toBe('rust');
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('没有闭合的代码块也要把内容显示出来，不能吞掉', () => {
    const { container } = render(<RichText text={'```\n只有开头没有结尾'} />);
    expect(container.textContent).toContain('只有开头没有结尾');
  });

  it('表格渲染成真表格', () => {
    render(<RichText text={['| 名字 | 状态 |', '| --- | --- |', '| 构建 | 通过 |'].join('\n')} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '名字' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '通过' })).toBeInTheDocument();
  });

  it('竖线开头但没有分隔行的不是表格，按段落显示', () => {
    render(<RichText text={'| 这只是一行带竖线的话 |'} />);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('段落后面紧跟的表格还是表格', () => {
    // 「结果如下：」+ 表格是最常见的写法。段落的 break 条件漏了
    // 表格探测时，整块被吞成一坨竖线纯文本
    render(
      <RichText
        text={['结果如下：', '| 名字 | 状态 |', '| --- | --- |', '| 构建 | 通过 |'].join('\n')}
      />,
    );
    expect(screen.getByText('结果如下：').tagName).toBe('P');
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('畸形围栏不死循环 —— 带参数的 info string 照样是代码块', { timeout: 2000 }, () => {
    // 曾经的死循环：围栏识别与段落 break 用了两个不等价的判据，
    // 这几种行让 index 停在原地，无限推空段落直到内存耗尽。
    // 输入完全由 agent 控制 —— 这是界面冻死级别的坑
    for (const fence of [
      '```js title="a.js"',
      '```js {1,3}',
      '``` js',
      '```ts twoslash',
      '``` 是围栏',
    ]) {
      const { container, unmount } = render(<RichText text={`${fence}\nconst a = 1\n\`\`\``} />);
      expect(container.querySelector('pre')?.textContent, fence).toContain('const a = 1');
      unmount();
    }
  });
});

describe('行内语法', () => {
  it('行内代码、加粗、斜体', () => {
    render(<RichText text={'用 `pnpm verify` 跑**全部**门禁，*别*跳过'} />);
    expect(screen.getByText('pnpm verify').tagName).toBe('CODE');
    expect(screen.getByText('全部').tagName).toBe('STRONG');
    expect(screen.getByText('别').tagName).toBe('EM');
  });

  it('http 链接可点，且不继承页面导航（新开一页）', () => {
    render(<RichText text={'详见 [文档](https://example.com/doc)'} />);
    const link = screen.getByRole('link', { name: '文档' });
    expect(link).toHaveAttribute('href', 'https://example.com/doc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('这是展示组件，不是渲染通道', () => {
  it('HTML 标签按原文显示，不进 DOM', () => {
    const { container } = render(
      <RichText text={'<script>alert(1)</script><img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('javascript: 协议的链接不渲染成链接', () => {
    render(<RichText text={'[点我](javascript:alert(1))'} />);
    expect(screen.queryByRole('link')).toBeNull();
    // 原文还在 —— 吞掉的话用户不知道 agent 写了什么
    expect(screen.getByText(/点我/u)).toBeInTheDocument();
  });

  it('data: 协议同样拒绝，原文还在', () => {
    render(<RichText text={'[x](data:text/html,<script>alert(1)</script>)'} />);
    expect(screen.queryByRole('link')).toBeNull();
    // 原文按文本显示 —— 只断言「没有链接」的话，解析器压根没认出
    // 链接语法时同样绿，判据与白名单就没有因果关系了
    expect(screen.getByText(/data:text\/html/u)).toBeInTheDocument();
  });

  it('协议相对 URL（//host）不是站内路径，拒绝', () => {
    // `[重新登录](//evil.example/login)` 渲染成可信界面里的正常链接，
    // 点开是任意外站 —— 钓鱼的标准形态
    render(<RichText text={'[重新登录](//evil.example/login)'} />);
    expect(screen.queryByRole('link')).toBeNull();
    render(<RichText text={'[x](/\\evil.example)'} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('大写协议照样放行 —— 证明走的是白名单而不是「没解析出来」', () => {
    render(<RichText text={'[文档](HTTPS://example.com/doc)'} />);
    expect(screen.getByRole('link', { name: '文档' })).toBeInTheDocument();
  });

  it('站内相对路径仍然放行', () => {
    render(<RichText text={'[设置](/settings) [上级](../doc) [锚点](#top)'} />);
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
});

describe('边界', () => {
  it('空文本渲染成空，不留一个空段落占位', () => {
    const { container } = render(<RichText text={''} />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('超长输入不解析，整段按原文显示', { timeout: 2000 }, () => {
    // 行内正则对病态输入是二次的。这个组件为 ≤2000 字的摘要设计，
    // 超长（比如有人拿它渲染产物全文）要降级成 <pre>，不能卡死主线程
    const hostile = '['.repeat(30_000);
    const { container } = render(<RichText text={hostile} />);
    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('[[[');
  });

  it('纯文本原样成段，换行分段', () => {
    render(<RichText text={'第一段\n\n第二段'} />);
    expect(screen.getByText('第一段').tagName).toBe('P');
    expect(screen.getByText('第二段').tagName).toBe('P');
  });
});
