import type { ReactNode } from 'react';

/**
 * 列表的两种「一条都没有」。
 *
 * 它们说的是完全不同的两件事，此前三页都只说前一种：
 * 搜「zzz」得到「还没有 Agent 角色」，用户会以为自己攒的十几个角色没了。
 *
 * 搜不到时还要给一个清空的出口 —— 否则他得自己把输入框里的词删干净，
 * 而那一刻他正怀疑的是数据丢了，不是自己打错了字。
 */
export function ListEmpty({
  query,
  noun,
  children,
  onClear,
}: {
  /** 当前搜索词。空串表示没在搜。 */
  query: string;
  /** 「没有匹配的<noun>」里的那个词。 */
  noun: string;
  /** 库是空的时候说什么 —— 每一页不一样，讲的是这一页是干什么的。 */
  children: ReactNode;
  onClear: () => void;
}) {
  if (!query) return <p className="runs__empty">{children}</p>;
  return (
    <p className="runs__empty">
      没有匹配「{query}」的{noun}。
      <button type="button" className="list-empty__clear" onClick={onClear}>
        清空搜索
      </button>
    </p>
  );
}
