import { useId, type ReactNode } from 'react';

export interface CardProps {
  title?: string;
  kicker?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 内容卡片。有标题时用 region 语义，方便读屏在区块间跳转。 */
export function Card({ title, kicker, meta, children, className }: CardProps) {
  const titleId = useId();
  return (
    <section
      className={['aiwf-card', className].filter(Boolean).join(' ')}
      {...(title ? { 'aria-labelledby': titleId } : {})}
    >
      {kicker ? <p className="aiwf-card__kicker">{kicker}</p> : null}
      {title ? (
        <h3 id={titleId} className="aiwf-card__title">
          {title}
        </h3>
      ) : null}
      <div className="aiwf-card__body">{children}</div>
      {meta ? <div className="aiwf-card__meta">{meta}</div> : null}
    </section>
  );
}
