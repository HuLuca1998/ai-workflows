import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * ARIA 语义的完整性。
 *
 * 这一类缺陷渲染测试和视觉检查都抓不到：界面上一切正常，只有读屏用户
 * 和纯键盘用户会撞上。规范 §7 要求「所有可交互元素保留 focus-visible」
 * 「状态不能只靠颜色」，落到实现上就是这几件事：
 *
 * - `role="tab"` 必须配 `aria-controls` 指向一个 `role="tabpanel"`，
 *   否则读屏用户听到「标签页」却找不到对应面板
 * - 切换筛选条件的按钮组不是 tablist —— 它没有面板可切，
 *   用 `role="group"` + `aria-pressed` 才是它真正的语义
 * - 模态抽屉要 `role="dialog"` + `aria-modal`，并在打开时把焦点接管进去
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { PromptsPage } = await import('../src/prompts/PromptsPage.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'prompt.list': () => ({ items: [], total: 0 }),
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
});

/** 每个 tab 都要指到一个真实存在的 tabpanel，反过来面板也要指回 tab。 */
function expectTabsWired(container: HTMLElement) {
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  expect(tabs.length, '没有找到任何 role=tab').toBeGreaterThan(0);

  for (const tab of tabs) {
    const label = tab.textContent?.trim() ?? '(空)';
    expect(tab.id, `tab「${label}」没有 id，面板无从 aria-labelledby 指回它`).toBeTruthy();

    const controls = tab.getAttribute('aria-controls');
    expect(controls, `tab「${label}」缺 aria-controls`).toBeTruthy();

    // 未选中的 tab 要退出 Tab 序列（roving tabindex），
    // 否则键盘用户要按 N 次 Tab 才能穿过整条 tab 条
    const selected = tab.getAttribute('aria-selected') === 'true';
    expect(tab.getAttribute('tabindex'), `tab「${label}」的 tabindex 不对`).toBe(
      selected ? '0' : '-1',
    );
  }

  // 当前选中的那个 tab 必须有对应面板
  const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  expect(active, '没有任何 tab 处于选中态').toBeDefined();
  const panel = container.querySelector(`#${active!.getAttribute('aria-controls')}`);
  expect(panel, `aria-controls 指向的面板不存在`).not.toBeNull();
  expect(panel!.getAttribute('role')).toBe('tabpanel');
  expect(panel!.getAttribute('aria-labelledby')).toBe(active!.id);
}

/**
 * tablist 的方向必须与它实际接受的方向键一致。
 *
 * ARIA 默认 horizontal。纵向排列的 tablist 不声明 `aria-orientation="vertical"`
 * 的话，读屏会提示用左右键 —— 而实现只认上下键，按了没反应；
 * 未选中项又已被 roving tabindex 移出 Tab 序列，再按 Tab 会直接离开整个
 * tablist，其余项完全不可达。
 */
function expectOrientationMatchesKeys(tablist: Element, expected: 'vertical' | 'horizontal') {
  const declared = tablist.getAttribute('aria-orientation') ?? 'horizontal';
  expect(declared, `tablist 声明的方向与它接受的方向键不一致`).toBe(expected);
}

describe('设置页的分组 tab 条', () => {
  it('每个 tab 指向真实的 tabpanel，未选中的退出 Tab 序列', async () => {
    const { SettingsPage } = await import('../src/pages/SettingsPage.js');
    const { MemoryRouter } = await import('react-router');
    const { container } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expectTabsWired(container);
    // 它是纵向排列（styles.css 里 flex-direction: column），只认上下键
    expectOrientationMatchesKeys(container.querySelector('[role="tablist"]')!, 'vertical');
  });

  it('方向键切换并首尾环绕，焦点跟着走', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const { SettingsPage } = await import('../src/pages/SettingsPage.js');
    const { MemoryRouter } = await import('react-router');
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);

    // 从第一项往上是环绕到最后一项，而不是卡住。
    // 用 user.click 而不是原生 click：后者不被 act 包裹，
    // setTab 还没生效按键就发出去了，读到的是上一轮的 tab
    await user.click(tabs[0]!);
    tabs[0]!.focus();
    await user.keyboard('{ArrowUp}');
    expect(tabs[tabs.length - 1]!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('提示词页的 tab 条', () => {
  it('每个 tab 指向真实的 tabpanel', async () => {
    const checked = createContractCall({
      'prompt.list': () => ({
        items: [
          {
            id: 'prompt_1',
            group: '分析',
            name: '提示 1',
            sections: [{ title: 'Role', body: '正文' }],
            vars: [],
            ver: 1,
            builtin: false,
            updatedAt: '2026-07-28T10:00:00Z',
          },
        ],
        total: 1,
      }),
    });
    call.mockImplementation((method: string, input: unknown) => checked(method, input));

    const { container } = render(<PromptsPage />);
    // tab 条要选中一条提示词后才渲染
    const row = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.prompts__item');
      expect(el).not.toBeNull();
      return el!;
    });
    row.click();
    await waitFor(() => expect(container.querySelector('[role="tab"]')).not.toBeNull());
    expectTabsWired(container);
  });
});

describe('运行页的 tab 条', () => {
  it('每个 tab 指向真实的 tabpanel', async () => {
    const checked = createContractCall({
      'run.list': () => ({
        items: [
          {
            id: 'run_1',
            workflowId: 'wf_1',
            workflowName: '示例',
            versionId: 'v1',
            status: 'succeeded',
            inputs: {},
            startedAt: '2026-07-28T10:00:00Z',
          },
        ],
        total: 1,
      }),
      'run.events': () => ({ events: [], nextSeq: 0, hasMore: false }),
    });
    call.mockImplementation((method: string, input: unknown) => checked(method, input));

    const { RunsPage } = await import('../src/runs/RunsPage.js');
    const { MemoryRouter } = await import('react-router');
    const { container } = render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>,
    );

    const row = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.runs__item');
      expect(el).not.toBeNull();
      return el!;
    });
    row.click();
    await waitFor(() => expect(container.querySelector('[role="tab"]')).not.toBeNull());
    expectTabsWired(container);
    // 横向排列，用左右键 —— 默认就是 horizontal，不声明也对
    expectOrientationMatchesKeys(container.querySelector('[role="tablist"]')!, 'horizontal');
  });
});

describe('节点配置弹层的 tab 条', () => {
  it('每个 tab 指向真实的 tabpanel', async () => {
    const { NodeConfigDialog } = await import('../src/editor/NodeConfigDialog.js');
    const node = {
      id: 'lint',
      type: 'script.shell' as const,
      title: '运行 lint',
      position: { x: 0, y: 0 },
      config: {
        interpreter: 'zsh',
        script: 'pnpm lint',
        env: {},
        secretEnv: {},
        outputParse: 'none',
        successExitCodes: [0],
        outputLimitBytes: 1048576,
        timeoutMs: 900000,
      },
    };
    const { container } = render(
      <NodeConfigDialog
        node={node}
        graph={{ nodes: [], edges: [], groups: [] }}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    expectTabsWired(container);
  });
});

describe('筛选按钮组不是 tablist', () => {
  /*
   * 切换筛选条件的按钮没有面板可切 —— 它们是 toggle，不是标签页。
   * 用 role=tab 的话读屏用户被告知「N 个标签页」，按方向键期望切换面板，
   * 实际什么都不发生；而选中态若只有颜色，色觉障碍用户也读不出来。
   */
  it('记忆页的作用域筛选带 aria-pressed', async () => {
    const checked = createContractCall({
      'memory.list': () => ({ items: [], total: 0 }),
    });
    call.mockImplementation((method: string, input: unknown) => checked(method, input));

    const { MemoryPage } = await import('../src/memory/MemoryPage.js');
    const { container } = render(<MemoryPage />);
    await waitFor(() => expect(call).toHaveBeenCalled());

    // 从 group 里取**全部**按钮。用 [data-active] 选的话只会命中当前激活那一个
    // （未选项根本没有这个属性），删掉未选项的 aria-pressed 测试照样绿。
    const group = container.querySelector('[role="group"]');
    expect(group, '没找到作用域 group').not.toBeNull();
    const chips = [...group!.querySelectorAll('button')];
    expect(chips.length, '没找到筛选 chip').toBeGreaterThan(1);
    expect(
      chips.filter((c) => c.getAttribute('aria-pressed') === 'true').length,
      '应当恰好有一个 chip 处于选中态',
    ).toBe(1);
    for (const chip of chips) {
      const label = chip.textContent?.trim();
      expect(chip.getAttribute('role'), `筛选「${label}」用了 role=tab`).not.toBe('tab');
      expect(
        chip.hasAttribute('aria-pressed'),
        `筛选「${label}」缺 aria-pressed —— 选中态只靠颜色`,
      ).toBe(true);
    }
  });

  it('概览页的状态筛选不是 tablist —— 它切的是后端查询，不是视图', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // jsdom 环境下 import.meta.url 不是 file: scheme，用 cwd 拼
    const src = readFileSync(join(process.cwd(), 'apps/web/src/pages/OverviewPage.tsx'), 'utf8');
    // 底下是一张表，没有 tabpanel 可指 —— 这一屏不该出现任何 tab 语义
    expect(src).not.toMatch(/role="tab(list)?"/u);
    expect(src).toMatch(/aria-pressed/u);
  });
});

describe('主管 AI 抽屉是模态对话框', () => {
  it('有 role=dialog + aria-modal，且打开时焦点进到输入框', async () => {
    const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');
    render(<SupervisorDrawer open onClose={() => {}} context={{}} onApply={() => {}} />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // 不接管焦点的话，Tab 会一路穿过被遮罩挡住、根本点不到的画布控件
    await waitFor(() => {
      expect(document.activeElement?.tagName).toBe('TEXTAREA');
    });
  });

  it('Tab 循环留在对话框内 —— aria-modal 说了是模态，行为就得是', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const { SupervisorDrawer } = await import('../src/supervisor/SupervisorDrawer.js');
    const user = userEvent.setup();

    render(
      <>
        {/* 身后的页面内容。没有 focus trap 的话 Tab 会跑到这儿来 —— 
            而它在视觉上是被遮罩挡住、根本点不到的 */}
        <button type="button">身后的按钮</button>
        <SupervisorDrawer open onClose={() => {}} context={{}} onApply={() => {}} />
      </>,
    );

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // 连按远超对话框内可聚焦元素个数的次数，焦点必须始终留在里面
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(
        dialog.contains(document.activeElement),
        `第 ${i + 1} 次 Tab 后焦点跑到了「${document.activeElement?.textContent?.trim()}」`,
      ).toBe(true);
    }

    // 反向也要循环
    for (let i = 0; i < 12; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement), `第 ${i + 1} 次 Shift+Tab 后跑出去了`).toBe(
        true,
      );
    }
  });
});
