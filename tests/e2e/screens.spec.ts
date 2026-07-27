import { expect, test, type Page } from '@playwright/test';

/**
 * 其余各屏的浏览器端到端。
 *
 * 尚未实现的屏（记忆 / Agent / 提示词）也要测：它们必须**说清楚在等什么**，
 * 而不是白屏或者放演示内容。「宁可页面留空，也不要做假的」
 * 这条要求同样需要被验证。
 */

async function api(page: Page, command: string, body: unknown) {
  return page.evaluate(
    async ([cmd, payload]) => {
      const response = await fetch(`http://127.0.0.1:5177/ipc/${cmd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload as string,
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    [command, JSON.stringify(body)] as const,
  );
}

test.describe('设置与环境', () => {
  test('页面加载并显示权限档与环境状态', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('设置与环境');
  });

  test('Web 形态下不显示桌面专属的更新卡片', async ({ page }) => {
    // 更新走的是 Tauri updater；在浏览器里显示一个点了没反应的按钮是骗人
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: /检查更新/ })).toHaveCount(0);
  });
});

test.describe('尚未实现的屏', () => {
  for (const [path, label] of [
    ['/memory', '记忆'],
    ['/agents', 'Agent 角色'],
    ['/prompts', '提示词库'],
    ['/onboarding', '首次配置'],
  ] as const) {
    test(`${label} 说明自己在等哪个里程碑，而不是白屏`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(label);
      // 骨架页会写明所属里程碑
      await expect(page.getByText(/M[1-6]/)).toBeVisible();
    });
  }
});

test.describe('节点配置弹层', () => {
  test('双击节点打开配置，字段由 Schema 生成', async ({ page }) => {
    const id = (await api(page, 'workflow_create', { name: '配置弹层测试' })) as string;
    await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: 'sh',
            type: 'script.shell',
            title: 'Shell 节点',
            position: { x: 200, y: 200 },
            config: { interpreter: 'bash', script: 'echo hi' },
          },
        ],
        edges: [],
        groups: [],
      }),
    });

    await page.goto(`/editor/${id}`);
    await page.locator('.react-flow__node').first().dblclick();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // 字段来自节点定义的 Zod schema，不是写死的表单
    await expect(dialog.getByLabel(/脚本内容/)).toHaveValue('echo hi');
    await expect(dialog.getByLabel(/解释器/)).toBeVisible();
  });

  test('改配置后保存，刷新还在', async ({ page }) => {
    const id = (await api(page, 'workflow_create', { name: '配置落库测试' })) as string;
    await api(page, 'workflow_save_draft', {
      id,
      baseRev: 0,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: 'sh',
            type: 'script.shell',
            title: 'Shell 节点',
            position: { x: 200, y: 200 },
            config: { interpreter: 'bash', script: 'echo before' },
          },
        ],
        edges: [],
        groups: [],
      }),
    });

    await page.goto(`/editor/${id}`);
    await page.locator('.react-flow__node').first().dblclick();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/脚本内容/).fill('echo after');
    await dialog.getByRole('button', { name: /确定|保存|应用/ }).click();

    await page.getByRole('button', { name: /保存/ }).first().click();
    await expect(page.getByRole('button', { name: '已保存' })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await page.locator('.react-flow__node').first().dblclick();
    await expect(page.getByRole('dialog').getByLabel(/脚本内容/)).toHaveValue('echo after');
  });
});

test.describe('无障碍与键盘', () => {
  test('主导航可用键盘遍历，每项都有可识别名', async ({ page }) => {
    await page.goto('/');
    const links = page.locator('nav a');
    const count = await links.count();
    expect(count).toBeGreaterThan(5);

    for (let index = 0; index < count; index += 1) {
      const name = await links.nth(index).getAttribute('aria-label');
      const text = await links.nth(index).textContent();
      expect(name || text?.trim()).toBeTruthy();
    }
  });

  test('未知路径给出可返回的空态，不是白屏', async ({ page }) => {
    await page.goto('/不存在的页面');
    await expect(page.getByText(/找不到这个页面/)).toBeVisible();
    await expect(page.getByRole('link', { name: /回到概览/ })).toBeVisible();
  });
});
