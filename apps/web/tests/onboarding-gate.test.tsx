import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type * as RouterModule from 'react-router';

/**
 * 首次配置：目录能选能改、权限逐项申请与检查、**配完之前进不去应用**。
 *
 * 在这之前这一屏是软的：工作目录写死在源码里（`DEFAULT_WORKDIR`），
 * 用户改不了；macOS 权限一项都没碰；拦截只在 `pathname === '/'` 时生效，
 * 还有一个「先跳过」按钮。
 *
 * 而 ad-hoc 签名下 TCC 授权**活不过一次更新**（designated requirement 是
 * cdhash 精确匹配，实测见 docs/MACOS-PERMISSIONS.md）——
 * 所以这一屏不是「首次配置」，是「版本变化后重新验」。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

/** 桌面能力：挑目录与通知权限。默认按桌面形态答，用例各自改。 */
const pickDirectory = vi.fn<() => Promise<string | null>>();
const readNotificationPermission = vi.fn<() => Promise<string>>();
const requestNotificationPermission = vi.fn<() => Promise<string>>();
const canPickDirectory = vi.fn<() => boolean>();
vi.mock('../src/onboarding/platform.js', () => ({
  pickDirectory: () => pickDirectory(),
  readNotificationPermission: () => readNotificationPermission(),
  requestNotificationPermission: () => requestNotificationPermission(),
  canPickDirectory: () => canPickDirectory(),
  NOTIFICATION_SETTINGS_URL: 'x-apple.systempreferences:com.apple.preference.notifications',
}));

const { createContractCall } = await import('./_contractClient.js');
const { OnboardingPage } = await import('../src/onboarding/OnboardingPage.js');

const 全就绪 = {
  ready: true,
  items: [
    {
      capability: 'git',
      label: 'Git',
      version: '2.50.1',
      path: '/usr/bin/git',
      source: 'system',
      status: 'ready',
    },
    {
      capability: 'acp.codex',
      label: 'Codex（ACP）',
      version: '0.1.0',
      path: '/usr/local/bin/codex-acp',
      source: 'system',
      status: 'ready',
    },
  ],
};

const 好目录 = {
  resolved: '/Users/luca/aiwf',
  exists: true,
  writable: true,
  isGitRepo: false,
  tccProtected: false,
};

function respond(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const checked = createContractCall({
    'env.health': () => 全就绪,
    'env.checkDirectory': () => 好目录,
    'workspace.settings': () => ({}),
    'workspace.updateSettings': () => ({ ok: true }),
    'env.diagnostics': () => ({ path: '/tmp/d.json', bytes: 1 }),
    ...handlers,
  });
  call.mockImplementation((method: string, input: unknown) => checked(method, input));
}

let navigated: string[] = [];
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>();
  return { ...actual, useNavigate: () => (to: string) => navigated.push(to) };
});

beforeEach(() => {
  call.mockReset();
  respond();
  navigated = [];
  pickDirectory.mockReset().mockResolvedValue('/Users/luca/aiwf');
  readNotificationPermission.mockReset().mockResolvedValue('granted');
  requestNotificationPermission.mockReset().mockResolvedValue('granted');
  canPickDirectory.mockReset().mockReturnValue(true);
});

const view = () =>
  render(
    <MemoryRouter>
      <OnboardingPage />
    </MemoryRouter>,
  );

describe('工作目录能选能改', () => {
  it('显示当前会写到哪，而不是一句笼统的说明', async () => {
    view();
    // 用户要能确认自己选的是哪个目录 —— 光说「应用数据目录」等于没说
    expect(await screen.findByLabelText('工作目录')).toBeTruthy();
  });

  it('点「选择」走原生面板 —— 那一步本身就是一次授权', async () => {
    // NSOpenPanel 走 macOS 的 powerbox：用户在面板里选中的路径，
    // 系统直接授权给 App，即使它在 ~/Documents 下也不会再弹窗。
    // 手输路径拿不到这个授权
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));

    expect(pickDirectory).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText('工作目录')).toHaveValue('/Users/luca/aiwf');
    });
  });

  it('选完立刻真探测一次，不是只把路径显示出来', async () => {
    // stat 说得出「存在」，说不出「你有没有权限往里写」——
    // 而 TCC 挡住的目录恰恰是后者
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('env.checkDirectory', { path: '/Users/luca/aiwf' });
    });
  });

  it('目录写不进去时说清原因，并且不让往下走', async () => {
    respond({
      'env.checkDirectory': () => ({
        ...好目录,
        writable: false,
        message: '这个目录写不进去（权限被拒）。到「系统设置 → 隐私与安全性」里授权',
      }),
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));

    expect(await screen.findByText(/写不进去/u)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).toBeDisabled();
    });
  });

  it('落在 TCC 保护区时提前说这条授权活不过一次更新', async () => {
    // ad-hoc 签名下 App 一更新 cdhash 就变，上一版的授权不再适用。
    // 不提前说的话，用户下次跑工作流时撞上 EPERM，而报错完全不提 TCC
    respond({ 'env.checkDirectory': () => ({ ...好目录, tccProtected: true }) });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));

    expect(await screen.findByText(/更新.*重新授权|重新授权.*更新/u)).toBeTruthy();
  });

  it('Web 形态退化成手输，并说清拿不到那次授权', async () => {
    canPickDirectory.mockReturnValue(false);
    view();

    expect(await screen.findByLabelText('工作目录')).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /选择/u })).toBeNull();
  });
});

describe('macOS 权限', () => {
  it('通知没问过时给一个申请按钮', async () => {
    readNotificationPermission.mockResolvedValue('default');
    const user = userEvent.setup();
    view();

    await user.click(await screen.findByRole('button', { name: /允许通知|申请/u }));
    expect(requestNotificationPermission).toHaveBeenCalled();
  });

  it('通知被拒过时不再给申请按钮 —— 那个框系统不会再弹', async () => {
    // 给按钮的话，用户会一直点一个什么都不会发生的东西
    readNotificationPermission.mockResolvedValue('denied');
    view();

    // 给的是一条深链（点了会打开系统设置），不是一个什么都不会发生的按钮
    expect(await screen.findByRole('link', { name: /系统设置/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /允许通知|申请/u })).toBeNull();
  });

  it('通知是可选的 —— 没授权也能进应用', async () => {
    // 用户可能压根不用 notify 节点。为一个可选能力把人堵在门口，
    // 他会去找绕过的办法
    readNotificationPermission.mockResolvedValue('denied');
    view();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });
  });
});

describe('必需项没齐就不放行', () => {
  it('工具缺失时按钮禁用，并说明缺什么', async () => {
    respond({
      'env.health': () => ({
        ready: false,
        items: [
          {
            capability: 'git',
            label: 'Git',
            source: 'missing',
            status: 'missing',
            detail: 'worktree 与 PR 都要它',
            installHint: { command: 'xcode-select --install', source: 'macOS' },
          },
        ],
      }),
    });
    view();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).toBeDisabled();
    });
    // 命令在两处出现（行内提示 + 底部命令清单）—— 两处都该有
    expect((await screen.findAllByText(/xcode-select --install/u)).length).toBeGreaterThan(0);
  });

  it('配齐之后写进设置再跳走 —— 不是只跳走', async () => {
    // 之前那个「跳过」只写了个 localStorage 就 navigate，
    // 于是顶栏仍写「尚未授权工作目录」，而用户刚刚明明点过按钮
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /开始使用/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'workspace.updateSettings',
        expect.objectContaining({ workdir: '/Users/luca/aiwf' }),
      );
    });
    expect(navigated).toContain('/');
  });

  it('写设置失败就留在这一屏', async () => {
    // 跳走的话用户看到的还是「尚未授权」，而他刚刚明明点过按钮 ——
    // 那种不一致会让人怀疑整个应用
    respond({
      'workspace.updateSettings': () => {
        throw new Error('数据库忙');
      },
    });
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /开始使用/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库忙');
    expect(navigated).toEqual([]);
  });

  it('没有「先跳过」这个出口', async () => {
    // 引导完成之前不允许进入应用 —— 这是产品决定。
    // 带着一个写不进去的工作目录进主界面，第一次运行才发现，
    // 那时用户已经配了半条工作流
    view();
    await screen.findByRole('button', { name: /开始使用/u });

    expect(screen.queryByRole('button', { name: /跳过/u })).toBeNull();
  });
});

describe('目录不存在时给「创建」出口', () => {
  // 首次启动的真实形态：默认工作目录 ~/Library/Application Support/AI Workflows
  // 还没建过。只报「不存在」不给出路的话，「开始使用」永远灰着，
  // 用户只能去应用外面手动 mkdir —— 那就是用户报的「被配置页拦截，
  // 不知道缺什么」
  const 缺的目录 = {
    resolved: '/Users/luca/Library/Application Support/AI Workflows',
    exists: false,
    writable: false,
    isGitRepo: false,
    tccProtected: false,
    message: '这个目录不存在：/Users/luca/Library/Application Support/AI Workflows',
  };

  it('探测报「不存在」时出现创建按钮 —— 不能只报错不给出路', async () => {
    respond({ 'env.checkDirectory': () => 缺的目录 });
    view();

    expect(await screen.findByRole('button', { name: /创建这个目录/u })).toBeTruthy();
  });

  it('点创建调 env.createDirectory，成功后解锁「开始使用」', async () => {
    respond({
      'env.checkDirectory': () => 缺的目录,
      'env.createDirectory': () => ({
        resolved: 缺的目录.resolved,
        exists: true,
        writable: true,
        isGitRepo: false,
        tccProtected: false,
      }),
    });
    const user = userEvent.setup();
    view();

    await user.click(await screen.findByRole('button', { name: /创建这个目录/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('env.createDirectory', {
        path: expect.stringContaining('AI Workflows'),
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });
    // 目录已经在了，按钮不该留着
    expect(screen.queryByRole('button', { name: /创建这个目录/u })).toBeNull();
  });

  it('目录存在但写不进去时不给创建按钮 —— 创建解决不了权限', async () => {
    respond({
      'env.checkDirectory': () => ({
        ...好目录,
        writable: false,
        message: '这个目录写不进去（权限被拒）',
      }),
    });
    view();

    await screen.findByText(/写不进去/u);
    expect(screen.queryByRole('button', { name: /创建这个目录/u })).toBeNull();
  });

  it('创建失败时把原因摆出来，按钮还在', async () => {
    respond({
      'env.checkDirectory': () => 缺的目录,
      'env.createDirectory': () => ({
        ...缺的目录,
        message: '这个目录建不出来（权限被拒）。换一个位置',
      }),
    });
    const user = userEvent.setup();
    view();

    await user.click(await screen.findByRole('button', { name: /创建这个目录/u }));

    expect(await screen.findByText(/建不出来/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /创建这个目录/u })).toBeTruthy();
  });
});

describe('重新检查要有看得见的回执', () => {
  // 第三方巡检 A-02：点「重新检查」，网络确实发了 env_health，
  // 但页面 10 秒内零变化 —— 结果没变时界面也没变，用户只会以为按钮坏了。
  // 对照组：同一个按钮在「运行环境与工具」档上会更新侧栏的「上次检查」

  it('检查完给出「刚刚检查过」的时间回执', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '重新检查' }));

    expect(
      await screen.findByText(/刚检查过/u),
      '结果没变时界面毫无反应，用户以为按钮坏了',
    ).toBeTruthy();
  });

  it('检查完把时间记进设置 —— 侧栏那行「上次检查」要跟着动', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: '重新检查' }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'workspace.updateSettings',
        expect.objectContaining({ envCheckedAt: expect.any(String) }),
      );
    });
  });

  it('只有一个检查入口 —— 两个按钮干同一件事会让人以为它们不一样', () => {
    view();
    expect(screen.queryByRole('button', { name: /仅检测，不安装/u })).toBeNull();
  });
});

describe('灰着的按钮要说清还差哪几项', () => {
  it('缺工具时点名缺的是什么，不是一个数字', async () => {
    // 「还差 2 项必需工具」要求用户自己回到上面逐行找红的 ——
    // 而在小窗口里那几行可能在滚动区外。点名的话一眼就知道
    respond({
      'env.health': () => ({
        ready: false,
        items: [
          {
            capability: 'git',
            label: 'Git',
            source: 'missing',
            status: 'missing',
            installHint: { command: 'xcode-select --install', source: 'macOS' },
          },
        ],
      }),
    });
    view();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).toBeDisabled();
    });
    const foot = document.querySelector('.onboarding__foot');
    expect(foot?.textContent, '底栏要点名缺的工具').toMatch(/还差.*Git/u);
  });
});

describe('审批档要在这里选', () => {
  it('三档都列出来，默认最严那一档', async () => {
    view();
    const region = await screen.findByRole('radiogroup', { name: '审批策略' });
    expect(region).toBeTruthy();
  });

  it('选的那一档跟着写进设置', async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByRole('button', { name: /选择/u }));
    await user.click(await screen.findByRole('radio', { name: /无人值守/u }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /开始使用/u })).not.toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: /开始使用/u }));

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith(
        'workspace.updateSettings',
        expect.objectContaining({ permissionPreset: 'unattended' }),
      );
    });
  });
});
