import type { ReactNode } from 'react';

export interface PlaceholderPageProps {
  title: string;
  summary: string;
  /** 这一屏在哪个里程碑做完，直接写在页面上，避免团队反复确认。 */
  milestone: string;
  children?: ReactNode;
}

/**
 * 骨架页。M0 的外壳阶段每屏只有标题、说明与交付计划——
 * 与其画假数据，不如把「还没做」写清楚。
 */
export function PlaceholderPage({ title, summary, milestone, children }: PlaceholderPageProps) {
  return (
    <article className="page">
      <header className="page__head">
        <h1>{title}</h1>
        <p className="page__summary">{summary}</p>
      </header>
      <div className="page__body">
        {children ?? (
          <p className="page__todo">
            这一屏在 <strong>{milestone}</strong> 落地。当前是 M0 应用外壳阶段。
          </p>
        )}
      </div>
    </article>
  );
}
