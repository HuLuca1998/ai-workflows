import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 设置与环境 —— 图纸「05 设置与环境」。
 *
 * 图纸这一屏是左右两栏：左边 184px 的 8 个分组导航，
 * 右边「运行环境健康」+「权限策略」三张卡。
 *
 * 权限档之前没做，理由是「界面能选而引擎不按档位拦截就是假的安全感」。
 * 现在引擎真的按档位办事了（review_every_change 下有副作用的节点
 * 先挂起等审批），那个理由不再成立。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return { ...actual, coreClient: { call: (m: string, i: unknown) => call(m, i) } };
});

import type * as WorkspaceModule from '../src/data/workspace.js';

const { createContractCall } = await import('./_contractClient.js');
const { SettingsPage } = await import('../src/pages/SettingsPage.js');

const HEALTH = {
  ready: true,
  items: [
    {
      capability: 'git',
      label: 'Git',
      version: '2.45.1',
      path: '/usr/bin/git',
      source: 'system',
      status: 'ready',
    },
  ],
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'env.health': () => HEALTH,
    'workspace.settings': () => ({ permissionPreset: 'workspace_safe' }),
    'workspace.updateSettings': () => ({ ok: true }),
    'env.diagnostics': () => ({ path: '/tmp/env-diagnostics.json', bytes: 2048 }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

beforeEach(() => {
  call.mockReset();
  respond();
});

const view = () => render(<SettingsPage />);

describe('左侧分组导航照图纸', () => {
  it('八个分组，顺序与文案都照图纸', async () => {
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    const labels = within(nav)
      .getAllByRole('tab')
      .map((el) => el.textContent);

    expect(labels).toEqual([
      '通用',
      'AI 与 Agent',
      'Git 与 GitHub',
      '运行环境与工具',
      'MCP 与集成',
      '通知',
      '安全与隐私',
      '高级',
    ]);
  });

  it('默认停在「运行环境与工具」—— 图纸画的就是这一档', async () => {
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    const active = within(nav)
      .getAllByRole('tab')
      .find((el) => el.getAttribute('aria-selected') === 'true');

    expect(active?.textContent).toBe('运行环境与工具');
  });

  it('还没做的分组照实说，不留一片空白', async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText('运行环境健康');

    await user.click(screen.getByRole('tab', { name: 'Git 与 GitHub' }));
    expect(await screen.findByText(/还没有可配置的项/u)).toBeTruthy();
  });
});

describe('权限策略三档', () => {
  it('三张卡照图纸，文案一字不差', async () => {
    view();
    const region = await screen.findByRole('radiogroup', { name: '权限策略' });

    expect(within(region).getByText('Review Every Change')).toBeTruthy();
    expect(
      within(region).getByText('文件写入、命令与外部写操作逐项审批。适合陌生工作流。'),
    ).toBeTruthy();
    expect(
      within(region).getByText('授权目录内可读写与执行已声明命令；Push、PR、删除仍需审批。'),
    ).toBeTruthy();
    expect(
      within(region).getByText('对指定已发布版本沿用保存策略；权限扩大后自动失效。'),
    ).toBeTruthy();
  });

  it('当前那档被标出来 —— 用户得看得见自己现在授权到什么程度', async () => {
    view();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Workspace Safe/u })).toBeChecked();
    });
  });

  it('选另一档会写进设置', async () => {
    const user = userEvent.setup();
    view();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Workspace Safe/u })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Review Every Change/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('workspace.updateSettings', {
        permissionPreset: 'review_every_change',
      });
    });
  });

  it('一档都没选过时按最严的显示 —— 引擎也是这么办的', async () => {
    respond({ 'workspace.settings': () => ({}) });
    view();

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Review Every Change/u })).toBeChecked();
    });
  });

  it('说清这一档对运行的实际影响 —— 否则用户不知道选了会怎样', async () => {
    view();
    const region = await screen.findByRole('radiogroup', { name: '权限策略' });
    expect(region.textContent).toMatch(/挂起|审批/u);
  });

  it('写失败时说明原因，并且不留一个假的选中态', async () => {
    respond({
      'workspace.settings': () => ({ permissionPreset: 'workspace_safe' }),
      'workspace.updateSettings': () => {
        throw new Error('数据库忙');
      },
    });
    const user = userEvent.setup();
    view();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Workspace Safe/u })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Trusted Workflow/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库忙');
    expect(screen.getByRole('radio', { name: /Workspace Safe/u })).toBeChecked();
  });
});
