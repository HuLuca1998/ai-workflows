import { useLocation } from 'react-router';
import { navItemForPath } from '../navigation.js';
import { isDesktopRuntime } from '../updater/useAppVersion.js';

export interface TitleBarProps {
  onAskAi: () => void;
  /** 运行中的数量；为 0 时不显示指示器。 */
  activeRuns?: number;
  /** 当前工作目录，显示在面包屑最前面。 */
  workdir?: string;
}

/**
 * 自绘标题栏，44px（屏幕清单 §11）。
 *
 * 与图纸的一处有意差异：图纸（浏览器原型）自己画了三个交通灯圆点，
 * 而桌面形态下交通灯由 macOS 用 Overlay 样式绘制在同一位置——
 * 再画一份会重叠，所以这里只留出安全区。Web 形态没有系统按钮，不留。
 *
 * `data-tauri-drag-region` 必须有：窗口是 hiddenTitle + Overlay，
 * 没有它整个标题栏都拖不动（只有被标记的元素本身能拖，子元素不会冒泡）。
 */
export function TitleBar({ onAskAi, activeRuns = 0, workdir }: TitleBarProps) {
  const { pathname } = useLocation();
  const current = navItemForPath(pathname);
  const desktop = isDesktopRuntime();

  return (
    <header className="title-bar" data-tauri-drag-region>
      {desktop ? (
        <>
          <span className="title-bar__traffic" data-tauri-drag-region />
          <span className="title-bar__sep" aria-hidden="true" />
        </>
      ) : null}

      <nav aria-label="当前位置" className="title-bar__breadcrumb" data-tauri-drag-region>
        <i className="ph ph-folder-open" aria-hidden="true" />
        <span className="title-bar__workdir">{workdir ?? '尚未授权工作目录'}</span>
        <span className="title-bar__slash" aria-hidden="true">
          /
        </span>
        <span className="title-bar__current">{current?.label ?? '未知位置'}</span>
      </nav>

      <span className="title-bar__spacer" data-tauri-drag-region />

      <button type="button" className="title-bar__ask" onClick={onAskAi}>
        <i className="ph ph-sparkle" aria-hidden="true" />
        询问 AI<kbd>⌘K</kbd>
      </button>

      {activeRuns > 0 ? (
        <span className="title-bar__running">
          <span className="title-bar__dot" aria-hidden="true" />
          {activeRuns} 个运行中
        </span>
      ) : null}
    </header>
  );
}
