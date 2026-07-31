import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { APPROVAL_MODES, APPROVAL_MODE_LABELS } from '@aiwf/contracts';

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
    'workspace.settings': () => ({ permissionPreset: 'ai_assisted' }),
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

const view = () =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );

describe('左侧分组导航', () => {
  it('中间只列有内容的档 —— 空壳分节已撤(S5)', async () => {
    // 首尾各多一档（首次配置 / 系统版本），
    // 见 docs/adr/0010-settings-holds-setup-and-version.md。
    // 完整顺序由 settings-tabs.test.tsx 守
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    const labels = within(nav)
      .getAllByRole('tab')
      .map((el) => el.textContent);

    expect(labels.slice(1, -1)).toEqual(['运行环境与工具', 'MCP 与集成', '安全与隐私', '高级']);
  });

  it('默认停在「运行环境与工具」—— 图纸画的就是这一档', async () => {
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    const active = within(nav)
      .getAllByRole('tab')
      .find((el) => el.getAttribute('aria-selected') === 'true');

    expect(active?.textContent).toBe('运行环境与工具');
  });

  it('空壳分节不再出现在导航里', async () => {
    // 曾经的做法是留着空档并写「还没有可配置的项」——
    // 连点四个空壳更像骨架而不是诚实(第 1 轮实测 S5,用户指示撤掉)
    view();
    const nav = await screen.findByRole('tablist', { name: '设置分组' });
    for (const gone of ['通用', 'AI 与 Agent', 'Git 与 GitHub', '通知']) {
      expect(within(nav).queryByRole('tab', { name: gone })).toBeNull();
    }
  });
});

describe('审批三档', () => {
  it('三张卡的文案取自契约，不在界面里另抄一份', async () => {
    // 抄一份的代价是：改了其中一处文案，设置页、引导页、侧栏
    // 会向用户承诺三件不同的事。这条断言的是「显示的就是契约里那份」
    view();
    const region = await screen.findByRole('radiogroup', { name: '审批策略' });

    for (const mode of APPROVAL_MODES) {
      const card = APPROVAL_MODE_LABELS[mode];
      expect(within(region).getByText(card.name), `${mode} 的名字没显示`).toBeTruthy();
      expect(within(region).getByText(card.detail), `${mode} 的说明没显示`).toBeTruthy();
    }
  });

  it('当前那档被标出来 —— 用户得看得见自己现在授权到什么程度', async () => {
    view();
    await waitFor(() => {
      expect(
        screen.getByRole('radio', { name: new RegExp(APPROVAL_MODE_LABELS.ai_assisted.name, 'u') }),
      ).toBeChecked();
    });
  });

  it('选另一档会写进设置', async () => {
    const user = userEvent.setup();
    view();
    await waitFor(() => {
      expect(
        screen.getByRole('radio', { name: new RegExp(APPROVAL_MODE_LABELS.ai_assisted.name, 'u') }),
      ).toBeChecked();
    });

    await user.click(
      screen.getByRole('radio', {
        name: new RegExp(APPROVAL_MODE_LABELS.human_approval.name, 'u'),
      }),
    );

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('workspace.updateSettings', {
        permissionPreset: 'human_approval',
      });
    });
  });

  it('一档都没选过时按最严的显示 —— 引擎也是这么办的', async () => {
    respond({ 'workspace.settings': () => ({}) });
    view();

    await waitFor(() => {
      expect(
        screen.getByRole('radio', {
          name: new RegExp(APPROVAL_MODE_LABELS.human_approval.name, 'u'),
        }),
      ).toBeChecked();
    });
  });

  it('每一档都能被选中显示 —— 不只是默认那一档', async () => {
    // 旧档位名的迁移在**后端读取出口**做（core-api 的 workspace_settings），
    // 所以前端拿到的永远是新值。这里验的是三档都认得，
    // 而不是只有默认那一档能亮
    for (const mode of APPROVAL_MODES) {
      respond({ 'workspace.settings': () => ({ permissionPreset: mode }) });
      const { unmount } = view();
      await waitFor(() => {
        expect(
          screen.getByRole('radio', { name: new RegExp(APPROVAL_MODE_LABELS[mode].name, 'u') }),
        ).toBeChecked();
      });
      unmount();
    }
  });

  it('说清这一档对运行的实际影响 —— 否则用户不知道选了会怎样', async () => {
    view();
    const region = await screen.findByRole('radiogroup', { name: '审批策略' });
    const 整块 = region.parentElement?.textContent ?? '';
    // 点名这三档最容易被误解的两处：管的是「门由谁批」而不是
    // 「哪些操作被拦」，以及没放门就一路跑到底
    expect(整块).toMatch(/由谁批|审批.*节点/u);
    expect(整块).toMatch(/一路跑到底|没放审批节点/u);
  });

  it('写失败时说明原因，并且不留一个假的选中态', async () => {
    respond({
      'workspace.settings': () => ({ permissionPreset: 'ai_assisted' }),
      'workspace.updateSettings': () => {
        throw new Error('数据库忙');
      },
    });
    const user = userEvent.setup();
    view();
    const 中间档 = new RegExp(APPROVAL_MODE_LABELS.ai_assisted.name, 'u');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 中间档 })).toBeChecked();
    });

    await user.click(
      screen.getByRole('radio', { name: new RegExp(APPROVAL_MODE_LABELS.unattended.name, 'u') }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库忙');
    expect(screen.getByRole('radio', { name: 中间档 })).toBeChecked();
  });
});
