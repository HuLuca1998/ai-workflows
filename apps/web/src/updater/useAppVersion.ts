import { useEffect, useState } from 'react';

/**
 * 当前应用版本。
 *
 * 桌面形态必须从 Tauri 取——版本号是构建时注入 tauri.conf.json 的，
 * 前端的 import.meta.env 里没有它。早期版本用 VITE_APP_VERSION 兜底，
 * 结果应用永远把自己当 `dev` 版而跳过更新检查，自动更新形同不存在。
 *
 * Web 形态没有安装包的概念，用构建时注入的值或 `dev`。
 */

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const WEB_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';

export function useAppVersion(): string {
  const [version, setVersion] = useState(WEB_VERSION);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((actual) => {
        if (!cancelled && actual) setVersion(actual);
      })
      .catch(() => {
        // 取不到就维持兜底值：宁可跳过检查，也不要拿错版本号去比较
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
