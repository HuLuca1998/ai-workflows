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
