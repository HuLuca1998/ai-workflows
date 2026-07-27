import type { ReactElement } from 'react';
import { NAV_ITEMS } from '../navigation.js';
import { PlaceholderPage } from './PlaceholderPage.js';

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

export const PAGES: readonly PageRoute[] = NAV_ITEMS.map((item) => ({
  // 除首页外都按前缀匹配，方便后续挂子路由（/runs/:runId 等）
  path: item.path === '/' ? '/' : `${item.path}/*`,
  element: (
    <PlaceholderPage
      title={item.label}
      summary={item.summary}
      milestone={MILESTONES[item.path] ?? 'M1'}
    />
  ),
}));
