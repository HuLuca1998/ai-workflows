import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 同一块设置不能在三个分档里各出现一次。
 *
 * 第三方巡检 A-05 实测：「谁来审批」这张单选卡在「首次配置」「运行环境与工具」
 * 「安全与隐私」三档里**逐字相同**地出现了三次；而「安全与隐私」这个名字
 * 底下除了它什么都没有 —— 隐私相关内容一个字都没提。
 *
 * 用户点开三档看到同一样东西，会怀疑自己是不是点错了，
 * 也不知道改哪一份才算数（其实都算，是同一个后端字段）。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { SettingsPage } = await import('../src/pages/SettingsPage.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'workspace.settings': () => ({ workdir: '/tmp/ws', permissionPreset: 'human_approval' }),
    'env.health': () => ({ ready: true, items: [] }),
    'env.checkDirectory': () => ({
      resolved: '/tmp/ws',
      exists: true,
      writable: true,
      isGitRepo: false,
      tccProtected: false,
    }),
    'workspace.updateSettings': () => ({ ok: true }),
    'workspace.stats': () => ({
      workflows: 0,
      runsActive: 0,
      runsTotal: 0,
      pendingApprovals: 0,
      runsToday: 0,
      runsTodaySucceeded: 0,
      activeWorktrees: 0,
      worktreeBytes: 0,
    }),
    'mcp.status': () => ({ running: false, url: '', clients: [] }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

const 打开 = async (tab: string) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[`/settings?tab=${tab}`]}>
      <SettingsPage />
    </MemoryRouter>,
  );
  return user;
};

describe('审批档只在该在的地方出现', () => {
  it('「运行环境与工具」里没有审批档 —— 那一档说的是这台机器有什么', async () => {
    await 打开('env');
    expect(
      screen.queryByRole('radiogroup', { name: '审批策略' }),
      '审批策略与「环境与工具」无关，放这里只是第三份拷贝',
    ).toBeNull();
  });

  it('「安全与隐私」里有审批档 —— 那是它的正主', async () => {
    await 打开('security');
    expect(await screen.findByRole('radiogroup', { name: '审批策略' })).toBeTruthy();
  });
});

describe('「安全与隐私」要名副其实', () => {
  it('说清 Secret 存在哪 —— 这是这一档名字里的「安全」', async () => {
    await 打开('security');
    // keychain 是这个应用真实的凭据策略（契约里 credRef 只收 keychain:// 引用）
    expect(document.body.textContent).toMatch(/Keychain|钥匙串/u);
  });

  it('说清脱敏发生在哪几处 —— 这是名字里的「隐私」', async () => {
    await 打开('security');
    expect(document.body.textContent).toMatch(/脱敏/u);
  });
});
