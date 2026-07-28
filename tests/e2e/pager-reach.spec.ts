import { test, expect, type Page } from '@playwright/test';
import { api } from './_api.js';

/**
 * 分页控件必须够得着。
 *
 * 第 5 轮审查抓到：概览页一页 50 行，分页跟着表格走到 2665px 以下，
 * 用户要滚 26 下滚轮才知道自己在第几页、能不能往下翻。
 * 修法是给它加 `position: sticky`。
 *
 * **第 1 轮复验又抓到同一件事**：这一轮新加分页的记忆页复刻了那个坑，
 * 而且更深（2759px）。原因是那条 CSS 写成 `.overview .pager` ——
 * 它列举了当时知道的那一个屏，而不是表达「整页滚动的屏都要吸底」这条规则。
 *
 * 所以这条守卫不检查 CSS 怎么写，只检查**用户能不能看见**：
 * 凡是出现了分页控件的屏，它都必须在首屏之内。
 * 下一个加分页的屏如果又忘了，这里会红。
 */

const 基准视口 = { width: 1440, height: 900 };

/** 有分页的屏。加新屏时把它加进来 —— 漏加的话这条守卫就白写了。 */
const 有分页的屏 = [
  { path: '/', name: '概览与工作流' },
  { path: '/memory', name: '记忆管理' },
  { path: '/runs', name: '执行记录' },
  { path: '/agents', name: 'Agent 角色' },
  { path: '/prompts', name: '提示词库' },
  { path: '/models', name: '模型' },
];

async function 分页可达性(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.pager');
    if (!el) return null; // 数据不足一页时分页不出现，那是对的
    const r = el.getBoundingClientRect();
    return {
      首屏可见: r.top < window.innerHeight && r.bottom > 0,
      需要滚动: Math.max(0, Math.round(r.top - window.innerHeight + r.height)),
    };
  });
}

for (const 屏 of 有分页的屏) {
  test(`${屏.name}：分页控件在首屏之内，不用滚到底去找`, async ({ page }) => {
    await page.setViewportSize(基准视口);
    await page.goto(屏.path);
    // 列表是异步拉的，等它把行铺出来
    await page.waitForTimeout(2500);

    const 结果 = await 分页可达性(page);
    if (结果 === null) {
      test.skip(true, `${屏.name} 当前数据不足一页，分页控件不出现`);
      return;
    }

    expect(
      结果.首屏可见,
      `${屏.name} 的分页要滚 ${结果.需要滚动}px 才看得见。` +
        `整页滚动的屏必须让分页吸底 —— 见 styles.css 的 .pager--sticky`,
    ).toBe(true);
  });
}

/**
 * 记忆页单独造数据再测。
 *
 * 它是整页滚动的屏里数据最容易不足一页的那个（空库时一条都没有），
 * 而**恰恰是它复刻了概览页的坑**。靠「库里碰巧有 60 条」来触发守卫，
 * 等于把守卫的生效条件交给运气。
 */
test('记忆页：造够 60 条之后，分页仍在首屏之内', async ({ page }) => {
  const 造的: string[] = [];
  for (let i = 1; i <= 60; i += 1) {
    const id = (await api(page, 'memory_create', {
      scope: 'global',
      key: `分页守卫 ${String(i).padStart(2, '0')}`,
      value: '这条是 pager-reach 守卫造的，跑完就删',
      createdBy: 'pager-reach-spec',
    })) as string;
    if (typeof id === 'string') 造的.push(id);
  }

  try {
    await page.setViewportSize(基准视口);
    await page.goto('/memory');
    await page.waitForTimeout(2500);

    const 结果 = await 分页可达性(page);
    expect(结果, '造了 60 条记忆，分页控件却没出现').not.toBeNull();
    expect(
      结果?.首屏可见,
      `记忆页的分页要滚 ${结果?.需要滚动}px 才看得见 —— ` +
        `这正是概览页修过的那个坑（第 5 轮缺陷 5 / 第 1 轮复验 F2）`,
    ).toBe(true);
  } finally {
    for (const id of 造的) await api(page, 'memory_delete', { id });
  }
});
