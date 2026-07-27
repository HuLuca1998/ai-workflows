import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppShell } from '../src/AppShell.js';
import { NAV_ITEMS } from '../src/navigation.js';

/**
 * 应用外壳：自绘标题栏 + 主导航 + 内容区 + 主管 AI 抽屉（屏幕清单 §11）。
 * 这组测试守住导航结构、响应式收起、⌘K 与 Esc 的全局约定。
 */

const renderShell = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  );

const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  fireEvent(window, new Event('resize'));
};

describe('主导航', () => {
  it('覆盖功能文档 §2 的全部菜单', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      '概览与工作流',
      '工作流编辑器',
      '执行记录',
      '记忆',
      'Agent 角色',
      '提示词库',
      '模型',
      '设置与环境',
      '首次配置',
    ]);
  });

  it('渲染出可导航的链接', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    for (const item of NAV_ITEMS) {
      expect(
        within(nav).getByRole('link', { name: new RegExp(item.label, 'u') }),
      ).toBeInTheDocument();
    }
  });

  it('当前页在语义上被标出，而不只是变个颜色', () => {
    renderShell('/runs');
    const active = screen.getByRole('link', { current: 'page' });
    expect(active).toHaveTextContent('执行记录');
  });

  it('窗口窄于 1360px 时收成图标栏，但可访问名称保留', () => {
    setWidth(1280);
    renderShell();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(nav).toHaveAttribute('data-collapsed', 'true');
    // 收起后文字隐藏，读屏仍要能报出名称
    expect(within(nav).getByRole('link', { name: /执行记录/u })).toBeInTheDocument();
  });

  it('窗口够宽时展开', () => {
    setWidth(1440);
    renderShell();
    expect(screen.getByRole('navigation', { name: '主导航' })).toHaveAttribute(
      'data-collapsed',
      'false',
    );
  });
});

describe('标题栏', () => {
  it('显示当前位置的面包屑', () => {
    renderShell('/runs');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('执行记录');
  });

  it('提供询问 AI 入口并标注快捷键', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /询问 AI/u })).toHaveTextContent('⌘K');
  });
});

describe('主管 AI 抽屉', () => {
  it('默认关闭', () => {
    renderShell();
    expect(screen.queryByRole('complementary', { name: '主管 AI' })).toBeNull();
  });

  it('⌘K 打开，再按一次收起', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('complementary', { name: '主管 AI' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('complementary', { name: '主管 AI' })).toBeNull();
  });

  it('Esc 关闭抽屉', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: '主管 AI' })).toBeNull();
  });

  it('抽屉底部常驻本次会话授予的 Scope——用户随时看得到 AI 能做什么', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const drawer = screen.getByRole('complementary', { name: '主管 AI' });
    expect(within(drawer).getByText(/workflow:read/u)).toBeInTheDocument();
    expect(within(drawer).getByText(/发布与运行未授权/u)).toBeInTheDocument();
  });
});

describe('路由', () => {
  it('根路径渲染概览页', () => {
    renderShell('/');
    // 图纸里首页的大标题是「工作流」，「概览与工作流」是菜单名
    expect(screen.getByRole('heading', { name: '工作流', level: 1 })).toBeInTheDocument();
  });

  it('未知路径给出可返回的空态，而不是白屏', () => {
    renderShell('/不存在的页面');
    expect(screen.getByText(/找不到这个页面/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /回到概览/u })).toBeInTheDocument();
  });

  it('每个菜单项都能渲染出一级标题', () => {
    // 图纸里执行记录是三栏并列，每栏有自己的小标题，页面级不存在大标题；
    // 硬塞一个会偏离图纸，它的可识别名由三个 region 的 aria-label 承担
    const SELF_DRAWN_WITHOUT_H1 = new Set(['/runs']);

    for (const item of NAV_ITEMS.filter((nav) => !SELF_DRAWN_WITHOUT_H1.has(nav.path))) {
      const { unmount } = renderShell(item.path);
      const heading = screen.getByRole('heading', { level: 1 });
      // 首页是自绘整屏（标题「工作流」），其余骨架页的标题等于菜单名
      expect(heading.textContent?.trim()).toBe(item.path === '/' ? '工作流' : item.label);
      unmount();
    }
  });

  it('执行记录的三栏各自可被辅助技术定位', () => {
    renderShell('/runs');
    for (const label of ['节点进度', '运行详情']) {
      expect(screen.getByRole('region', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('group', { name: '筛选运行' })).toBeInTheDocument();
  });
});
