import { test, expect } from '@playwright/test';
import { api } from './_api.js';

/**
 * 管理类三屏（模型 / Agent 角色 / 提示词）的**写入**路径。
 *
 * codex 用真实浏览器点这三屏时，报了一串「看得见但改不了」：
 * 「+」点了没反应、下拉选完弹回、保存报「入参不合契约」，
 * 还有一条「登记时选 high，刷新后变成 medium」。
 *
 * 组件测试用 mock 跑，验证不了「存进去再读出来还是不是那个值」——
 * 这一串就是那半截，全程打真实后端。
 */

const WEB = process.env.AIWF_WEB ?? 'http://localhost:5173';

/** 每条用例自带时间戳，避免复跑时撞名。 */
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

test.describe('模型登记', () => {
  test('登记时选的推理档位，刷新后还是它', async ({ page }) => {
    const name = `档位往返 ${stamp()}`;
    await page.goto(`${WEB}/models`);

    await page.getByRole('button', { name: '登记模型' }).click();
    await page.getByLabel('名称', { exact: true }).fill(name);
    await page.getByLabel('模型 ID').fill('gpt-5-effort-probe');
    await page.getByLabel('推理档位').selectOption('high');
    await page.getByLabel('上下文窗口').fill('131072');
    await page.getByRole('button', { name: '保存' }).click();

    const item = page.getByRole('button', { name: new RegExp(name) });
    await expect(item).toContainText('high');

    // 关键的一半：重新从后端读一遍。
    // 前端 state 显示对了不代表存对了 —— 这正是 codex 报的那条
    await page.reload();
    await expect(page.getByRole('button', { name: new RegExp(name) })).toContainText('high');
  });
});

test.describe('Agent 角色', () => {
  test('新建角色的表单真的会打开', async ({ page }) => {
    await page.goto(`${WEB}/agents`);
    await page.getByRole('button', { name: '新建角色' }).click();
    await expect(page.getByRole('form', { name: '新建角色' })).toBeVisible();
  });

  test('新建后能在列表里选中它，改模型并保存成功', async ({ page }) => {
    const name = `UX 角色 ${stamp()}`;
    await page.goto(`${WEB}/agents`);

    await page.getByRole('button', { name: '新建角色' }).click();
    // exact 是必须的：getByLabel 也匹配 aria-label 子串，
    // 而这一屏有 aria-label="新建角色" / "角色详情" / "角色名称"
    await page.getByLabel('名称', { exact: true }).fill(name);
    await page.getByLabel('角色', { exact: true }).fill('端到端验证');
    await page.getByRole('button', { name: '创建' }).click();

    // 建完自动选中它，详情区应当是可编辑的。
    // 必须先等详情区真的出现：创建是异步的，在它返回之前表单还在，
    // 而表单里也有一个「目标」—— 填进那里就等于什么都没改
    await expect(page.locator('.agents__name-input')).toHaveValue(name);
    const goal = page.locator('#agent-goal');
    await expect(goal).toBeEditable();
    await goal.fill('验证详情区能改能存');
    await expect(goal).toHaveValue('验证详情区能改能存');

    await page.getByRole('button', { name: '保存新版本' }).click();
    // 报错横幅不该出现 —— codex 那次是「agent.update 的入参不合契约」
    await expect(page.getByRole('alert')).toHaveCount(0);

    // 直接问后端有没有落库。
    //
    // 原来是「刷新后在列表里点开它」，但列表分页后一页封顶 50 条，
    // 而 Agent 页按名字排且**图纸没有搜索框**（提示词页才有）——
    // 新建的角色可能落在第二页。那是分页的固有代价，
    // 不该为了让测试好写就往图纸上加一个搜索框。
    const saved = (await api(page, 'agent_list', { limit: 200 })) as {
      items: { name: string; goal: string }[];
    };
    const found = saved.items.find((a) => a.name === name);
    expect(found, '新建的角色没落库').toBeTruthy();
    expect(found?.goal).toBe('验证详情区能改能存');
  });

  test('切换模型后下拉保持新选择', async ({ page }) => {
    await page.goto(`${WEB}/agents`);
    await page.locator('.agents__item').first().click();

    const select = page.getByLabel('模型', { exact: true });
    const options = await select
      .locator('option')
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLOptionElement).value).filter((v) => v.startsWith('model_')),
      );
    test.skip(options.length < 2, '需要至少两个已启用模型');

    const current = await select.inputValue();
    const other = options.find((value) => value !== current)!;
    await select.selectOption(other);
    await expect(select).toHaveValue(other);
  });
});

test.describe('提示词', () => {
  test('用户自己的提示词，分段是可编辑的', async ({ page }) => {
    const name = `UX 提示词 ${stamp()}`;
    await page.goto(`${WEB}/prompts`);

    await page.getByRole('button', { name: '新建提示词' }).click();
    await page.getByLabel('名称', { exact: true }).fill(name);
    await page.getByRole('button', { name: '创建' }).click();

    const role = page.getByLabel('Role');
    await expect(role).toBeEditable();
    await role.fill('你是端到端验证者');

    await page.getByRole('button', { name: '保存新版本' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.reload();
    await page.getByText(name).click();
    await expect(page.getByLabel('Role')).toHaveValue('你是端到端验证者');
  });

  test('内置提示词只读，并指向「先复制一份」', async ({ page }) => {
    await page.goto(`${WEB}/prompts`);
    const builtin = page.locator('.prompts__item', { hasText: '内置' }).first();
    test.skip((await builtin.count()) === 0, '没有内置提示词');

    await builtin.click();
    await expect(page.getByLabel('Role')).toHaveCount(0);

    await page.getByRole('button', { name: '保存新版本' }).click();
    await expect(page.getByRole('alert')).toContainText('复制');
  });
});
