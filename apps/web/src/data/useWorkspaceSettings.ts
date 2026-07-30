import { useEffect, useState } from 'react';
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

/** 图纸「05 设置与环境」的权限策略三档。存的是 ID，显示的是这些文案。 */
export const PRESET_LABELS: Record<string, string> = {
  review_every_change: 'Review Every Change',
  workspace_safe: 'Workspace Safe',
  trusted_workflow: 'Trusted Workflow',
};

/** 图纸侧栏底部那句说明，跟着权限档走。 */
const PRESET_DETAILS: Record<string, string> = {
  review_every_change: '文件写入、命令与外部写操作逐项审批。',
  workspace_safe: '授权目录内可读写与执行已声明命令；Push、PR、删除仍需审批。',
  trusted_workflow: '对指定已发布版本沿用保存策略；权限扩大后自动失效。',
};

export function useWorkspaceSettings(): {
  settings: WorkspaceSettings;
  health: EnvSummary | undefined;
  reload: () => Promise<void>;
} {
  const [settings, setSettings] = useState<WorkspaceSettings>({});
  const [health, setHealth] = useState<EnvSummary | undefined>(undefined);

  const reload = async () => {
    try {
      setSettings((await coreClient.call('workspace.settings', {})) as WorkspaceSettings);
    } catch {
      // 读不到就当没配过 —— 外壳不该因为一次设置读取失败就崩掉，
      // 那三条「尚未…」提示照旧显示，用户仍能去配
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
  }, []);

  return { settings, health, reload };
}

/** 侧栏权限档那一块的显示内容。没选过时返回 undefined，界面自己说「未设置」。 */
export function permissionDisplay(
  settings: WorkspaceSettings,
): { preset: string; detail: string } | undefined {
  const preset = settings.permissionPreset;
  if (!preset) return undefined;
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
