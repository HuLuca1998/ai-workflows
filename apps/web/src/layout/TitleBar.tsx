import { useLocation } from 'react-router';
import { navItemForPath } from '../navigation.js';

export interface TitleBarProps {
  onAskAi: () => void;
}

/**
 * 自绘标题栏 44px：交通灯留位 + 路径面包屑 + 询问 AI + 运行中指示。
 * 桌面形态下交通灯由 Tauri 提供，这里只留出安全区。
 */
export function TitleBar({ onAskAi }: TitleBarProps) {
  const { pathname } = useLocation();
  const current = navItemForPath(pathname);

  return (
    <header className="title-bar">
      <span className="title-bar__traffic" aria-hidden="true" />
      <nav aria-label="当前位置" className="title-bar__breadcrumb">
        <span>AI Workflows</span>
        <span aria-hidden="true"> / </span>
        <span>{current?.label ?? '未知位置'}</span>
      </nav>
      <button type="button" className="title-bar__ask" onClick={onAskAi}>
        询问 AI<kbd>⌘K</kbd>
      </button>
    </header>
  );
}
