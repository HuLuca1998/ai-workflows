import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * 「系统版本」这一档不能承诺屏幕上没有的按钮。
 *
 * 第三方巡检 A-06 实测：正文写着「应用不会自动下载或自动安装 ——
 * 检查、下载、重启安装**三步都由你按**」，而整页**零个按钮**；
 * 上方的卡片又说「Web 形态由服务端更新，刷新页面即为最新」——
 * 两段话自相矛盾，用户会一直找那三个按不到的按钮。
 *
 * 那句话本身没错，它说的是**桌面形态**。错在它不分形态地常驻。
 */

vi.mock('../src/updater/backend.js', () => ({
  // Web 形态：没有 Tauri 后端
  createUpdaterBackend: () => null,
}));

const { VersionPanel } = await import('../src/settings/VersionPanel.js');

describe('Web 形态下不承诺三个按钮', () => {
  it('没有更新按钮时，也不说「三步都由你按」', () => {
    render(<VersionPanel />);
    // 前提：这一屏确实一个更新按钮都没有
    expect(
      screen.queryByRole('button', { name: /检查更新|下载|安装/u }),
      'Web 形态下不该有更新按钮 —— 有的话这条测试的前提就变了',
    ).toBeNull();

    expect(document.body.textContent, '文案承诺了三个按钮，而屏幕上一个都没有').not.toMatch(
      /三步都由你按/u,
    );
  });

  it('照实说这一形态的更新方式', () => {
    render(<VersionPanel />);
    expect(document.body.textContent).toMatch(/刷新页面|服务端更新/u);
  });
});
