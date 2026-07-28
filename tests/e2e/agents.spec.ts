import { expect, test } from '@playwright/test';

/**
 * Agent 角色 —— 图纸「05 Agent 角色」。
 *
 * 这条守的是一次**静默数据丢失**：codex 自主体验时新建角色填了
 * 「性格与指令」，之后只改「目标」点保存，那段指令被清空了 ——
 * 而它只有刷新之后才发现，那时原文已经没了。
 *
 * 根因在契约层：`AgentProfileSchema.partial()` 让字段可选，
 * 但**不去掉 `.default()`** —— 界面只发 {id, ver, goal}，
 * 校验之后变成 {…, persona: '', tools: [], outputContract: ''…}，
 * 后端 COALESCE 收到空字符串而不是 NULL，照写。
 */

test('只改目标保存，性格与指令不被清空', async ({ page }) => {
  const 名字 = `persona fix ${Date.now()}`;
  const 指令 = '简洁、谨慎；不替用户执行发布或运行。';

  await page.goto('/agents');
  await page.getByRole('button', { name: '新建角色' }).click();
  const form = page.locator('form').filter({ hasText: '新建角色' });
  const fields = form.locator('input[type="text"], input:not([type]), textarea');
  await fields.nth(0).fill(名字);
  await fields.nth(1).fill('检查员');
  await fields.nth(2).fill('原目标');
  await fields.nth(3).fill(指令);
  await form.getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(1500);

  await page.reload();
  await page.waitForTimeout(2000);
  await page.getByText(名字, { exact: false }).first().click();
  await page.waitForTimeout(800);

  const detail = page.getByRole('region', { name: '角色详情' });
  await detail.locator('textarea').first().fill('新目标');
  await detail.getByRole('button', { name: '保存新版本' }).click();
  await page.waitForTimeout(1500);

  await page.reload();
  await page.waitForTimeout(2000);
  await page.getByText(名字, { exact: false }).first().click();
  await page.waitForTimeout(800);

  await expect(detail.locator('textarea').first()).toHaveValue('新目标');
  await expect(detail.locator('textarea').nth(1), '只改目标却把性格与指令清空了').toHaveValue(指令);
});

test.describe('权限、工具、输出契约与搜索（codex 第三轮报的三条）', () => {
  test('权限能改并保存 —— 「引擎强制」那句话得有下文', async ({ page }) => {
    const 名字 = `caps e2e ${Date.now()}`;
    await page.goto('/agents');
    await page.getByRole('button', { name: '新建角色' }).click();
    const form = page.locator('form').filter({ hasText: '新建角色' });
    const fields = form.locator('input[type="text"], input:not([type]), textarea');
    await fields.nth(0).fill(名字);
    await fields.nth(1).fill('检查员');
    await fields.nth(2).fill('目标');
    await form.getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(1500);

    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByPlaceholder(/搜索角色/).fill(名字);
    await page.waitForTimeout(1200);
    await page.getByText(名字, { exact: false }).first().click();
    await page.waitForTimeout(600);

    const 权限 = page.getByRole('group', { name: /权限/ });
    await 权限.getByLabel('命令').selectOption('declared');
    await page.getByRole('button', { name: '保存新版本' }).click();

    await page.waitForTimeout(1500);

    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByPlaceholder(/搜索角色/).fill(名字);
    await page.waitForTimeout(1200);
    await page.getByText(名字, { exact: false }).first().click();
    await page.waitForTimeout(600);

    await expect(权限.getByLabel('命令'), '权限改了没存住').toHaveValue('declared');
  });

  test('搜索在后端做 —— 总数跟着筛，不是只过滤当前页', async ({ page }) => {
    // 直接看后端返回的 total：分页控件在只剩几条时会隐藏，
    // 拿它做断言会等到超时，而那与「搜索有没有生效」无关
    const 总数 = async (query?: string) =>
      page.evaluate(async (q) => {
        const response = await fetch('http://127.0.0.1:5177/ipc/agent_list', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(q ? { query: q } : {}), limit: 1 }),
        });
        return ((await response.json()) as { total: number }).total;
      }, query);

    await page.goto('/agents');
    await page.waitForTimeout(1200);

    const 全部 = await 总数();
    expect(全部, '库里角色太少，测不出筛选效果').toBeGreaterThan(1);

    // 界面上搜一个必然存在的词
    const 第一个 = await page.locator('.agents__list-body button').first().textContent();
    const 关键词 = (第一个 ?? '').trim().slice(0, 6);
    await page.getByPlaceholder(/搜索角色/).fill(关键词);
    await page.waitForTimeout(1200);

    const 筛后 = await 总数(关键词);
    expect(筛后, '总数没跟着筛 —— 那说明是前端在过滤当前页').toBeLessThan(全部);
    expect(筛后).toBeGreaterThan(0);

    // 界面上的条数也跟着变
    const 显示 = await page.locator('.agents__list-body button').count();
    expect(显示).toBeLessThanOrEqual(筛后);
  });
});
