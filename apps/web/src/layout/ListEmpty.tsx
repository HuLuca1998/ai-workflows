import type { ReactNode } from 'react';

/**
 * 列表的三种「一条都没有」。
 *
 * 它们说的是完全不同的三件事，而混为一谈的代价是用户以为数据丢了：
 *
 * - 库是空的 → 讲这一页是干什么的
 * - 搜不到 → 说搜的是什么，给一个清空的出口（否则他得自己把词删干净，
 *   而那一刻他正怀疑的是数据丢了，不是自己打错了字）
 * - **筛选后为空** → 说清是哪个筛选。记忆页有 4 条在列，点「全局」之后
 *   显示「还没有记忆。AI 在运行结束时会提议…」—— 用户刚看见 4 条
 *   （第三方巡检 C-18）
 */
export function ListEmpty({
  query,
  noun,
  children,
  onClear,
  filterLabel,
  onClearFilter,
}: {
  /** 当前搜索词。空串表示没在搜。 */
  query: string;
  /** 「没有匹配的<noun>」里的那个词。 */
  noun: string;
  /** 库是空的时候说什么 —— 每一页不一样，讲的是这一页是干什么的。 */
  children: ReactNode;
  onClear: () => void;
  /**
   * 当前生效的筛选的人话名（「全局」「失败」…）。
   * 不传 = 没在筛，那时「空」就是真的空。
   */
  filterLabel?: string;
  /** 有筛选时给一个回到全部的出口。 */
  onClearFilter?: () => void;
}) {
  // 搜索优先：那是用户刚打进去的字，比他早先点的筛选更近
  if (query) {
    return (
      <p className="runs__empty">
        没有匹配「{query}」的{noun}。
        <button type="button" className="list-empty__clear" onClick={onClear}>
          清空搜索
        </button>
      </p>
    );
  }

  if (filterLabel) {
    return (
      <p className="runs__empty">
        「{filterLabel}」下没有{noun}。
        {onClearFilter ? (
          <button type="button" className="list-empty__clear" onClick={onClearFilter}>
            看全部
          </button>
        ) : null}
      </p>
    );
  }

  return <p className="runs__empty">{children}</p>;
}
