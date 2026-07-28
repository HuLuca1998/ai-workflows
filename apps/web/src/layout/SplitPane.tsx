import { useCallback, useRef, useState, type ReactNode } from 'react';

/**
 * 可拖动的左右分栏。
 *
 * 图纸给的是固定宽度（Agent 250px、提示词 266px、模型 262px），
 * 那是**初始值** —— 真实使用里名字有长有短，用户需要自己调。
 * 默认值仍然照图纸，拖动只是在它之上加一层。
 *
 * 宽度记在 localStorage：调好一次就不用每次重来。
 * 上下限是必须的 —— 拖到 0 那一栏就彻底消失了，而分隔条也跟着没了，
 * 用户再也找不回来。
 */

export interface SplitPaneProps {
  /** localStorage 的键。每一屏一个，互不影响。 */
  storageKey: string;
  /** 默认宽度，照图纸。 */
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  /** 恰好两个：左栏与右栏。 */
  children: [ReactNode, ReactNode];
  className?: string;
}

/** 键盘每次调多少。与图纸的栏宽相比是个细步 —— 精调靠它，粗调靠拖。 */
const KEY_STEP = 16;

export function SplitPane({
  storageKey,
  defaultWidth,
  minWidth = 200,
  maxWidth = 560,
  children,
  className,
}: SplitPaneProps) {
  const [width, setWidth] = useState(() => readStored(storageKey) ?? defaultWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(value))),
    [minWidth, maxWidth],
  );

  const commit = useCallback(
    (value: number) => {
      const next = clamp(value);
      setWidth(next);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        // 隐私模式下 localStorage 会抛 —— 宽度调不了不该让整屏崩掉
      }
    },
    [clamp, storageKey],
  );

  /**
   * 开始拖。
   *
   * 监听挂在 window 上而不是分隔条上：鼠标很容易跑出那几像素宽的条，
   * 挂在条上的话拖快一点就断了。
   */
  const startDrag = useCallback(() => {
    dragging.current = true;
    // 拖动中整页都用横向调整的光标，并禁掉选中 ——
    // 不禁的话拖过文字会把它们一起选上
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (event: PointerEvent) => {
      // 相对根容器算：分栏不一定贴着窗口左边
      const left = rootRef.current?.getBoundingClientRect().left ?? 0;
      commit(event.clientX - left);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [commit]);

  return (
    <div ref={rootRef} className={['split', className].filter(Boolean).join(' ')}>
      <div className="split__left" style={{ width: `${width}px` }}>
        {children[0]}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整栏宽"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        className="split__handle"
        onPointerDown={() => startDrag()}
        onKeyDown={(event) => {
          // 只能拖的话键盘用户完全用不了
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            commit(width - KEY_STEP);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            commit(width + KEY_STEP);
          }
        }}
        // 拖乱了要能一键复位
        onDoubleClick={() => commit(defaultWidth)}
      />

      <div className="split__right">{children[1]}</div>
    </div>
  );
}

/** localStorage 是用户能手改的，读出来的东西一律当不可信。 */
function readStored(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
