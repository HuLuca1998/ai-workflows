/**
 * 分页控件。所有列表共用。
 *
 * 1292 条工作流一次铺满页面，浏览器要建出上千个 DOM 节点，
 * 而用户真正关心的那几条淹在里面。
 *
 * 各页各写一份的话翻页行为会各不相同，而用户会以为是自己记错了。
 */

export interface PagerProps {
  /** 满足筛选条件的总条数，不是这一页的条数。 */
  total: number;
  pageSize: number;
  offset: number;
  onChange: (offset: number) => void;
}

export function Pager({ total, pageSize, offset, onChange }: PagerProps) {
  // 加载中或后端没给 total 时当作「还不知道」——
  // 直接读它会在 toLocaleString 上崩掉，而那会让整页白屏
  const count = Number.isFinite(total) ? total : 0;
  const start = Number.isFinite(offset) ? Math.max(0, offset) : 0;

  // 一页就装得下时整个控件不出现 —— 那时它只是噪音
  if (count <= pageSize) return null;

  const from = start + 1;
  const to = Math.min(start + pageSize, count);
  const atStart = start <= 0;
  const atEnd = to >= count;

  return (
    <nav className="pager" aria-label="分页">
      {/* 翻页后读屏用户要知道自己在哪 */}
      <span className="pager__range" role="status">
        {from} – {to}
        <span className="pager__total"> / 共 {count.toLocaleString('en-US')} 条</span>
      </span>

      <button
        type="button"
        className="pager__button"
        disabled={atStart}
        onClick={() => onChange(Math.max(0, start - pageSize))}
      >
        <i className="ph ph-caret-left" aria-hidden="true" />
        上一页
      </button>

      <button
        type="button"
        className="pager__button"
        disabled={atEnd}
        onClick={() => onChange(start + pageSize)}
      >
        下一页
        <i className="ph ph-caret-right" aria-hidden="true" />
      </button>
    </nav>
  );
}
