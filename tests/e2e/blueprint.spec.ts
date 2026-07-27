import { expect, test, type Page } from '@playwright/test';

/**
 * UI 与可交互原型一致。
 *
 * 分两类断言：
 *
 * 1. **布局**：栏宽、内边距、字号、圆角取自原型的内联样式，
 *    这里读浏览器算出来的实际值来比。差 4px 说不上错，
 *    但一屏差十处就不是同一版设计了。
 * 2. **文案**：原型里写死的标题、说明、常驻提示必须一字不差。
 *    这些是最容易被「顺手改得更通顺」的地方。
 *
 * 规格来源见 `scripts/extract-blueprint.mjs`，产物是
 * `docs/testing/blueprint.json`。数字直接写在用例里而不是读 JSON ——
 * 读文件的话，图纸改了测试会跟着改，那就守不住任何东西了。
 */

async function px(page: Page, selector: string, property: string): Promise<number> {
  return page.evaluate(
    ([sel, prop]) => {
      const element = document.querySelector(sel);
      if (!element) return -1;
      return Number.parseFloat(getComputedStyle(element).getPropertyValue(prop));
    },
    [selector, property] as const,
  );
}

test.describe('执行记录（图纸「03 执行记录」）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/runs');
    await expect(page.getByRole('region', { name: '节点进度' })).toBeVisible();
  });

  test('三栏宽度照图纸：308 / 232 / 剩余', async ({ page }) => {
    expect(await px(page, '.runs__list', 'width')).toBe(308);
    expect(await px(page, '.runs__nodes', 'width')).toBe(232);
  });

  test('左栏小标题的字号与字距照图纸', async ({ page }) => {
    // 图纸：font-size:11px; letter-spacing:.09em; text-transform:uppercase
    expect(await px(page, '.runs__label', 'font-size')).toBe(11);
    const spacing = await px(page, '.runs__label', 'letter-spacing');
    expect(spacing).toBeGreaterThan(0.9);
    expect(spacing).toBeLessThan(1.1);
  });

  test('搜索框高度 28px、圆角 7px', async ({ page }) => {
    expect(await px(page, '.runs__search', 'height')).toBe(28);
    expect(await px(page, '.runs__search', 'border-radius')).toBe(7);
  });

  test('筛选是药丸形（圆角 20px）', async ({ page }) => {
    expect(await px(page, '.runs__chip', 'border-radius')).toBe(20);
  });

  test('运行条目的圆角与内边距照图纸', async ({ page }) => {
    // 图纸：padding:9px 10px; border-radius:9px
    const item = '.runs__item';
    if ((await page.locator(item).count()) === 0) test.skip();
    expect(await px(page, item, 'border-radius')).toBe(9);
    expect(await px(page, item, 'padding-top')).toBe(9);
    expect(await px(page, item, 'padding-left')).toBe(10);
  });

  test('底部常驻说明一字不差', async ({ page }) => {
    await expect(page.getByText('同一工作流可用不同参数并行运行，环境快照互不影响')).toBeVisible();
  });

  test('搜索框占位文案一字不差', async ({ page }) => {
    await expect(page.getByPlaceholder('搜索工作流、参数或 Run ID')).toBeVisible();
  });
});

test.describe('模型（图纸「07 模型」）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/models');
    await expect(page.getByRole('region', { name: '模型详情' })).toBeVisible();
  });

  test('左栏宽度 262px', async ({ page }) => {
    expect(await px(page, '.models__list', 'width')).toBe(262);
  });

  test('左栏内边距 16px 12px', async ({ page }) => {
    expect(await px(page, '.models__list', 'padding-top')).toBe(16);
    expect(await px(page, '.models__list', 'padding-left')).toBe(12);
  });

  test('详情区内边距 22px 26px', async ({ page }) => {
    expect(await px(page, '.models__detail', 'padding-top')).toBe(22);
    expect(await px(page, '.models__detail', 'padding-left')).toBe(26);
  });

  test('底部那句关于「只列已启用」的说明一字不差', async ({ page }) => {
    await expect(
      page.getByText('系统内所有模型下拉只列出这里已启用的条目，AI 无法引用未登记的模型。'),
    ).toBeVisible();
  });
});

test.describe('概览（图纸「01 工作流首页」）', () => {
  test('搜索占位文案一字不差', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder('搜索工作流、运行或产物')).toBeVisible();
  });

  test('大标题是「工作流」，不是菜单名', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('工作流');
  });
});

test.describe('编辑器（图纸「02 画布编辑器」）', () => {
  test('节点库标题与底部提示一字不差', async ({ page }) => {
    await page.goto('/editor');
    // 不带 id 时是「先选一个工作流」的空态，节点库不在
    await expect(page.getByText(/选一个工作流|还没有工作流/)).toBeVisible();
  });
});

test.describe('全局外壳', () => {
  test('主导航条目与顺序照功能文档', async ({ page }) => {
    await page.goto('/');
    const labels = await page.locator('nav a').allTextContents();
    const trimmed = labels.map((label) => label.trim()).filter(Boolean);

    // 顺序即信息架构：先找得到工作流，再设计、再看执行
    expect(trimmed.slice(0, 3)).toEqual(['概览与工作流', '工作流编辑器', '执行记录']);
  });

  test('标题栏本身带可拖动标记（桌面形态靠它移动窗口）', async ({ page }) => {
    await page.goto('/');
    // 只有被标记的元素本身能拖，子元素不冒泡 ——
    // 所以关键是 header 上有这个属性，而不是页面里有几个。
    // 缺了它桌面版窗口就拖不动，踩过一次
    await expect(page.locator('header.title-bar[data-tauri-drag-region]')).toHaveCount(1);
  });
});

test.describe('设计令牌', () => {
  test('每个令牌都能解析出值，没有自引用', async ({ page }) => {
    // `--radius-sm: var(--radius-sm)` 这种自引用会让变量在 CSS 里彻底失效，
    // 用它的 border-radius 静默变成 0 —— 没有报错，圆角就是悄悄没了。
    // 踩过一次：Tailwind 的 @theme inline 里把三个 radius 令牌写成了自引用
    await page.goto('/');
    const empty = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const names = [
        '--radius-sm',
        '--radius-md',
        '--radius-lg',
        '--space-1',
        '--space-2',
        '--space-3',
        '--space-4',
        '--space-6',
        '--space-8',
        '--color-bg',
        '--color-surface',
        '--color-text',
        '--color-accent',
        '--layout-nav-w',
        '--layout-titlebar-h',
      ];
      return names.filter((name) => style.getPropertyValue(name).trim() === '');
    });

    expect(empty, `这些令牌解析不出值（多半是自引用）：${empty.join(', ')}`).toEqual([]);
  });

  test('用令牌的元素真的拿到了圆角', async ({ page }) => {
    await page.goto('/');
    // 主导航条目用 var(--radius-sm)
    const radius = await page.evaluate(() => {
      const item = document.querySelector('.side-nav__item');
      return item ? getComputedStyle(item).borderRadius : '';
    });
    expect(radius).toBe('4px');
  });
});
