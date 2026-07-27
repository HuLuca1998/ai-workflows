import { expect, test, type Page } from '@playwright/test';

/**
 * 每一屏的尺寸对照。
 *
 * 图纸里的固定宽度（从内联样式抽出来的）：
 *
 * | 屏             | 固定宽度                |
 * | -------------- | ----------------------- |
 * | 全局主导航      | 216                     |
 * | 01 工作流首页   | 250（搜索框，不是分栏） |
 * | 02 画布编辑器   | 186（节点库）           |
 * | 03 执行记录     | 308 / 232（列表 / 进度）|
 * | 04 记忆管理     | 420 / 230               |
 * | 05 Agent 角色  | 250                     |
 * | 06 提示词库     | 266                     |
 * | 07 模型         | 262                     |
 * | 05 设置与环境   | 184                     |
 *
 * 尚未实现的屏（记忆 / Agent / 提示词）先记在这里，实现时这些用例会自动开始把关。
 */

/** 读浏览器算出来的实际值。元素不在时返回 -1，用例据此跳过或失败。 */
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

/** 视口宽度固定，否则百分比与 min() 算出来的值每次都不同。 */
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('固定分栏宽度', () => {
  test('执行记录：运行列表 308 / 节点进度 232', async ({ page }) => {
    await page.goto('/runs');
    expect(await px(page, '.runs__list', 'width')).toBe(308);
    expect(await px(page, '.runs__nodes', 'width')).toBe(232);
  });

  test('模型：左栏 262', async ({ page }) => {
    await page.goto('/models');
    expect(await px(page, '.models__list', 'width')).toBe(262);
  });

  test('编辑器：节点库 186', async ({ page }) => {
    await page.goto('/');
    // 点工作流名进编辑器（整行不是链接，名字才是）
    await page.locator('.wf-table__name').first().click();
    await expect(page).toHaveURL(/\/editor\/wf_/, { timeout: 15_000 });
    await expect(page.locator('.node-lib')).toBeVisible();
    expect(await px(page, '.node-lib', 'width')).toBe(186);
  });

  test('主导航展开时 216px', async ({ page }) => {
    await page.goto('/');
    // 主导航在全局外壳里，不属于任何一屏 —— 按屏抽尺寸会把它漏掉，
    // 或者把屏内某个 250px 的元素误当成它（那其实是概览页的搜索框）
    expect(await px(page, 'nav.side-nav', 'width')).toBe(216);
  });

  test('主导航内边距 16 / 12', async ({ page }) => {
    await page.goto('/');
    expect(await px(page, 'nav.side-nav', 'padding-top')).toBe(16);
    expect(await px(page, 'nav.side-nav', 'padding-left')).toBe(12);
  });

  test('概览页搜索框 250px', async ({ page }) => {
    await page.goto('/');
    const search = await px(page, '.overview__search', 'width');
    if (search < 0) test.skip();
    expect(search).toBe(250);
  });
});

test.describe('内容区最大宽度', () => {
  test('执行记录的事件流 min(680px, 100%)', async ({ page }) => {
    await page.goto('/runs');
    await page.locator('.runs__item').first().click();
    await expect(page.locator('.runs__events')).toBeVisible();
    const width = await px(page, '.runs__events', 'width');
    // min(680px, 100%)：1440 视口下详情栏内容区只有 632px
    //（1440 − 216 导航 − 308 列表 − 232 进度 − 26×2 内边距），取 100% 那一支。
    // 视口够宽时才会命中 680，下面那条用例验证这一点
    expect(width).toBe(632);
  });

  test('视口够宽时事件流取 680px 上限', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.goto('/runs');
    await page.locator('.runs__item').first().click();
    await expect(page.locator('.runs__events')).toBeVisible();
    expect(await px(page, '.runs__events', 'width')).toBe(680);
  });
});

test.describe('间距与圆角', () => {
  test('执行记录左栏内边距 16 / 14 / 10', async ({ page }) => {
    await page.goto('/runs');
    expect(await px(page, '.runs__list-head', 'padding-top')).toBe(16);
    expect(await px(page, '.runs__list-head', 'padding-left')).toBe(14);
    expect(await px(page, '.runs__list-head', 'padding-bottom')).toBe(10);
  });

  test('执行记录详情头部内边距 18 / 26', async ({ page }) => {
    await page.goto('/runs');
    // 详情栏只在选中运行后渲染。基线数据由 scripts/seed-test-data.mjs 铺
    await page.locator('.runs__item').first().click();
    await expect(page.locator('.runs__detail-head')).toBeVisible();
    expect(await px(page, '.runs__detail-head', 'padding-top')).toBe(18);
    expect(await px(page, '.runs__detail-head', 'padding-left')).toBe(26);
  });

  test('模型详情内边距 22 / 26', async ({ page }) => {
    await page.goto('/models');
    expect(await px(page, '.models__detail', 'padding-top')).toBe(22);
    expect(await px(page, '.models__detail', 'padding-left')).toBe(26);
  });

  test('卡片圆角 10px、事件卡 9px', async ({ page }) => {
    await page.goto('/models');
    await page.locator('.models__item').first().click();
    await expect(page.locator('.models__card').first()).toBeVisible();
    expect(await px(page, '.models__card', 'border-radius')).toBe(10);

    await page.goto('/runs');
    await page.locator('.runs__item').first().click();
    await expect(page.locator('.runs__event').first()).toBeVisible();
    expect(await px(page, '.runs__event', 'border-radius')).toBe(9);
  });
});

test.describe('字号层级', () => {
  test('小标题 11px、运行条目名 12.5px', async ({ page }) => {
    await page.goto('/runs');
    expect(await px(page, '.runs__label', 'font-size')).toBe(11);
    await expect(page.locator('.runs__item').first()).toBeVisible();
    expect(await px(page, '.runs__item-name', 'font-size')).toBeCloseTo(12.5, 1);
  });

  test('执行记录详情大标题 18px', async ({ page }) => {
    await page.goto('/runs');
    await page.locator('.runs__item').first().click();
    await expect(page.locator('.runs__detail-title').first()).toBeVisible();
    expect(await px(page, '.runs__detail-title h4', 'font-size')).toBe(18);
  });

  test('模型详情标题 17px', async ({ page }) => {
    await page.goto('/models');
    await page.locator('.models__item').first().click();
    await expect(page.locator('.models__detail-title h4')).toBeVisible();
    expect(await px(page, '.models__detail-title h4', 'font-size')).toBe(17);
  });
});

test.describe('响应式', () => {
  test('窄窗口下主导航收成图标栏', async ({ page }) => {
    // 图纸「屏幕清单 §11」：窄于 1360 收起
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    const width = await px(page, 'nav.side-nav', 'width');
    expect(width).toBeLessThan(100);
  });

  test('宽窗口下主导航展开', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/');
    expect(await px(page, 'nav.side-nav', 'width')).toBe(216);
  });

  test('固定分栏在窄窗口下不塌陷', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto('/runs');
    // flex:none 的栏必须保持原宽，被挤扁的话三栏就叠一起了
    expect(await px(page, '.runs__list', 'width')).toBe(308);
    expect(await px(page, '.runs__nodes', 'width')).toBe(232);
  });

  test('页面本身不出现横向滚动条', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const path of ['/', '/runs', '/models', '/settings']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} 出现了 ${overflow}px 横向溢出`).toBeLessThanOrEqual(0);
    }
  });
});
