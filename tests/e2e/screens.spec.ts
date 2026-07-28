import { expect, test } from '@playwright/test';
import { api } from './_api.js';

/**
 * 其余各屏的浏览器端到端。
 *
 * 尚未实现的屏（记忆 / Agent / 提示词）也要测：它们必须**说清楚在等什么**，
 * 而不是白屏或者放演示内容。「宁可页面留空，也不要做假的」
 * 这条要求同样需要被验证。
 */

test.describe('设置与环境', () => {
  test('页面加载并显示权限档与环境状态', async ({ page }) => {
    await page.goto('/settings');
    // 图纸「05 设置与环境」是左右两栏：左边「设置」分组导航，
    // 右边第一个标题是 h4「运行环境健康」——页面级没有 h1
    await expect(page.getByRole('tablist', { name: '设置分组' })).toBeVisible();
    await expect(page.getByText('运行环境健康')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: '权限策略' })).toBeVisible();
  });

  test('Web 形态下不显示桌面专属的更新卡片', async ({ page }) => {
    // 更新走的是 Tauri updater；在浏览器里显示一个点了没反应的按钮是骗人
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: /检查更新/ })).toHaveCount(0);
  });
});

test.describe('Agent 角色（图纸「05 Agent 角色」）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('region', { name: '角色详情' })).toBeVisible();
  });

  test('左栏 250px', async ({ page }) => {
    const width = await page.evaluate(() => {
      const el = document.querySelector('.agents__list');
      return el ? Number.parseFloat(getComputedStyle(el).width) : -1;
    });
    expect(width).toBe(250);
  });

  test('底部两句常驻说明照图纸', async ({ page }) => {
    await expect(
      page.getByText('节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效。'),
    ).toBeVisible();
  });

  test('选中角色后四块内容都在，权限那块标明由引擎强制', async ({ page }) => {
    const first = page.locator('.agents__item').first();
    if ((await first.count()) === 0) test.skip();
    await first.click();

    const detail = page.getByRole('region', { name: '角色详情' });
    await expect(detail.getByText('权限（引擎强制，Prompt 无法越权）')).toBeVisible();
    await expect(detail.getByText('工具与 MCP 白名单')).toBeVisible();
    await expect(
      detail.getByText(
        '节点可覆盖任务指令、输出 Schema 和 Turn 上限，但不能静默扩大这里声明的权限。',
      ),
    ).toBeVisible();
  });

  test('复制角色真的建出一个副本', async ({ page }) => {
    const items = page.locator('.agents__item');
    if ((await items.count()) === 0) test.skip();

    // 按名字找，不数条数：列表分页后一页封顶 50 条，
    // 副本可能落在第二页 —— 而「多了一条」这个断言在满页时永远不成立
    await items.first().click();
    const name = (await page.locator('.agents__name-input').inputValue()) || '';
    await page.getByRole('button', { name: '复制' }).click();

    await expect(page.locator('.agents__item', { hasText: `${name} 副本` }).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe('提示词库（图纸「06 提示词库」）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/prompts');
    await expect(page.getByRole('region', { name: '提示词详情' })).toBeVisible();
  });

  test('左栏 266px，搜索占位文案照图纸', async ({ page }) => {
    const width = await page.evaluate(() => {
      const el = document.querySelector('.prompts__list');
      return el ? Number.parseFloat(getComputedStyle(el).width) : -1;
    });
    expect(width).toBe(266);
    await expect(page.getByPlaceholder('搜索名称、变量或正文')).toBeVisible();
  });

  test('底部常驻说明照图纸', async ({ page }) => {
    await expect(
      page.getByText('系统调用 AI 的每一处都在这里：节点、⌘K 协作、记忆提议、通知与失败归因。'),
    ).toBeVisible();
  });

  test('选中后四个 tab 都能切，变量与版本各有那句说明', async ({ page }) => {
    const first = page.locator('.prompts__item').first();
    if ((await first.count()) === 0) test.skip();
    await first.click();

    await expect(page.getByText('框架分段可见可改 · 保存后新运行生效')).toBeVisible();

    await page.getByRole('tab', { name: '变量' }).click();
    await expect(
      page.getByText('Secret 只能以引用形式出现，预览与日志中永不展开明文。'),
    ).toBeVisible();

    await page.getByRole('tab', { name: '版本' }).click();
    await expect(
      page.getByText('运行记录会引用当时的提示词版本，历史结果始终可解释。'),
    ).toBeVisible();
  });

  test('搜索发给后端：搜一个不存在的词列表变空', async ({ page }) => {
    const items = page.locator('.prompts__item');
    if ((await items.count()) === 0) test.skip();

    await page.getByPlaceholder('搜索名称、变量或正文').fill('绝不可能存在的词abcxyz');
    await page.keyboard.press('Enter');
    await expect(items).toHaveCount(0);
  });
});

test.describe('记忆管理（图纸「04 记忆管理」）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/memory');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('记忆管理');
  });

  test('作用域 chips 照图纸六个', async ({ page }) => {
    const group = page.getByRole('group', { name: '作用域' });
    const labels = await group.getByRole('button').allTextContents();
    expect(labels.map((l) => l.trim())).toEqual([
      '全部',
      '全局',
      '工作区',
      '工作流',
      'Agent',
      '会话',
    ]);
  });

  test('底部常驻那句关于密钥与权限的说明', async ({ page }) => {
    await expect(page.getByText(/Token、密钥和敏感文件内容禁止写入记忆/)).toBeVisible();
  });

  test('AI 提议的条目单独占一块，并说明确认后才生效', async ({ page }) => {
    const region = page.getByRole('region', { name: 'AI 提议写入' });
    if ((await region.count()) === 0) test.skip();
    await expect(region.getByText('确认后才保存，并注入后续调用')).toBeVisible();
  });

  test('停用一条记忆后它仍在列表里，只是标成已停用', async ({ page }) => {
    // 自己建一条来操作，不碰共用的那些：这个库是所有 spec 共用的，
    // 用 .first() 加「行数不变」在并发下必然翻车 —— 别的用例正在建记忆
    const key = `e2e.toggle.${Date.now()}`;
    const id = (await api(page, 'memory_create', {
      scope: 'workspace',
      key,
      value: '停用验证用，跑完就删',
      source: 'user',
      createdBy: 'e2e',
      tags: [],
      enabled: true,
    })) as string;

    try {
      await page.goto('/memory');
      const row = page.locator('.memory__row', { hasText: key });
      await expect(row).toHaveCount(1);

      await row.getByRole('button', { name: `停用 ${key}` }).click();

      // 还在列表里 —— 停用不是删除，用户要看得到它为什么不生效
      await expect(page.locator('.memory__row', { hasText: key })).toHaveCount(1);
      await expect(
        page.locator('.memory__row', { hasText: key }).locator('.memory__off'),
      ).toBeVisible();
    } finally {
      await api(page, 'memory_delete', { id });
    }
  });
});

test.describe('首次配置（图纸「06 首次安装与检测」）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('环境检测与依赖补齐');
  });

  test('四步照图纸，且真的探测了环境', async ({ page }) => {
    const steps = page.getByRole('list', { name: '配置步骤' }).getByRole('listitem');
    await expect(steps).toHaveCount(4);

    // 真实探测：这台机器上 git 一定在
    await expect(page.locator('[data-capability="git"]')).toContainText('就绪');
  });

  test('底部三个按钮照图纸，且第一个真的能往下走', async ({ page }) => {
    // codex 两轮都报这一屏「只有阶段占位文案，没有任何控件」。
    // 图纸底部是三个按钮 + 一句「下一步」——
    // 曾经只放了一个我自己加的「跳过配置」，图纸上没有那个。
    await expect(page.getByRole('button', { name: '仅检测，不安装' })).toBeVisible();
    await expect(page.getByRole('button', { name: '导出脱敏诊断报告' })).toBeVisible();
    await expect(page.getByText('下一步：授权工作目录并运行内置示例')).toBeVisible();

    const go = page.getByRole('button', { name: /确认并安装|授权工作目录并开始/ });
    await expect(go).toBeVisible();
    await go.click();

    // 有缺失工具时先展开命令清单 —— 应用自己不下载任何东西
    const 命令区 = page.getByRole('region', { name: '要执行的命令' });
    if (await 命令区.isVisible().catch(() => false)) {
      await expect(命令区).toContainText('install-deps.sh');
      await page.getByRole('button', { name: '装好了，继续' }).click();
    }

    // 走完之后配置真的落了地：顶栏不再写「尚未授权工作目录」
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('尚未授权工作目录')).toHaveCount(0);
  });

  test('写明 Secret 不进这些目录', async ({ page }) => {
    const region = page.getByRole('region', { name: '将写入的位置' });
    await expect(region).toContainText('Secret 只保存在 Keychain');
  });
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
