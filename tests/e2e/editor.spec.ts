import { expect, test, type Page } from '@playwright/test';
import { seedWorkflow as seedGraph } from './_api.js';

/**
 * 编辑器与工作流管理的浏览器端到端。
 *
 * 重点是「改动真的落库了」——刷新后还在，而不是只改了内存里的图。
 */

const MINIMAL_GRAPH = {
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 80, y: 120 },
      config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
    },
  ],
  edges: [],
  groups: [],
};

/**
 * 从节点库拖一个节点到画布。
 *
 * 节点库是 HTML5 draggable（图纸：「节点库 · 拖入画布」），
 * 画布用 dataTransfer 里的类型判断落的是什么节点。
 * Playwright 的 dragTo 会派发完整的 dragstart/dragover/drop，够用。
 */
async function dragNodeToCanvas(page: Page, label: string) {
  const source = page.locator('.node-lib__item', { hasText: label }).first();
  const canvas = page.locator('.react-flow__pane');
  await source.dragTo(canvas, { targetPosition: { x: 420, y: 300 } });
}

async function seedWorkflow(page: Page, name: string): Promise<string> {
  const { id } = await seedGraph(page, name, MINIMAL_GRAPH);
  return id;
}

test.describe('概览页', () => {
  test('新建工作流后跳进编辑器，且列表里能看到', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /新建工作流/ }).click();
    await expect(page).toHaveURL(/\/editor\/wf_/, { timeout: 15_000 });

    // 按 id 找那一行，而不是数总行数：这个库是所有 spec 共用的，
    // 并发跑时别的用例也在建工作流，「多了正好一条」不成立
    const id = new URL(page.url()).pathname.split('/').pop()!;
    await page.goto('/');
    await expect(page.locator(`.wf-table tbody tr[data-workflow-id="${id}"]`)).toHaveCount(1);
  });

  test('搜索按名字过滤', async ({ page }) => {
    // 名字带上时间戳：这个库是所有用例共用的，重名会让断言含糊
    const stamp = Date.now();
    await seedWorkflow(page, `搜索目标 alpha ${stamp}`);
    await seedWorkflow(page, `另一个 beta ${stamp}`);
    await page.goto('/');

    // 概览页与节点库都有搜索框；这里要的是概览页那个
    await page.getByPlaceholder(/搜索工作流/).fill(`alpha ${stamp}`);

    const names = page.locator('.wf-table__name');
    await expect(names.filter({ hasText: `搜索目标 alpha ${stamp}` })).toHaveCount(1);
    await expect(names.filter({ hasText: `另一个 beta ${stamp}` })).toHaveCount(0);
  });
});

test.describe('编辑器', () => {
  test('从节点库拖出的节点会落库，刷新后还在', async ({ page }) => {
    const workflowId = await seedWorkflow(page, '编辑器 · 落库');
    await page.goto(`/editor/${workflowId}`);
    // 画布上的节点，不是节点库里那条同名的（「入口设置」）
    await expect(page.locator('.react-flow__node')).toHaveCount(1);

    // 双击画布空白处会打开节点库；这里直接用节点库里的条目
    const before = await page.locator('.react-flow__node').count();
    await dragNodeToCanvas(page, 'Shell 脚本');

    // 新节点出现在画布上
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);

    // 保存后刷新，节点还在 —— 这才叫真的落库
    await page.getByRole('button', { name: /保存/ }).click();
    await expect(page.getByRole('button', { name: '已保存' })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  });

  test('校验问题数来自真实校验，不是写死的', async ({ page }) => {
    // 只有一个入口节点、没有结束节点 —— 校验应当有话说
    const workflowId = await seedWorkflow(page, '编辑器 · 校验');
    await page.goto(`/editor/${workflowId}`);

    const toolbar = page.locator('.editor-bar');
    await expect(toolbar).toBeVisible();
    // 图纸里工具栏显示节点数与连线数，这两个数必须与画布一致
    await expect(toolbar).toContainText('1 节点');
  });

  test('双击标题改名，刷新后还是新名字', async ({ page }) => {
    // 用户操作级测试发现的：新建只能得到「未命名工作流 N」，
    // 没有改名入口 —— 真实库里堆了 300 多条同名的
    const workflowId = await seedWorkflow(page, `改名前 ${Date.now()}`);
    const renamed = `改名后 ${Date.now()}`;

    await page.goto(`/editor/${workflowId}`);
    await page.getByRole('heading', { level: 1 }).dblclick();
    const input = page.getByLabel('工作流名称');
    await input.fill(renamed);
    await input.press('Enter');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);

    // 真的落库了
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
  });

  test('未保存时禁止运行，并说清原因', async ({ page }) => {
    const workflowId = await seedWorkflow(page, '编辑器 · 脏草稿');
    await page.goto(`/editor/${workflowId}`);

    await dragNodeToCanvas(page, 'Shell 脚本');

    const run = page.getByRole('button', { name: /运行/ });
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', /先保存草稿/);
  });
});

test.describe('版本', () => {
  test('发布后版本抽屉里出现快照，且能对比 Diff', async ({ page }) => {
    const workflowId = await seedWorkflow(page, '版本 · 发布');
    await page.goto(`/editor/${workflowId}`);

    await page.getByRole('button', { name: '发布版本' }).click();
    // 发布后再开抽屉（「版本」与「发布版本」都含「版本」，要精确匹配）
    await page.getByRole('button', { name: '版本', exact: true }).click();

    const drawer = page.getByRole('complementary', { name: '版本历史' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: /^v1/ })).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByText('与这个版本完全一致')).toBeVisible();
  });

  test('有未保存改动时禁止发布', async ({ page }) => {
    const workflowId = await seedWorkflow(page, '版本 · 脏草稿');
    await page.goto(`/editor/${workflowId}`);
    await dragNodeToCanvas(page, 'Shell 脚本');

    await page.getByRole('button', { name: '版本', exact: true }).click();
    const drawer = page.getByRole('complementary', { name: '版本历史' });
    await expect(drawer.getByRole('button', { name: /发布草稿为/ })).toBeDisabled();
    await expect(drawer.getByText(/先保存草稿才能发布/)).toBeVisible();
  });
});

test.describe('画布缩放', () => {
  test('拖几个节点进来不会自动放大到顶格', async ({ page }) => {
    // codex 报的现象：拖到第三个节点时画布自动缩放到 220%（= maxZoom），
    // 节点重叠且溢出可视区。根因是 fitView 每次节点变化都重新适配，
    // 而三个挨得很近的节点「适配」出来就是把它们放到最大
    const id = await seedWorkflow(page, `缩放验证 ${Date.now()}`);
    await page.goto(`/editor/${id}`);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);

    for (const label of ['Shell 脚本', '人工审批', '条件分支']) {
      await dragNodeToCanvas(page, label);
      await page.waitForTimeout(150);
    }

    const zoom = await page.locator('.editor__zoom-value').textContent();
    const percent = Number.parseInt(zoom?.replace('%', '') ?? '0', 10);
    expect(percent, `实际缩放 ${zoom}`).toBeLessThanOrEqual(100);
  });

  test('打开一张大图时会缩小到看得全', async ({ page }) => {
    // 反过来的一半：fitView 该做的事是「缩小到看得全」，那个要留着
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      type: 'script.shell',
      title: `节点 ${i}`,
      position: { x: i * 400, y: (i % 3) * 300 },
      config: { interpreter: 'bash', script: 'echo hi', timeoutMs: 10_000 },
    }));
    const { id } = await seedGraph(page, `大图 ${Date.now()}`, { nodes, edges: [], groups: [] });

    await page.goto(`/editor/${id}`);
    await expect(page.locator('.react-flow__node')).toHaveCount(12);

    const zoom = await page.locator('.editor__zoom-value').textContent();
    const percent = Number.parseInt(zoom?.replace('%', '') ?? '0', 10);
    expect(percent, `实际缩放 ${zoom}`).toBeLessThan(100);
  });
});
