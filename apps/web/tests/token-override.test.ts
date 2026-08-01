import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tailwind 的默认调色板不能盖掉设计令牌。
 *
 * `@import 'tailwindcss'` 排在 `@import '@aiwf/ui/styles.css'` **后面**，
 * 而 Tailwind v4 在 `:root` 上定义了同名的 `--color-neutral-*`
 * （灰度 oklch）—— 后来者胜，于是整套中性色被悄悄换成了纯灰：
 * 浏览器里量出来 `--color-neutral-600` 是 `oklch(43.9% 0 none)`，
 * 而 tokens.css 写的是 `#939aad`。
 *
 * 后果不是「颜色略有不同」：11px 的说明文字对比度掉到 1.94:1
 * （第三方巡检 A-01 从截图 PNG 解码算出来的），包括
 * 「手输的路径拿不到 macOS 授权」这类关键提示。
 * 团队在文案上投入很大，而那几行基本看不清。
 *
 * 这条守卫查的是**导入顺序**：设计令牌必须排在 Tailwind 之后，
 * 否则它定义的每一个同名变量都会被覆盖。
 */

const CSS = await readFile(join(process.cwd(), 'apps/web/src/styles.css'), 'utf-8');

/** 各 @import 在文件里的行号。 */
function importOrder(css: string): { spec: string; index: number }[] {
  const out: { spec: string; index: number }[] = [];
  const re = /@import\s+['"]([^'"]+)['"]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ spec: m[1]!, index: m.index });
  return out;
}

describe('设计令牌不能被 Tailwind 的默认调色板盖掉', () => {
  it('@aiwf/ui 的令牌排在 tailwindcss 之后', () => {
    const imports = importOrder(CSS);
    const ui = imports.find((entry) => entry.spec.includes('@aiwf/ui'));
    const tw = imports.find((entry) => entry.spec === 'tailwindcss');

    expect(ui, '找不到 @aiwf/ui 的样式导入').toBeTruthy();
    expect(tw, '找不到 tailwindcss 导入').toBeTruthy();
    expect(
      ui!.index,
      'Tailwind v4 在 :root 上定义了同名的 --color-neutral-*（灰度 oklch）。' +
        '它排在后面就会覆盖设计令牌，11px 说明文字的对比度掉到 1.94:1',
    ).toBeGreaterThan(tw!.index);
  });

  it('这条守卫自己会红', () => {
    const 假的 = `@import '@aiwf/ui/styles.css';\n@import 'tailwindcss';\n`;
    const imports = importOrder(假的);
    const ui = imports.find((entry) => entry.spec.includes('@aiwf/ui'))!;
    const tw = imports.find((entry) => entry.spec === 'tailwindcss')!;
    expect(ui.index).toBeLessThan(tw.index);
  });
});
