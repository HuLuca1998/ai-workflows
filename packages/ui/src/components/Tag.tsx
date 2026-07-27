import type { ReactNode } from 'react';

export type TagTone = 'accent' | 'neutral' | 'outline' | 'warning' | 'danger';

export interface TagProps {
  tone?: TagTone;
  children: ReactNode;
}

/** 小标签：版本号、触发方式、能力标签。 */
export function Tag({ tone = 'neutral', children }: TagProps) {
  return (
    <span className="aiwf-tag" data-tone={tone}>
      {children}
    </span>
  );
}
