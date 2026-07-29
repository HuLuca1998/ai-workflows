import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { isDesktopRuntime } from '../updater/useAppVersion.js';

/**
 * 托盘菜单发来的跳转。
 *
 * 桌面壳点「检查更新…」时 `emit("navigate", "/version")`，
 * 在此之前**没有任何地方监听它** —— 点了只会把窗口调出来，
 * 停在原来那一屏。用户只会当自己点错了，不会想到功能是死的。
 *
 * 只在桌面形态挂：Web 里没有 Tauri 的事件通道，动态 import 会失败。
 */
export function useTrayNavigation(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string>('navigate', (event) => {
          // 只接站内路径。emit 的内容来自桌面壳自己，但这一层不该
          // 假设那边永远不出错 —— 一个 http:// 进到 navigate 里
          // 会把整个应用导航走，而 SPA 回不来
          if (typeof event.payload === 'string' && event.payload.startsWith('/')) {
            void navigate(event.payload);
          }
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        // 接不上就算了：托盘跳转是便利，不是必需的路径。
        // 这里报错会在每次启动弹一条与用户无关的提示
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);
}
