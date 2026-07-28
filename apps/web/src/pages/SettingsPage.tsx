import { useState } from 'react';
import { EnvHealth } from '../settings/EnvHealth.js';
import { McpIntegration } from '../settings/McpIntegration.js';
import { PermissionPolicy } from '../settings/PermissionPolicy.js';
import { createUpdaterBackend } from '../updater/backend.js';
import { UpdateCard } from '../updater/UpdateCard.js';
import { useAppVersion } from '../updater/useAppVersion.js';

/**
 * 设置与环境 —— 严格照图纸「05 设置与环境」：
 * 左边 184px 的 8 个分组导航，右边分组内容。
 *
 * 版本号必须走 useAppVersion —— 它会在桌面形态下从 Tauri 取真实版本。
 * 用 import.meta.env 会让应用把自己当 dev 版而跳过更新检查。
 */

/** 图纸左栏那八项。 */
const TABS = [
  { key: 'general', label: '通用' },
  { key: 'ai', label: 'AI 与 Agent' },
  { key: 'git', label: 'Git 与 GitHub' },
  { key: 'env', label: '运行环境与工具' },
  { key: 'mcp', label: 'MCP 与集成' },
  { key: 'notify', label: '通知' },
  { key: 'security', label: '安全与隐私' },
  { key: 'adv', label: '高级' },
] as const;

export function SettingsPage() {
  // 图纸画的就是 env 这一档，默认停在这里
  const [tab, setTab] = useState<string>('env');
  const versionInfo = useAppVersion();

  return (
    <div className="settings-shell">
      <nav className="settings-nav" role="tablist" aria-label="设置分组">
        <p className="settings-nav__title">设置</p>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className="settings-nav__item"
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="settings">
        {tab === 'env' ? (
          <>
            <EnvHealth />
            <PermissionPolicy />
            <UpdateCard versionInfo={versionInfo} backend={createUpdaterBackend()} />
          </>
        ) : tab === 'mcp' ? (
          <McpIntegration />
        ) : tab === 'security' ? (
          <PermissionPolicy />
        ) : (
          // 照实说而不是留一片空白：用户点进来看到空白会以为界面坏了，
          // 而图纸也只画了 env 这一档的内容
          <p className="runs__empty">这一档还没有可配置的项。</p>
        )}
      </div>
    </div>
  );
}
