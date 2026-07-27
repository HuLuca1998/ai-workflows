import { useEffect, useState } from 'react';

/**
 * 当前应用版本。
 *
 * 桌面形态必须从 Tauri 取——版本号是构建时注入 tauri.conf.json 的，
 * 前端的 import.meta.env 里没有它。
 *
 * 这里刻意把「取不到」这件事暴露出来而不是静默兜底：
 * 之前 getVersion() 因为缺 capabilities 权限而失败，被 catch 吞掉后，
 * 应用把自己当 dev 版跳过更新检查，界面上只显示「尚未检查更新」——
 * 一个功能安静地不工作，比报错难查得多。
 */

export type VersionSource = 'tauri' | 'web' | 'unavailable';

export interface VersionInfo {
  version: string;
  source: VersionSource;
  /** source 为 unavailable 时的原因，直接展示给用户。 */
  error?: string;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const WEB_VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';

export function useAppVersion(): VersionInfo {
  const [info, setInfo] = useState<VersionInfo>(() =>
    isDesktopRuntime()
      ? { version: 'dev', source: 'unavailable', error: '正在读取版本…' }
      : { version: WEB_VERSION, source: 'web' },
  );

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;

    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((actual) => {
        if (cancelled) return;
        if (actual) setInfo({ version: actual, source: 'tauri' });
        else setInfo({ version: 'dev', source: 'unavailable', error: 'getVersion() 返回空值' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        setInfo({
          version: 'dev',
          source: 'unavailable',
          // 最常见的原因就是权限缺失，直接把排查方向写在错误里
          error: `读取应用版本失败：${detail}。检查 src-tauri/capabilities 是否声明了 core:app:allow-version`,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
