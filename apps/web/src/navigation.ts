/**
 * 主导航条目。顺序与功能文档 §2「菜单总览」一致——
 * 这既是信息架构，也是新人理解产品的顺序：先找得到工作流，再设计、再看执行。
 */
export interface NavItem {
  path: string;
  label: string;
  /** 收成图标栏时显示的符号（正式图标在 M1 换成 Phosphor）。 */
  glyph: string;
  summary: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: '概览与工作流', glyph: '◲', summary: '找到、创建、了解全部工作流的当前状态' },
  { path: '/editor', label: '工作流编辑器', glyph: '⌗', summary: '设计与维护流程' },
  { path: '/runs', label: '执行记录', glyph: '≡', summary: '看清每一次运行发生了什么' },
  { path: '/memory', label: '记忆', glyph: '◈', summary: '管理长期上下文' },
  { path: '/agents', label: 'Agent 角色', glyph: '◐', summary: '复用 AI 人格与权限' },
  {
    path: '/prompts',
    label: '提示词库',
    glyph: '❝',
    summary: '系统调用 AI 的每一处提示词都可见可改',
  },
  { path: '/models', label: '模型', glyph: '◇', summary: '统一登记可用模型' },
  { path: '/settings', label: '设置与环境', glyph: '⚙', summary: '运行环境健康与权限策略' },
  { path: '/onboarding', label: '首次配置', glyph: '◔', summary: '装好即可用' },
] as const;

/** 主导航在窗口窄于这个宽度时收成图标栏（屏幕清单 §11）。 */
export const NAV_COLLAPSE_WIDTH = 1360;

export function navItemForPath(pathname: string): NavItem | undefined {
  if (pathname === '/') return NAV_ITEMS[0];
  return NAV_ITEMS.find((item) => item.path !== '/' && pathname.startsWith(item.path));
}
