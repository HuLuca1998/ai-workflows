import { expect, test, type Page } from '@playwright/test';
import { seedWorkflow } from './_api.js';

/**
 * 浏览器端到端：真实点击 → 真实引擎。
 *
 * 与组件测试的分工：那边验证「给定数据，界面渲染对不对」，
 * 这边验证「点下去，引擎真的动了，而且界面显示的与引擎里的一致」。
 * 中间那层（IPC 转换、参数名、序列化形状）只有这样才测得到。
 */

/** 建一个带真实脚本节点的工作流，返回它的 id。 */
async function createWorkflow(page: Page, name: string, graph: unknown): Promise<string> {
  const { id } = await seedWorkflow(page, name, graph);
  return id;
}

const SCRIPT_GRAPH = {
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 40, y: 40 },
      config: {
        trigger: 'manual',
        inputSchema: {
          type: 'object',
          required: ['who'],
          properties: {
            who: { type: 'string', title: '打招呼的对象' },
            greeting: { type: 'string', title: '问候语', default: '你好' },
          },
        },
      },
    },
    {
      id: 'greet',
      type: 'script.shell',
      title: '打招呼',
      position: { x: 300, y: 40 },
      config: {
        interpreter: 'bash',
        script: 'echo "${input.greeting}, ${input.who}"',
        timeoutMs: 10000,
      },
    },
    {
      id: 'done',
      type: 'end',
      title: '结束',
      position: { x: 560, y: 40 },
      config: { outcome: 'success' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'greet', port: 'input' },
    },
    {
      id: 'e2',
      source: { nodeId: 'greet', port: 'success' },
      target: { nodeId: 'done', port: 'input' },
    },
  ],
  groups: [],
};

test.describe('外壳与导航', () => {
  test('概览页加载并列出真实工作流', async ({ page }) => {
    // 名字带时间戳：这个库是所有用例共用的，跑到后面会有几十条记录
    const name = `UI 测试 · 概览 ${Date.now()}`;
    await createWorkflow(page, name, SCRIPT_GRAPH);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: '工作流', level: 1 })).toBeVisible();
    // 用计数而不是 toBeVisible：列表长了之后目标行会被挤出视口，
    // 那不是「没渲染」，只是要滚动
    await expect(page.locator('.wf-table__name').filter({ hasText: name })).toHaveCount(1);
  });

  test('每个菜单项都能打开且不报控制台错误', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    for (const path of [
      '/',
      '/editor',
      '/runs',
      '/models',
      '/memory',
      '/agents',
      '/prompts',
      '/settings',
    ]) {
      await page.goto(path);
      // 页面得渲染出东西来，不能是白屏
      await expect(page.locator('body')).not.toBeEmpty();
    }

    // 连不上开发服务这类错误必须暴露，不能静默
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });
});

test.describe('模型登记（真实写库）', () => {
  test('登记 → 出现在列表 → 停用 → 删除', async ({ page }) => {
    // 名字带时间戳：本地测试库是留存的，跑第二轮时同名条目会让断言含糊
    const name = `UI 登记的模型 ${Date.now()}`;
    await page.goto('/models');

    await page.getByRole('button', { name: '登记模型' }).click();
    await page.getByLabel(/^名称/).fill(name);
    await page.getByLabel(/模型 ID/).fill('claude-sonnet-5');
    await page.getByLabel(/上下文窗口/).fill('200000');
    await page.getByLabel(/凭据/).fill('keychain://ui-test');
    await page.getByRole('button', { name: '保存' }).click();

    // 真的写进库了：刷新后还在
    await expect(page.getByText(name)).toBeVisible();
    await page.reload();
    await expect(page.getByText(name)).toBeVisible();

    await page.getByRole('button', { name }).click();

    // 操作按钮限定在详情区内：左栏条目的状态标签也含「停用」两个字，
    // 而基线数据里本来就有停用状态的模型
    const detail = page.getByRole('region', { name: '模型详情' });
    await expect(detail.getByText('keychain://ui-test')).toBeVisible();
    // 界面上不该有查看明文的入口
    await expect(detail.getByRole('button', { name: /显示明文|查看密钥/ })).toHaveCount(0);

    await detail.getByRole('button', { name: '停用' }).click();
    await expect(detail.getByRole('button', { name: '启用' })).toBeVisible();

    await detail.getByRole('button', { name: '删除' }).click();
    await detail.getByRole('button', { name: /确认删除/ }).click();
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test('明文密钥在界面上就被拦住，不会发到后端', async ({ page }) => {
    await page.goto('/models');
    await page.getByRole('button', { name: '登记模型' }).click();
    const plaintextName = `明文测试 ${Date.now()}`;
    await page.getByLabel(/^名称/).fill(plaintextName);
    await page.getByLabel(/模型 ID/).fill('x');
    await page.getByLabel(/上下文窗口/).fill('1000');
    await page.getByLabel(/凭据/).fill('明文密钥的占位');
    await page.getByRole('button', { name: '保存' }).click();

    await expect(page.getByText(/必须是 keychain:\/\/ 引用/)).toBeVisible();
    await expect(page.getByText(plaintextName)).toHaveCount(0);
  });
});

test.describe('运行一个真实工作流', () => {
  test('启动表单 → 依赖检查 → 开始 → 执行记录显示真实事件', async ({ page }) => {
    const workflowId = await createWorkflow(page, 'UI 测试 · 打招呼', SCRIPT_GRAPH);
    await page.goto(`/editor/${workflowId}`);

    await page.getByRole('button', { name: /运行/ }).click();

    // 启动表单的字段来自入口节点的 inputSchema
    await expect(page.getByText('启动表单由入口节点的输入 Schema 自动生成')).toBeVisible();
    await expect(page.getByText('打招呼的对象')).toBeVisible();
    // schema 里的默认值预填了
    await expect(page.getByLabel(/问候语/)).toHaveValue('你好');

    // 依赖检查是真跑的
    await expect(page.getByText(/项通过/)).toBeVisible();

    await page.getByLabel(/打招呼的对象/).fill('世界');
    await page.getByRole('button', { name: /开始运行/ }).click();

    // 跳到执行记录并展开这次运行
    await expect(page).toHaveURL(/\/runs\?run=run_/);
    const detail = page.getByRole('region', { name: '运行详情' });
    await expect(detail).toBeVisible();

    // 引擎真的跑完了，事件流里有完整生命周期。
    // 用 .runs__event-type 定位而不是全文匹配：摘要里也可能出现同样的字样
    const eventTypes = page.locator('.runs__event-type');
    await expect(eventTypes.filter({ hasText: 'run.succeeded' })).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(eventTypes.filter({ hasText: 'node.succeeded' }).first()).toBeVisible();

    // 启动参数原样显示（限定在详情区内：列表条目上也会出现同样的文本）
    await expect(detail.getByText('who=世界')).toBeVisible();

    // 产物 tab 有脚本的真实输出
    await page.getByRole('tab', { name: '产物' }).click();
    await expect(detail.getByText('stdout.log')).toBeVisible();
  });

  test('审批节点会挂起，批准后继续', async ({ page }) => {
    const graph = {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: { x: 40, y: 40 },
          // inputSchema 是必填：缺了它工具栏会报「有问题」并禁用运行
          config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
        },
        {
          id: 'ap',
          type: 'approval',
          title: '确认继续',
          position: { x: 300, y: 40 },
          config: { title: '确认继续', interaction: 'confirm' },
        },
        {
          id: 'after',
          type: 'script.shell',
          title: '批准后执行',
          position: { x: 560, y: 40 },
          config: { interpreter: 'bash', script: 'echo 已批准', timeoutMs: 10000 },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'ap', port: 'input' },
        },
        {
          id: 'e2',
          source: { nodeId: 'ap', port: 'approved' },
          target: { nodeId: 'after', port: 'input' },
        },
      ],
      groups: [],
    };
    const workflowId = await createWorkflow(page, 'UI 测试 · 审批', graph);

    await page.goto(`/editor/${workflowId}`);
    await page.getByRole('button', { name: /运行/ }).click();
    await expect(page.getByText(/项通过/)).toBeVisible();
    await page.getByRole('button', { name: /开始运行/ }).click();

    // 停在审批上，并给出决定入口
    await expect(page.getByRole('button', { name: '批准' })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('.runs__event-type').filter({ hasText: 'approval.requested' }),
    ).toHaveCount(1);

    await page.getByRole('button', { name: '批准' }).click();

    await expect(
      page.locator('.runs__event-type').filter({ hasText: 'run.succeeded' }),
    ).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: '批准' })).toHaveCount(0);
  });

  test('失败的运行显示失败横幅与错误详情', async ({ page }) => {
    const graph = {
      nodes: [
        {
          id: 'entry',
          type: 'entry',
          title: '入口',
          position: { x: 40, y: 40 },
          // inputSchema 是必填：缺了它工具栏会报「有问题」并禁用运行
          config: { trigger: 'manual', inputSchema: { type: 'object', properties: {} } },
        },
        {
          id: 'boom',
          type: 'script.shell',
          title: '会失败的脚本',
          position: { x: 300, y: 40 },
          config: { interpreter: 'bash', script: 'echo 出错细节 >&2; exit 7', timeoutMs: 10000 },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'entry', port: 'success' },
          target: { nodeId: 'boom', port: 'input' },
        },
      ],
      groups: [],
    };
    const workflowId = await createWorkflow(page, 'UI 测试 · 失败', graph);

    await page.goto(`/editor/${workflowId}`);
    await page.getByRole('button', { name: /运行/ }).click();
    await expect(page.getByText(/项通过/)).toBeVisible();
    await page.getByRole('button', { name: /开始运行/ }).click();

    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('boom');
    await expect(banner).toContainText('7');
  });
});

test.describe('执行记录', () => {
  test('筛选发给后端：选「失败」后列表只剩失败的运行', async ({ page }) => {
    await page.goto('/runs');

    // 之前的用例留下了成功与失败的运行
    await expect(page.locator('.runs__item').first()).toBeVisible({ timeout: 15_000 });
    const before = await page.locator('.runs__item').count();
    expect(before).toBeGreaterThan(1);

    await page.getByRole('button', { name: '失败' }).click();

    // 筛选是后端做的：条数变少，且剩下的都带「失败」状态
    await expect
      .poll(async () => page.locator('.runs__item').count(), { timeout: 10_000 })
      .toBeLessThan(before);
    const statuses = await page.locator('.runs__item [role="status"]').allTextContents();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((text) => text.includes('失败'))).toBe(true);
  });

  test('底部两句常驻说明照图纸在位', async ({ page }) => {
    await page.goto('/runs');
    await expect(page.getByText('同一工作流可用不同参数并行运行，环境快照互不影响')).toBeVisible();
  });
});
