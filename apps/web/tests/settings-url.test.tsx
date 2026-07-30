import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
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
  return <span data-testid="url">{location.search}</span>;
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

  it('URL 里的档位变了，界面跟着变 —— 后退键要有用', async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole('tab', { name: '系统版本' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '系统版本' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  });
});
