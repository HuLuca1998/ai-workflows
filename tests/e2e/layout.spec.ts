import { test, expect, type Page } from '@playwright/test';

/**
 * 分栏页面的滚动边界。
 *
 * 图纸里每一屏都是 `flex:1;min-height:0;display:flex`，左栏的列表区
 * 与右侧详情各自 `overflow:auto` —— 也就是**各滚各的**。
 *
 * 实现里 `main` 不是 flex 容器，于是页面根的 `flex:1` 不生效：
 * 内容少时高度塌成一小块（下方大片空白），内容多时把 main 整个撑开
 * ——两栏一起滚，左栏的列表跟着右栏的长文一起跑掉。
 */

/** 矮视口：高度链有没有断，在这个尺寸下立刻看得出来。 */
const SHORT = { width: 1280, height: 560 };

async function metrics(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      height: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: style.overflowY,
      scrollable: /auto|scroll/.test(style.overflowY),
    };
  });
}

const SPLIT_PAGES = [
  { path: '/agents', root: '.agents', list: '.agents__list-body', detail: '.agents__detail' },
  { path: '/prompts', root: '.prompts', list: '.prompts__list-body', detail: '.prompts__detail' },
  { path: '/models', root: '.models', list: '.models__list-body', detail: '.models__detail' },
] as const;

test.describe('分栏可以拖动', () => {
  for (const { path } of SPLIT_PAGES) {
    test(`${path} 拖动分隔条改变栏宽，刷新后还记得`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(400);

      const left = page.locator('.split__left');
      const before = (await left.boundingBox())!.width;

      const handle = page.locator('.split__handle');
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 200, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(200);

      const after = (await left.boundingBox())!.width;
      expect(Math.abs(after - before), '宽度没变').toBeGreaterThan(60);

      // 调好一次不该每次重来
      await page.reload();
      await page.waitForTimeout(500);
      const restored = (await page.locator('.split__left').boundingBox())!.width;
      expect(Math.abs(restored - after), '刷新后没记住').toBeLessThan(4);
    });
  }
});

test.describe('分栏页面各滚各的', () => {
  for (const { path, root, list, detail } of SPLIT_PAGES) {
    test(`${path} 的页面根填满可视区，不塌也不撑`, async ({ page }) => {
      await page.setViewportSize(SHORT);
      await page.goto(path);
      await page.waitForTimeout(400);

      const main = await metrics(page, 'main');
      const pageRoot = await metrics(page, root);

      // 塌下去就是截图里那片空白；撑出去就是两栏一起滚
      expect(pageRoot.height, `${root} 没填满 main`).toBe(main.height);
      expect(main.scrollHeight, 'main 被撑开了 —— 那会让两栏一起滚').toBe(main.height);
    });

    test(`${path} 的左栏列表自己滚`, async ({ page }) => {
      await page.setViewportSize(SHORT);
      await page.goto(path);
      await page.waitForTimeout(400);

      const listBox = await metrics(page, list);
      expect(listBox.scrollable, `${list} 要能自己滚`).toBe(true);
      expect(listBox.height, `${list} 高度塌了`).toBeGreaterThan(80);
    });

    test(`${path} 的详情区自己滚`, async ({ page }) => {
      await page.setViewportSize(SHORT);
      await page.goto(path);
      await page.waitForTimeout(400);

      const detailBox = await metrics(page, detail);
      expect(detailBox.scrollable, `${detail} 要能自己滚`).toBe(true);
      expect(detailBox.height, `${detail} 高度塌了`).toBeGreaterThan(80);
    });
  }

  test('/runs 三栏各自滚', async ({ page }) => {
    await page.setViewportSize(SHORT);
    await page.goto('/runs');
    await page.waitForTimeout(500);
    // 详情区只有选中一条运行才渲染
    const first = page.locator('.runs__item').first();
    if ((await first.count()) > 0) {
      await first.click();
      await page.waitForTimeout(600);
    }

    // 详情那一栏本身是 flex column（头部固定、内容滚），
    // 真正该滚的是里面的内容区
    for (const selector of ['.runs__list-body', '.runs__nodes-body', '.runs__detail-body']) {
      const box = await metrics(page, selector);
      expect(box.scrollable, `${selector} 要能自己滚`).toBe(true);
      expect(box.height, `${selector} 高度塌了`).toBeGreaterThan(60);
    }
  });

  test('整页滚动的屏仍然能滚 —— 概览与设置本来就是长页面', async ({ page }) => {
    await page.setViewportSize(SHORT);
    // main 自己不滚了（它是 flex 容器），滚的是页面根那一层
    for (const [path, root] of [
      ['/', '.overview'],
      ['/settings', '.settings'],
    ] as const) {
      await page.goto(path);
      await page.waitForTimeout(500);
      const scroller = await metrics(page, root);
      expect(scroller.scrollable, `${path} 的 ${root} 要能滚`).toBe(true);
      expect(scroller.height, `${path} 的 ${root} 高度塌了`).toBeGreaterThan(200);
    }
  });
});
