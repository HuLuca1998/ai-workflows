import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { NAV_ITEMS } from '../src/navigation.js';

/**
 * 设置页的分档，以及主导航与它的分工。
 *
 * 理由记在 `docs/adr/0010-settings-holds-setup-and-version.md`。
 * 一句话：主导航放**每天都要用的**，设置放**配置与一次性的**。
 *
 * 这组测试守的是「找不找得到」，而那件事没有别的测试会替它红 ——
 * 把版本卡片挪回环境档滚到底、把首次配置排到最后，
 * 现有的功能测试一条都不会失败。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

import type * as WorkspaceModule from '../src/data/workspace.js';

const { createContractCall } = await import('./_contractClient.js');
const { SettingsPage } = await import('../src/pages/SettingsPage.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'env.health': () => ({ ready: true, items: [] }),
    'workspace.settings': () => ({ permissionPreset: 'ai_assisted' }),
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
});

const view = (path = '/settings') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>,
  );

describe('分档顺序按「什么时候会用到」排', () => {
  it('首次配置在最上，系统版本在最下', async () => {
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    const labels = within(nav)
      .getAllByRole('tab')
      .map((el) => el.textContent);

    expect(labels[0]).toBe('首次配置');
    expect(labels.at(-1)).toBe('系统版本');
  });

  it('中间保留图纸那八档，一项不少', async () => {
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    const labels = within(nav)
      .getAllByRole('tab')
      .map((el) => el.textContent);

    expect(labels).toEqual([
      '首次配置',
      '通用',
      'AI 与 Agent',
      'Git 与 GitHub',
      '运行环境与工具',
      'MCP 与集成',
      '通知',
      '安全与隐私',
      '高级',
      '系统版本',
    ]);
  });
});

describe('首次配置这一档', () => {
  it('点开就是真的配置界面，不是占位', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('tab', { name: '首次配置' }));

    expect(await screen.findByText(/配置这台机器/u)).toBeInTheDocument();
  });
});

describe('系统版本这一档', () => {
  it('点开就有版本与更新，不用再滚', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('tab', { name: '系统版本' }));

    expect(await screen.findByRole('heading', { name: '版本' })).toBeInTheDocument();
  });

  it('环境档里不再放版本卡片 —— 一个东西一个位置', async () => {
    view();
    await screen.findByText('运行环境健康');
    expect(document.querySelector('.update-card')).toBeNull();
  });

  it('?tab=version 直接落到这一档 —— 托盘的「检查更新…」靠它', async () => {
    view('/settings?tab=version');
    expect(await screen.findByRole('heading', { name: '版本' })).toBeInTheDocument();
  });

  it('认不出的 tab 值忽略，不打出一个空白页', async () => {
    // URL 是用户能手改的，一个错字不该让界面看起来坏了
    view('/settings?tab=没这一档');
    expect(await screen.findByText('运行环境健康')).toBeInTheDocument();
  });
});

describe('主导航只放每天要用的', () => {
  it('首次配置不再常驻主导航', () => {
    expect(NAV_ITEMS.map((item) => item.label)).not.toContain('首次配置');
  });

  it('但 /onboarding 路由还在 —— 首次启动要能直达，旧链接不该断', async () => {
    const { PAGES } = await import('../src/pages/index.js');
    expect(PAGES.some((page) => page.path === '/onboarding')).toBe(true);
  });

  it('主导航是这七项', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      '概览与工作流',
      '工作流编辑器',
      '执行记录',
      '记忆',
      'Agent 角色',
      '提示词库',
      '模型',
      '设置与环境',
    ]);
  });
});

describe('托盘跳转', () => {
  it('桌面壳 emit 的是设置的版本档，不是光跳 /settings', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const 桌面壳 = readFileSync(join(process.cwd(), 'apps/desktop/src-tauri/src/lib.rs'), 'utf8');
    const emit行 = 桌面壳.split('\n').find((行) => 行.includes('emit("navigate"'));

    // 只跳 /settings 会停在默认档，用户还得自己找，等于没跳
    expect(emit行).toContain('/settings?tab=version');
  });

  it('前端接了 navigate 事件 —— 在此之前它 emit 出去没人听', async () => {
    const module = await import('../src/layout/useTrayNavigation.js');
    expect(typeof module.useTrayNavigation).toBe('function');
  });
});
