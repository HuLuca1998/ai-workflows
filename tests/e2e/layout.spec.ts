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

test.describe('左栏内容不溢出', () => {
  for (const { path, list } of SPLIT_PAGES) {
    test(`${path} 的左栏被约束在自己的高度里`, async ({ page }) => {
      await page.setViewportSize(SHORT);
      await page.goto(path);
      await page.waitForTimeout(500);

      const pane = (await page.locator('.split__left').boundingBox())!;
      const inner = await page.locator('.split__left > *').first().boundingBox();

      // 内容比容器高就是溢出 —— 截图里的症状是列表一直流到窗口外，
      // 而左栏底部那句常驻说明被挤没了
      expect(inner!.height, '左栏内容溢出容器').toBeLessThanOrEqual(pane.height + 1);

      // 底部的常驻说明要还在
      const foot = page.locator('.models__foot, .prompts__foot').first();
      if ((await foot.count()) > 0) {
        const footBox = (await foot.boundingBox())!;
        expect(footBox.y + footBox.height, '底部说明被挤出可视区').toBeLessThanOrEqual(
          pane.y + pane.height + 1,
        );
      }

      // 列表体自己滚，而不是把整栏撑开
      const body = (await page.locator(list).boundingBox())!;
      expect(body.height, '列表体高度塌了').toBeGreaterThan(60);
    });

    test(`${path} 的左栏内容跟着拖动变宽`, async ({ page }) => {
      await page.goto(path);
      await page.waitForTimeout(400);

      const handle = page.locator('.split__handle');
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 140, box.y + 200, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);

      const pane = (await page.locator('.split__left').boundingBox())!;
      const inner = (await page.locator('.split__left > *').first().boundingBox())!;
      // 内层自带固定 width 的话，拖宽了内容也不跟着走 —— 右边留一条空白
      expect(Math.abs(inner.width - pane.width), '左栏内容没跟着拖动变宽').toBeLessThan(2);
    });
  }
});

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

/**
 * 每一屏都要填满可视区。
 *
 * 逐个页面补 `flex:1` 的做法必然漏 —— 编辑器就是这么漏掉的：
 * 画布下方一大片空白，而那一屏我根本没想到。
 * 这条用例遍历导航里的每一项，新增的屏自动被覆盖。
 */
test.describe('每一屏都填满', () => {
  const SCREENS = [
    ['/', '概览与工作流'],
    ['/editor', '工作流编辑器'],
    ['/runs', '执行记录'],
    ['/memory', '记忆'],
    ['/agents', 'Agent 角色'],
    ['/prompts', '提示词库'],
    ['/models', '模型'],
    ['/settings', '设置与环境'],
    ['/onboarding', '首次配置'],
  ] as const;

  for (const [path, label] of SCREENS) {
    test(`${label}（${path}）没有空白余量`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 700 });
      await page.goto(path);
      await page.waitForTimeout(600);

      const gap = await page.evaluate(() => {
        const main = document.querySelector('main');
        const root = main?.firstElementChild as HTMLElement | null;
        if (!main || !root) return -1;
        return main.clientHeight - root.getBoundingClientRect().height;
      });

      expect(gap, '页面根没填满 main，下方会留一片空白').toBeGreaterThanOrEqual(0);
      expect(gap, '页面根塌了 —— 下方那片空白就是它').toBeLessThan(4);
    });
  }
});

/**
 * 全屏布局体检。
 *
 * 三种尺寸 × 每一屏，扫四类问题：横向溢出、页面根没填满、
 * 内容溢出却不可滚（那部分永远看不到）、文字被裁切却没有省略号。
 *
 * 固化成测试而不是一次性检查 —— 布局是最容易在别处改动时被碰坏的东西，
 * 而症状（一片空白、滚不到底）往往要等用户截图才发现。
 */
test.describe('全屏布局体检', () => {
  const ALL_SCREENS = [
    ['/', '概览'],
    ['/editor', '编辑器'],
    ['/runs', '执行记录'],
    ['/memory', '记忆'],
    ['/agents', 'Agent'],
    ['/prompts', '提示词'],
    ['/models', '模型'],
    ['/settings', '设置'],
    ['/onboarding', '首次配置'],
  ] as const;

  const SIZES = [
    { width: 1440, height: 900, name: '常规' },
    { width: 1280, height: 620, name: '矮' },
    { width: 1024, height: 768, name: '窄' },
    // 高视口：编辑器那片空白只在这个尺寸下暴露 ——
    // grid 的 `50px auto 1fr` 里那行 1fr 空着，视口越高空得越多。
    // 只测到 900px 的话永远看不见
    { width: 1090, height: 1040, name: '高' },
  ] as const;

  for (const size of SIZES) {
    test(`${size.name} ${size.width}×${size.height} 下每一屏都没有布局问题`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const report: string[] = [];

      for (const [path, label] of ALL_SCREENS) {
        // 编辑器要带工作流 id 才有真实内容
        await page.goto(path);
        await page.waitForTimeout(400);

        const issues = await page.evaluate(() => {
          const found: string[] = [];
          const doc = document.documentElement;

          if (doc.scrollWidth > doc.clientWidth + 1) {
            found.push(`横向溢出 ${doc.scrollWidth - doc.clientWidth}px`);
          }

          const main = document.querySelector('main');
          const root = main?.firstElementChild as HTMLElement | null;
          if (main && root) {
            const gap = main.clientHeight - root.getBoundingClientRect().height;
            if (Math.abs(gap) > 3) found.push(`根与 main 差 ${Math.round(gap)}px`);
          }

          for (const el of document.querySelectorAll<HTMLElement>('main *')) {
            const over = el.scrollHeight - el.clientHeight;
            if (over > 8 && el.clientHeight > 60) {
              const style = getComputedStyle(el);
              if (!/auto|scroll|hidden/.test(style.overflowY)) {
                const name = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
                found.push(`${name} 溢出 ${over}px 且不可滚`);
              }
            }
          }

          return found;
        });

        if (issues.length > 0) report.push(`${label}：${issues.join('、')}`);
      }

      expect(report, report.join('\n')).toEqual([]);
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
      // 设置页外面套着带标题结构的 .page，滚动在那一层 ——
      // 两层都能滚的话用户要猜哪个才是自己想滚的那个
      ['/settings', '.page'],
    ] as const) {
      await page.goto(path);
      await page.waitForTimeout(500);
      const scroller = await metrics(page, root);
      expect(scroller.scrollable, `${path} 的 ${root} 要能滚`).toBe(true);
      expect(scroller.height, `${path} 的 ${root} 高度塌了`).toBeGreaterThan(200);
    }
  });
});

test.describe('每一屏都铺满可视宽度', () => {
  /**
   * 用户截图：1900px 宽的窗口下，工作流列表只占左边 1080px，
   * 右侧一大片空白。
   *
   * 图纸的 10 个屏容器**没有一个有 max-width** —— 那是我自己加的
   *（`.overview` 1180px、`.page` 1100px）。宽屏用户买的宽度不是用来留白的。
   */
  const 屏幕 = [
    { path: '/', 名: '概览' },
    { path: '/runs', 名: '执行记录' },
    { path: '/memory', 名: '记忆' },
    { path: '/agents', 名: 'Agent 角色' },
    { path: '/prompts', 名: '提示词库' },
    { path: '/models', 名: '模型' },
    { path: '/settings', 名: '设置与环境' },
    { path: '/onboarding', 名: '首次配置' },
  ];

  for (const { path, 名 } of 屏幕) {
    test(`${名} 的内容宽度跟着窗口走`, async ({ page }) => {
      await page.setViewportSize({ width: 1900, height: 1000 });
      await page.goto(path);
      // 等内容真的渲染出来，否则量到的是空壳
      await page.waitForTimeout(600);

      const { 内容宽, 可用宽 } = await page.evaluate(() => {
        const main = document.querySelector('.app-shell__content');
        const 屏 = main?.firstElementChild;
        return {
          内容宽: 屏?.getBoundingClientRect().width ?? 0,
          可用宽: main?.getBoundingClientRect().width ?? 0,
        };
      });

      expect(可用宽, '外壳没量到').toBeGreaterThan(1000);
      // 首次配置是图纸里唯一居中的一屏（justify-content:center），
      // 它的内容不铺满，但容器本身要铺满
      expect(内容宽, `右边空了 ${Math.round(可用宽 - 内容宽)}px`).toBeGreaterThanOrEqual(
        可用宽 - 1,
      );
    });
  }
});
