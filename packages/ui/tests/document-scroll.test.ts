// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * document 一层不许滚 —— 这是修过的坑，不是洁癖。
 *
 * 症状：桌面形态里滚到任何一屏的底部再继续滚，macOS WKWebView 的橡皮筋
 * 会把整个 document 往上拖。后果有两个，都很严重：
 * 标题栏是唯一带 `data-tauri-drag-region` 的元素，被拖出视口后窗口就拖不动了；
 * 同时底部露出一条与背景同色的空白，看着像界面塌了。
 *
 * 外壳已经是 `height:100vh;overflow:hidden`，但那只管住了 `.app-shell` 自己 ——
 * 橡皮筋发生在 document 上，得在 html/body 上关。
 * `overflow:hidden` 挡住普通溢出，`overscroll-behavior:none` 挡住橡皮筋，
 * 两条缺一不可：WebKit 在 `overflow:hidden` 时照样回弹。
 */

const base = readFileSync(
  fileURLToPath(new URL('../src/styles/base.css', import.meta.url)),
  'utf8',
);

/** 取出选择器命中 html 与 body 的那些规则块的声明文本。 */
function 声明(选择器: RegExp): string {
  const 规则 = new RegExp(`${选择器.source}[^{]*\\{([^}]*)\\}`, 'gu');
  let 合并 = '';
  for (const 命中 of base.matchAll(规则)) 合并 += 命中[1] ?? '';
  return 合并;
}

describe('document 不滚动', () => {
  it('html 与 body 都关掉溢出滚动', () => {
    const 文本 = 声明(/(?:^|\n)html,\s*\n?body/u);
    expect(文本).toMatch(/overflow:\s*hidden/u);
  });

  it('html 与 body 都关掉橡皮筋 —— overflow:hidden 拦不住 WebKit 的回弹', () => {
    const 文本 = 声明(/(?:^|\n)html,\s*\n?body/u);
    expect(文本).toMatch(/overscroll-behavior:\s*none/u);
  });
});
