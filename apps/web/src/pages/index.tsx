import type { ReactElement, ReactNode } from 'react';
import { NAV_ITEMS } from '../navigation.js';
import { EditorPage } from '../editor/EditorPage.js';
import { OverviewPage } from './OverviewPage.js';
import { RunsPage } from '../runs/RunsPage.js';
import { ModelsPage } from '../models/ModelsPage.js';
import { AgentsPage } from '../agents/AgentsPage.js';
import { PromptsPage } from '../prompts/PromptsPage.js';
import { PlaceholderPage } from './PlaceholderPage.js';
import { SettingsPage } from './SettingsPage.js';

/**
 * 路由表。
 *
 * 每一屏配上它所属的里程碑（ROADMAP.md），页面本身就说明了「什么时候有」。
 * M1 起各屏逐个替换成真实实现，路由结构不变。
 */
const MILESTONES: Record<string, string> = {
  '/': 'M1 · 设计态',
  '/editor': 'M1 · 设计态',
  '/runs': 'M2 · 执行态',
  '/memory': 'M4 · 主管 AI 与记忆',
  '/agents': 'M3 · AI 能力',
  '/prompts': 'M3 · AI 能力',
  '/models': 'M3 · AI 能力',
  '/settings': 'M5 · 可交付',
  '/onboarding': 'M5 · 可交付',
};

export interface PageRoute {
  path: string;
  element: ReactElement;
}

/** 已经有真实内容的屏：其余仍是骨架。 */
const REAL_CONTENT: Record<string, ReactNode> = {
  '/settings': <SettingsPage />,
};

/** 整屏自绘（不套 PlaceholderPage 的标题结构）。 */
const FULL_SCREENS: Record<string, ReactElement> = {
  '/': <OverviewPage />,
  '/editor': <EditorPage />,
  '/runs': <RunsPage />,
  '/models': <ModelsPage />,
  '/agents': <AgentsPage />,
  '/prompts': <PromptsPage />,
};

/** 需要额外注册带参数的子路由的屏。 */
const EXTRA_ROUTES: readonly PageRoute[] = [
  // 编辑器要拿到工作流 id；不带 id 时显示「先选一个工作流」
  { path: '/editor/:workflowId', element: <EditorPage /> },
];

const BASE_PAGES: readonly PageRoute[] = NAV_ITEMS.map((item) => ({
  // 除首页外都按前缀匹配，方便后续挂子路由（/runs/:runId 等）
  path: item.path === '/' ? '/' : `${item.path}/*`,
  element: FULL_SCREENS[item.path] ?? (
    <PlaceholderPage
      title={item.label}
      summary={item.summary}
      milestone={MILESTONES[item.path] ?? 'M1'}
    >
      {REAL_CONTENT[item.path]}
    </PlaceholderPage>
  ),
}));

// 带参数的路由要排在前缀路由之前，否则会被 /editor/* 抢先匹配
export const PAGES: readonly PageRoute[] = [...EXTRA_ROUTES, ...BASE_PAGES];
