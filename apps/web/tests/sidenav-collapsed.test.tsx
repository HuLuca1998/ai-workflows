import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SideNav } from '../src/layout/SideNav.js';

/**
 * 窗口窄于 1360px 时侧栏收成图标栏。收起的是**标签**，不该是**信息**：
 *
 * - 权限档整块直接不渲染 —— 用户在窄窗口下完全不知道自己开的是哪一档，
 *   而这一档决定了 AI 能不能改他的文件
 * - 环境那一行只剩一个图标，没有 title、没有可访问名 ——
 *   看到一个红色感叹号，鼠标悬上去什么都没有，读屏也念不出东西
 */

function view(collapsed: boolean) {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: collapsed ? 1200 : 1500,
  });
  const result = render(
    <MemoryRouter>
      <SideNav
        counts={{}}
        permission={{ preset: '工作区安全', detail: '可读写工作目录，命令需确认' }}
        environment={{ ok: false, text: '缺 2 项：gh、codex' }}
      />
    </MemoryRouter>,
  );
  fireEvent(window, new Event('resize'));
  return result;
}

describe('侧栏收起时', () => {
  it('权限档不消失 —— 它决定了 AI 能不能改你的文件', () => {
    view(true);
    const shield = screen.getByLabelText(/权限档/u);
    expect(shield.getAttribute('title')).toContain('工作区安全');
  });

  it('环境那一行有可访问名与 title，不是一个念不出来的图标', () => {
    view(true);
    const env = screen.getByLabelText(/环境/u);
    expect(env.getAttribute('title')).toContain('缺 2 项');
  });

  it('展开时照旧显示完整文字', () => {
    view(false);
    expect(screen.getByText('工作区安全')).toBeTruthy();
    expect(screen.getByText('缺 2 项：gh、codex')).toBeTruthy();
  });
});
