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
  reload: () => Promise<void>;
} {
  const [settings, setSettings] = useState<WorkspaceSettings>({});

  const reload = async () => {
    try {
      setSettings((await coreClient.call('workspace.settings', {})) as WorkspaceSettings);
    } catch {
      // 读不到就当没配过 —— 外壳不该因为一次设置读取失败就崩掉，
      // 那三条「尚未…」提示照旧显示，用户仍能去配
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  return { settings, reload };
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

/** 侧栏环境那一行。没检查过时返回 undefined。 */
export function environmentDisplay(
  settings: WorkspaceSettings,
): { ok: boolean; text: string } | undefined {
  if (!settings.envCheckedAt) return undefined;
  const at = new Date(settings.envCheckedAt);
  const 时间 = Number.isNaN(at.getTime())
    ? settings.envCheckedAt
    : at.toLocaleString('zh-CN', { hour12: false });
  return { ok: true, text: `环境正常 · 上次检查 ${时间}` };
}
