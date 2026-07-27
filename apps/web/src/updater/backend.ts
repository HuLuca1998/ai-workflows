import type { UpdaterBackend } from '@aiwf/client-core';

/**
 * 更新后端的桌面实现。
 *
 * Web 形态没有自更新能力（页面刷新即最新），所以这里返回 null，
 * 界面据此显示「当前是 Web 形态」而不是给一个点不动的按钮。
 */

function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function createUpdaterBackend(): UpdaterBackend | null {
  if (!isDesktop()) return null;

  // 待安装的更新句柄要跨 check / download 两步保留
  let pending: { downloadAndInstall: (cb: (event: unknown) => void) => Promise<void> } | null =
    null;

  return {
    async check() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) return { available: false };
      pending = update as never;
      return {
        available: true,
        version: update.version,
        ...(update.body === undefined ? {} : { notes: update.body }),
      };
    },

    async download(onProgress) {
      if (!pending) throw new Error('没有待下载的更新');
      let downloaded = 0;
      let total = 0;
      // 插件事件里带的是分块字节数，累加后才是进度
      await pending.downloadAndInstall((event) => {
        const e = event as {
          event: string;
          data?: { contentLength?: number; chunkLength?: number };
        };
        if (e.event === 'Started') total = e.data?.contentLength ?? 0;
        if (e.event === 'Progress') {
          downloaded += e.data?.chunkLength ?? 0;
          if (total > 0) onProgress((downloaded / total) * 100);
        }
        if (e.event === 'Finished') onProgress(100);
      });
    },

    async installAndRestart() {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      // downloadAndInstall 已经装好，这里只负责重启到新版本
      await relaunch();
    },
  };
}
