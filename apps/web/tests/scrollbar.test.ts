import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 滚动条样式 —— 图纸第 21 行就写着：
 *
 *     ::-webkit-scrollbar{width:9px;height:9px}
 *     ::-webkit-scrollbar-thumb{background:var(--color-neutral-800);border-radius:6px}
 *     ::-webkit-scrollbar-track{background:transparent}
 *
 * 实现漏了这一段，于是滚动条是系统默认的浅色 —— 在深色界面上很扎眼。
 * 这是「图纸里有而实现没有」，不是主观审美问题。
 */

// jsdom 里 import.meta.url 不是 file: 协议，用 cwd 拼
const css = readFileSync(join(process.cwd(), 'apps/web/src/styles.css'), 'utf8');

describe('滚动条照图纸', () => {
  it('宽度是 9px', () => {
    expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*9px/u);
  });

  it('滑块用 neutral-800，圆角 6px —— 与深色界面一致', () => {
    const thumb = /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(thumb).toContain('--color-neutral-800');
    expect(thumb).toMatch(/border-radius:\s*6px/u);
  });

  it('轨道透明 —— 图纸上滚动条是浮在内容上的', () => {
    const track = /::-webkit-scrollbar-track\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(track).toMatch(/background:\s*transparent/u);
  });

  it('Firefox 也要覆盖到 —— 它不认 ::-webkit-*', () => {
    expect(css).toMatch(/scrollbar-width:/u);
    expect(css).toMatch(/scrollbar-color:/u);
  });
});
