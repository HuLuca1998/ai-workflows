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
      // 「首次配置」不在这里了 —— 它是设置页左栏的第一档
      // （docs/adr/0010-settings-holds-setup-and-version.md）。
      // 主导航放每天都要用的，装机时走一遍的东西不该常驻。
      // `/onboarding` 路由仍在，首次启动照样直达
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

  it('提供询问 AI 入口并标注快捷键 —— 按平台写，Windows 上没有 ⌘ 这个键', () => {
    // jsdom 默认既不是 mac 也不是 win，这里显式说清楚测的是哪一边
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    renderShell();
    expect(screen.getByRole('button', { name: /询问 AI/u })).toHaveTextContent('⌘K');
  });

  it('非 macOS 上标 Ctrl+K —— 键盘处理本来就同时认 ctrlKey', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    Object.defineProperty(navigator, 'userAgent', { value: 'Win32', configurable: true });
    renderShell();
    expect(screen.getByRole('button', { name: /询问 AI/u })).toHaveTextContent('Ctrl+K');
  });
});

describe('主管 AI 抽屉', () => {
  it('默认关闭', () => {
    renderShell();
    expect(screen.queryByRole('dialog', { name: '主管 AI' })).toBeNull();
  });

  it('⌘K 打开，再按一次收起', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: '主管 AI' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: '主管 AI' })).toBeNull();
  });

  it('Esc 关闭抽屉', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '主管 AI' })).toBeNull();
  });

  it('抽屉底部常驻本次会话授予的 Scope——用户随时看得到 AI 能做什么', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const drawer = screen.getByRole('dialog', { name: '主管 AI' });
    expect(within(drawer).getByText(/workflow:read/u)).toBeInTheDocument();
    // 末尾那句说的是当下的实情，不是一句写死的话。
    // 读不到权限档时按最严的一档说 —— 与引擎那边一致
    expect(within(drawer).getByText(/需逐项确认/u)).toBeInTheDocument();
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
    // 这几屏在图纸里是并列分栏，每栏有自己的小标题，页面级不存在大标题；
    // 硬塞一个会偏离图纸，可识别名由各栏的 aria-label 承担
    // 这几屏在图纸里是并列分栏，每栏有自己的小标题，页面级不存在大标题。
    // 设置屏同样：图纸左栏是「设置」分组导航，右侧第一个标题是 h4
    //「运行环境健康」——硬塞一个 h1 会偏离图纸
    const SELF_DRAWN_WITHOUT_H1 = new Set(['/runs', '/models', '/agents', '/prompts', '/settings']);

    // 图纸给的标题：概览是「工作流」不是菜单名「概览与工作流」，
    // 记忆是「记忆管理」不是「记忆」
    const SELF_DRAWN_TITLES: Record<string, string> = {
      '/': '工作流',
      '/memory': '记忆管理',
      // 图纸「06 首次安装与检测」的大标题就是这句
      '/onboarding': '环境检测与依赖补齐',
    };

    for (const item of NAV_ITEMS.filter((nav) => !SELF_DRAWN_WITHOUT_H1.has(nav.path))) {
      const { unmount } = renderShell(item.path);
      const heading = screen.getByRole('heading', { level: 1 });
      // 自绘整屏的标题按图纸走，与菜单名不一定相同；
      // 其余骨架页的标题等于菜单名
      const expected = SELF_DRAWN_TITLES[item.path] ?? item.label;
      expect(heading.textContent?.trim()).toBe(expected);
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
