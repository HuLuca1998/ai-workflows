import { expect, test, type Page } from '@playwright/test';

/**
 * 画布交互与导入导出。
 *
 * 图纸底部那行提示就是这一组的清单：
 * 「双击编辑 · 右键菜单 · 端口拖出连线 · 点连线可删 · Shift 框选 · ⌘A 全选」
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

const TWO_NODES = {
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 120, y: 200 },
      config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
    },
    {
      id: 'sh',
      type: 'script.shell',
      title: 'Shell 节点',
      position: { x: 500, y: 200 },
      config: { interpreter: 'bash', script: 'echo hi' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'sh', port: 'input' },
    },
  ],
  groups: [],
};

async function seed(page: Page, name: string, graph: unknown = TWO_NODES) {
  const id = (await api(page, 'workflow_create', { name })) as string;
  await api(page, 'workflow_save_draft', { id, baseRev: 0, graphJson: JSON.stringify(graph) });
  return id;
}

test.describe('右键菜单', () => {
  test('节点右键给出编辑 / 复制 / 删除', async ({ page }) => {
    const id = await seed(page, '右键 · 节点');
    await page.goto(`/editor/${id}`);

    await page.locator('.react-flow__node').nth(1).click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    for (const label of ['编辑配置', '复制', '删除']) {
      await expect(menu.getByRole('menuitem', { name: label })).toBeVisible();
    }
  });

  test('复制节点后画布上多一个，且能落库', async ({ page }) => {
    const id = await seed(page, '右键 · 复制');
    await page.goto(`/editor/${id}`);
    const before = await page.locator('.react-flow__node').count();

    await page.locator('.react-flow__node').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '复制' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);

    await page.getByRole('button', { name: /保存/ }).first().click();
    await expect(page.getByRole('button', { name: '已保存' })).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  });

  test('删除节点会连带删掉它的连线', async ({ page }) => {
    const id = await seed(page, '右键 · 删除');
    await page.goto(`/editor/${id}`);
    await expect(page.locator('.editor-bar')).toContainText('1 连接');

    await page.locator('.react-flow__node').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除' }).click();

    // 悬空的连线必须一起消失，否则图会立刻校验不过
    await expect(page.locator('.editor-bar')).toContainText('1 节点');
    await expect(page.locator('.editor-bar')).toContainText('0 连接');
  });

  test('连线右键给出反转与删除', async ({ page }) => {
    const id = await seed(page, '右键 · 连线');
    await page.goto(`/editor/${id}`);

    await page.locator('.react-flow__edge').first().click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: '反转方向' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '删除连线' })).toBeVisible();
  });

  test('按 Escape 关掉菜单', async ({ page }) => {
    const id = await seed(page, '右键 · Escape');
    await page.goto(`/editor/${id}`);

    await page.locator('.react-flow__node').first().click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('导入导出', () => {
  test('导入一份合法的图会建出新工作流，并直接进编辑器', async ({ page }) => {
    await page.goto('/');
    // 等列表加载完再计数：页面刚打开时是 0，拿它当基准会一直对不上
    const rows = page.locator('.wf-table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const before = await rows.count();

    await page.getByLabel('导入工作流文件').setInputFiles({
      name: `导入的流程-${Date.now()}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(TWO_NODES)),
    });

    // 导入成功会直接进编辑器 —— 导入的意图本来就是去编辑它
    await expect(page).toHaveURL(/\/editor\/wf_/, { timeout: 15_000 });
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    // 回概览页确认真的多了一条
    await page.goto('/');
    await expect(rows).toHaveCount(before + 1);
  });

  test('导入坏图时说清原因，不建出半个工作流', async ({ page }) => {
    await page.goto('/');
    const rows = page.locator('.wf-table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const before = await rows.count();

    await page.getByLabel('导入工作流文件').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      // 节点类型不存在
      buffer: Buffer.from(
        JSON.stringify({
          nodes: [
            { id: 'x', type: '并不存在的类型', title: 'x', position: { x: 0, y: 0 }, config: {} },
          ],
          edges: [],
          groups: [],
        }),
      ),
    });

    await expect(page.getByText(/导入失败/)).toBeVisible();
    await expect(rows).toHaveCount(before);
  });

  test('导入不是 JSON 的文件也要给出可读的错误', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('导入工作流文件').setInputFiles({
      name: 'notjson.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('这不是 JSON'),
    });
    await expect(page.getByText(/导入失败/)).toBeVisible();
  });
});
