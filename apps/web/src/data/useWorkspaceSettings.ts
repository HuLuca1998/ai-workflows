import { useEffect, useState } from 'react';
import { APPROVAL_MODES, APPROVAL_MODE_LABELS, migrateApprovalMode } from '@aiwf/contracts';
import { coreClient } from './workspace.js';

/**
 * 工作区设置：工作目录、权限档、上次环境检查。
 *
 * 顶栏的面包屑与侧栏底部两块都读它。在此之前那三处**没有数据源**——
 * 界面上一直悬着「尚未授权工作目录 / 未设置权限档 / 环境尚未检查」，
 * 而应用里没有任何东西能把它们改掉，首次配置屏点什么按钮都不会变。
 */

export interface WorkspaceSettings {
  workdir?: string;
  permissionPreset?: string;
  envCheckedAt?: string;
}

type SettingsListener = (next: WorkspaceSettings) => void;
const settingsListeners = new Set<SettingsListener>();

/**
 * 设置写成功之后，把新值推给所有订阅方（外壳的面包屑、侧栏、门禁）。
 *
 * 外壳只在启动时读一次。不推的话，首次配置写完设置跳首页，
 * 外壳手里还是「未配置」，重定向门禁立刻把用户弹回配置屏 ——
 * **配置永远完不成**。推「值」而不是通知「去重读」：重读是异步的，
 * 跳转后的门禁判断赶在它回来之前，照样弹回。
 *
 * 只在 `workspace.updateSettings` 成功后调用，传写进去的那份增量。
 */
export function pushWorkspaceSettings(next: WorkspaceSettings): void {
  for (const listener of settingsListeners) listener(next);
}

/**
 * 审批三档的显示名。存的是 ID，显示的是这些文案。
 *
 * **从契约取，不再抄一份** —— 设置页、引导页、侧栏说的必须是同一件事。
 * 抄一份的代价是：改了其中一处文案，另外两处还在向用户承诺旧的行为。
 */
export const PRESET_LABELS: Record<string, string> = Object.fromEntries(
  APPROVAL_MODES.map((mode) => [mode, APPROVAL_MODE_LABELS[mode].name]),
);

/** 侧栏底部那句说明，跟着档位走。 */
const PRESET_DETAILS: Record<string, string> = Object.fromEntries(
  APPROVAL_MODES.map((mode) => [mode, APPROVAL_MODE_LABELS[mode].summary]),
);

export function useWorkspaceSettings(): {
  settings: WorkspaceSettings;
  health: EnvSummary | undefined;
  /**
   * 第一次读取有没有回来过。
   *
   * `settings` 初值是 `{}`，与「读回来了但什么都没配」长得一模一样 ——
   * 调用方据此判断「配没配过」会在加载那一瞬间判错（比如把用户弹到首次配置）。
   */
  loaded: boolean;
  reload: () => Promise<void>;
} {
  const [settings, setSettings] = useState<WorkspaceSettings>({});
  const [health, setHealth] = useState<EnvSummary | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  const reload = async () => {
    try {
      setSettings((await coreClient.call('workspace.settings', {})) as WorkspaceSettings);
    } catch {
      // 读不到就当没配过 —— 外壳不该因为一次设置读取失败就崩掉，
      // 那三条「尚未…」提示照旧显示，用户仍能去配
    } finally {
      // 失败也算「问过了」：一直不置位的话调用方会永远停在等待态
      setLoaded(true);
    }
    try {
      // 侧栏那一行说的「环境正常」得是真的。只存了一个 envCheckedAt
      // 时间戳是不够的 —— 那只能回答「什么时候查的」，回答不了「查出什么」
      setHealth((await coreClient.call('env.health', {})) as EnvSummary);
    } catch {
      // 探测失败时不猜。environmentDisplay 拿不到结果就只说
      // 「上次检查是什么时候」，不替它断言正不正常
    }
  };

  useEffect(() => {
    void reload();
    // 订阅设置写入：增量合并进已有值 —— 设置页只改权限档时，
    // 工作目录不能被冲掉
    const listener: SettingsListener = (next) => {
      setSettings((prev) => ({ ...prev, ...next }));
      setLoaded(true);
    };
    settingsListeners.add(listener);
    return () => {
      settingsListeners.delete(listener);
    };
  }, []);

  return { settings, health, loaded, reload };
}

/** 侧栏权限档那一块的显示内容。没选过时返回 undefined，界面自己说「未设置」。 */
export function permissionDisplay(
  settings: WorkspaceSettings,
): { preset: string; detail: string } | undefined {
  const stored = settings.permissionPreset;
  if (!stored) return undefined;
  // 库里可能躺着上一版的档位名。不迁移的话侧栏显示的是那个原始值
  // （「workspace_safe」），而用户在设置页看到的是迁移后的档 —— 两处对不上
  const preset = migrateApprovalMode(stored);
  return {
    preset: PRESET_LABELS[preset] ?? preset,
    detail: PRESET_DETAILS[preset] ?? '',
  };
}

/** 环境检查的结果，只取这一行用得上的部分。 */
export interface EnvSummary {
  ready: boolean;
  items: readonly { status: string }[];
}

/**
 * 侧栏环境那一行。没检查过时返回 undefined。
 *
 * **由真实的健康结果决定**，不是「检查过就算正常」。
 * 原来这里只看 `envCheckedAt` 存不存在然后硬编码 `ok: true` ——
 * 而首次配置在「还缺 N 项」时也会写那个时间戳（底部按钮那时
 * 已经变成「装好了，继续」，什么都没装也能按下去）。
 * 于是用户回到主界面看到「环境正常」，而设置页里还挂着「缺失 2 项」。
 *
 * 可选项缺失不算待处理：一个从不跑容器的人不该永远被提醒装 Docker。
 */
export function environmentDisplay(
  settings: WorkspaceSettings,
  health?: EnvSummary,
): { ok: boolean; text: string } | undefined {
  if (!settings.envCheckedAt) return undefined;
  const at = new Date(settings.envCheckedAt);
  const checkedAt = Number.isNaN(at.getTime())
    ? settings.envCheckedAt
    : at.toLocaleString('zh-CN', { hour12: false });

  // 还没拿到检查结果时只说「上次检查是什么时候」——
  // 那是确定的事实，而「正不正常」这时还不知道
  if (!health) return { ok: true, text: `上次检查 ${checkedAt}` };

  const needsAttention = health.items.filter(
    (item) => item.status === 'missing' || item.status === 'needs_attention',
  ).length;

  return needsAttention > 0
    ? { ok: false, text: `${needsAttention} 项待处理 · 上次检查 ${checkedAt}` }
    : { ok: true, text: `环境正常 · 上次检查 ${checkedAt}` };
}
