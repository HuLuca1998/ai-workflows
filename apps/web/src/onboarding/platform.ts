import { isDesktopRuntime } from '../updater/useAppVersion.js';

/**
 * 引导页要用的那几件**只有桌面壳才能做**的事：挑目录、申请通知权限。
 *
 * 抽在这里而不是散在组件里，是因为每一件都要回答同一个问题：
 * **Web 形态下怎么办**。答案统一是「说清楚做不了，给一条能走的路」——
 * 而不是画一个点了没反应的按钮。
 */

/**
 * 通知权限的三种状态。
 *
 * `default`（还没问过）与 `denied`（拒绝过）必须分开显示：
 * 前者点一下就能解决，后者 App 再也弹不出那个框，只能去系统设置。
 * 两者提示同一句话的话，用户会一直点那个不会再弹窗的按钮。
 */
export type NotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** 系统设置的深链。拒绝之后 App 弹不出授权框，只能把人送过去。 */
export const NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.notifications';

export async function readNotificationPermission(): Promise<NotificationPermission> {
  if (!isDesktopRuntime()) return 'unsupported';
  try {
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    return (await isPermissionGranted()) ? 'granted' : 'default';
  } catch {
    // 插件没接上（capabilities 少一条会走到这里，而且**不报错**，
    // 只是调用被拒）—— 当成不支持，别说成「已授权」
    return 'unsupported';
  }
}

/**
 * 申请通知权限。
 *
 * 只在 `default`（没问过）时有意义。`denied` 之后系统不会再弹框，
 * 调它只会立刻返回 denied —— 那时该给深链，不是再点一次。
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isDesktopRuntime()) return 'unsupported';
  try {
    const { requestPermission } = await import('@tauri-apps/plugin-notification');
    const state = await requestPermission();
    return state === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/**
 * 用原生面板挑一个目录。
 *
 * **这一步本身就是一次授权**：`NSOpenPanel` 走 macOS 的 powerbox，
 * 用户在面板里选中的路径，系统直接授权给 App —— 即使它在
 * `~/Documents` 下也不会再弹第二次窗（docs/MACOS-PERMISSIONS.md）。
 *
 * 手输路径拿不到这个授权。所以 Web 形态返回 null，
 * 由调用方退化成文本框 + 一次真探测（`env.checkDirectory`）。
 */
export async function pickDirectory(current?: string): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      directory: true,
      multiple: false,
      title: '选择工作目录',
      ...(current ? { defaultPath: current } : {}),
    });
    return typeof picked === 'string' ? picked : null;
  } catch {
    return null;
  }
}

/** 能不能用原生面板挑目录。Web 形态下界面要退化成文本框。 */
export function canPickDirectory(): boolean {
  return isDesktopRuntime();
}
