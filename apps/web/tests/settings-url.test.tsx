import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { SettingsPage } from '../src/pages/SettingsPage.js';

vi.mock('../src/data/workspace.js', () => ({
  coreClient: { call: () => Promise.resolve({}) },
}));

/**
 * `?tab=version` 能进不能出：托盘「检查更新…」靠它跳到版本那一档，
 * 而用户在页面里切到别的档时 URL 一动不动 —— 刷新回到默认档、
 * 把地址发给别人打开的是另一屏、浏览器后退键跳出整个设置页。
 */

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="url">{location.search}</span>
      {/* MemoryRouter 有自己的内存历史，不响应 window.history.back() */}
      <button type="button" onClick={() => navigate(-1)}>
        后退
      </button>
    </>
  );
}

function view(initial = '/settings') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Probe />
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('设置页的档位与 URL', () => {
  it('切档后 URL 跟着走', async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('tab', { name: '系统版本' }));
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent).toContain('tab=version');
    });
  });

  it('深链进来仍然落在那一档', () => {
    view('/settings?tab=version');
    expect(screen.getByRole('tab', { name: '系统版本' })).toHaveAttribute('aria-selected', 'true');
  });

  /*
   * 这条原来只是又点了一次 tab 然后断言它被选中 —— 根本没按后退，
   * 无论 replace 还是 push 都会绿。（codex 复核指出的假阳性。）
   */
  it('后退回到上一档，而不是跳出整个设置页', async () => {
    const user = userEvent.setup();
    view('/settings?tab=version');
    await user.click(screen.getByRole('tab', { name: '通用' }));
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent).toContain('tab=general');
    });

    await user.click(screen.getByRole('button', { name: '后退' }));
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent, '后退直接离开了设置页').toContain(
        'tab=version',
      );
    });
  });

  /*
   * 方向键与点击是两件事：方向键是「翻着看」，点击是「我要去这一档」。
   * 两者都 push 的话，连按十次下箭头就往后退栈里堆十条，
   * 用户要按十次后退才出得去。
   */
  it('方向键连按不堆历史，点击才落一条', async () => {
    const user = userEvent.setup();
    view('/settings?tab=env');

    const first = screen.getByRole('tab', { name: '通用' });
    await user.click(first);
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent).toContain('tab=general');
    });

    // 从「通用」往下连按三次
    screen.getByRole('tab', { name: '通用' }).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent).not.toContain('tab=general');
    });

    /*
     * 一次后退就退出这一整串浏览，回到进来时那一档。
     *
     * 方向键用 replace 覆盖当前记录，所以那三下不会各自入栈 ——
     * 代价是它也覆盖掉了「点击通用」落下的那条。两者取其一：
     * 连按十次要按十次后退才出得去，比这个糟。
     */
    await user.click(screen.getByRole('button', { name: '后退' }));
    await waitFor(() => {
      expect(screen.getByTestId('url').textContent, '方向键把历史栈堆满了').toContain('tab=env');
    });
  });
});
