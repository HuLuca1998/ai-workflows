/**
 * 主导航条目。顺序与功能文档 §2「菜单总览」一致——
 * 这既是信息架构，也是新人理解产品的顺序：先找得到工作流，再设计、再看执行。
 *
 * 图标用 Phosphor（设计系统指定），本地打包引入而不是 CDN：
 * 桌面形态的 CSP 只放行同源，外链字体会被拦掉。
 */
export interface NavItem {
  path: string;
  label: string;
  /** Phosphor 图标类名。 */
  icon: string;
  summary: string;
  /** 徽标读哪种计数；由真实数据填充，为 0 时不显示。 */
  badge?: 'waitingApproval' | 'activeRuns';
  /**
   * 不出现在侧栏，但路由与面包屑仍然靠这条登记。
   * 编辑器就是这样：它总是针对某个工作流，从列表点进去 ——
   * 一个直点进去只会说「先去别处选工作流」的常驻入口没有意义。
   */
  hidden?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: '/',
    label: '概览与工作流',
    icon: 'ph-squares-four',
    summary: '找到、创建、了解全部工作流的当前状态',
    badge: 'waitingApproval',
  },
  {
    path: '/editor',
    label: '工作流编辑器',
    icon: 'ph-flow-arrow',
    summary: '设计与维护流程',
    hidden: true,
  },
  {
    path: '/runs',
    label: '执行记录',
    icon: 'ph-list-checks',
    summary: '看清每一次运行发生了什么',
    badge: 'activeRuns',
  },
  { path: '/memory', label: '记忆', icon: 'ph-brain', summary: '管理长期上下文' },
  { path: '/agents', label: 'Agent 角色', icon: 'ph-robot', summary: '复用 AI 人格与权限' },
  {
    path: '/prompts',
    label: '提示词库',
    icon: 'ph-quotes',
    summary: '系统调用 AI 的每一处提示词都可见可改',
  },
  { path: '/models', label: '模型', icon: 'ph-cpu', summary: '统一登记可用模型' },
  /**
   * 首次配置与系统版本**不在这里** —— 它们是设置页左栏的两档
   * （见 `docs/adr/0010-settings-holds-setup-and-version.md`）。
   *
   * 图纸的导航里有「首次配置」，撤掉它是有意的：那一屏装完就不再进，
   * 常驻在主导航里占的是一个每天都要扫过的位置。`/onboarding` 路由
   * 保留 —— 首次启动仍要能直达。
   */
  { path: '/settings', label: '设置与环境', icon: 'ph-gear', summary: '运行环境健康与权限策略' },
] as const;

/** 主导航在窗口窄于这个宽度时收成图标栏（屏幕清单 §11）。 */
export const NAV_COLLAPSE_WIDTH = 1360;

export function navItemForPath(pathname: string): NavItem | undefined {
  if (pathname === '/') return NAV_ITEMS[0];
  return NAV_ITEMS.find((item) => item.path !== '/' && pathname.startsWith(item.path));
}
