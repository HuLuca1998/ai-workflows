import type { ReactElement } from 'react';
import { NAV_ITEMS } from '../navigation.js';
import { EditorPage } from '../editor/EditorPage.js';
import { OverviewPage } from './OverviewPage.js';
import { RunsPage } from '../runs/RunsPage.js';
import { ModelsPage } from '../models/ModelsPage.js';
import { AgentsPage } from '../agents/AgentsPage.js';
import { PromptsPage } from '../prompts/PromptsPage.js';
import { MemoryPage } from '../memory/MemoryPage.js';
import { OnboardingPage } from '../onboarding/OnboardingPage.js';
import { SettingsPage } from './SettingsPage.js';
import { NotFoundPage } from './NotFoundPage.js';

/**
 * 路由表。
 *
 * 每一屏配上它所属的里程碑（ROADMAP.md），页面本身就说明了「什么时候有」。
 * M1 起各屏逐个替换成真实实现，路由结构不变。
 */

export interface PageRoute {
  path: string;
  element: ReactElement;
}

/** 已经有真实内容的屏：其余仍是骨架。 */
/** 每一屏的实现。都是整屏自绘 —— 骨架页在所有屏落地之后就删了。 */
const FULL_SCREENS: Record<string, ReactElement> = {
  '/': <OverviewPage />,
  '/editor': <EditorPage />,
  '/runs': <RunsPage />,
  '/models': <ModelsPage />,
  '/agents': <AgentsPage />,
  '/prompts': <PromptsPage />,
  '/memory': <MemoryPage />,
  '/settings': <SettingsPage />,
};

/** 需要额外注册带参数的子路由的屏。 */
const EXTRA_ROUTES: readonly PageRoute[] = [
  // 编辑器要拿到工作流 id；不带 id 时显示「先选一个工作流」
  { path: '/editor/:workflowId', element: <EditorPage /> },
  // 首次配置从主导航撤走了（现在是设置里的一档），但路由留着：
  // 首次启动要能直达，收藏与文档里的旧链接也不该断
  { path: '/onboarding', element: <OnboardingPage /> },
];

const BASE_PAGES: readonly PageRoute[] = NAV_ITEMS.map((item) => ({
  // 除首页外都按前缀匹配，方便后续挂子路由（/runs/:runId 等）
  path: item.path === '/' ? '/' : `${item.path}/*`,
  // 每一屏都有真实实现了。没有实现的路径落到 NotFoundPage ——
  // 那比一个「这一屏在 Mx 落地」的骨架诚实
  element: FULL_SCREENS[item.path] ?? <NotFoundPage />,
}));

// 带参数的路由要排在前缀路由之前，否则会被 /editor/* 抢先匹配
export const PAGES: readonly PageRoute[] = [...EXTRA_ROUTES, ...BASE_PAGES];
