import { useState } from 'react';
import { useLocation } from 'react-router';
import { EnvHealth } from '../settings/EnvHealth.js';
import { McpIntegration } from '../settings/McpIntegration.js';
import { PermissionPolicy } from '../settings/PermissionPolicy.js';
import { WorkspaceReset } from '../settings/WorkspaceReset.js';
import { VersionPanel } from '../settings/VersionPanel.js';
import { OnboardingPage } from '../onboarding/OnboardingPage.js';

/**
 * 设置与环境。
 *
 * 分档比图纸多两项，是有意的 ——
 * 见 `docs/adr/0010-settings-holds-setup-and-version.md`：
 *
 * - **首次配置**（环境检测与依赖补齐）从主导航搬进来，放最上面。
 *   它是「装机时走一遍」的东西，常驻主导航占的是一个每天都要
 *   扫过的位置；而它与下面的「运行环境与工具」本就是同一件事的
 *   两个阶段，隔在两个不同的地方反而难对照。
 * - **系统版本**放最下面。它原先是「运行环境与工具」滚到底的
 *   第三块卡片，前面挡着 8 行环境健康表与三张权限卡 —— 而这个
 *   应用靠自更新分发，「用户主动来看」是新版本到达他机器的唯一路径。
 *
 * 顺序不是按图纸抄的，是按**什么时候会用到**排：
 * 装机（首次配置）→ 日常配置（通用…安全与隐私）→ 少碰的（高级、系统版本）。
 */

const TABS = [
  // 装机时走一遍，之后不再进 —— 但要找得到
  { key: 'setup', label: '首次配置' },
  { key: 'general', label: '通用' },
  { key: 'ai', label: 'AI 与 Agent' },
  { key: 'git', label: 'Git 与 GitHub' },
  { key: 'env', label: '运行环境与工具' },
  { key: 'mcp', label: 'MCP 与集成' },
  { key: 'notify', label: '通知' },
  { key: 'security', label: '安全与隐私' },
  // 下面两档都是「少碰但要能找到」
  { key: 'adv', label: '高级' },
  { key: 'version', label: '系统版本' },
] as const;

const TAB_KEYS: readonly string[] = TABS.map((t) => t.key);

export function SettingsPage() {
  const location = useLocation();
  /**
   * 允许用 `?tab=version` 直接落到某一档。
   *
   * 托盘的「检查更新…」靠它跳到版本那一档 —— 只跳到 /settings
   * 会停在默认档，用户还得自己找，等于没跳。
   * 认不出的值忽略：URL 是用户能手改的，不该让一个错字打出空白页。
   */
  const requested = new URLSearchParams(location.search).get('tab');
  const [tab, setTab] = useState<string>(() =>
    requested && TAB_KEYS.includes(requested) ? requested : 'env',
  );

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

      <div className="settings" data-tab={tab}>
        {tab === 'setup' ? (
          <OnboardingPage />
        ) : tab === 'env' ? (
          <>
            <EnvHealth />
            <PermissionPolicy />
          </>
        ) : tab === 'mcp' ? (
          <McpIntegration />
        ) : tab === 'security' ? (
          <PermissionPolicy />
        ) : tab === 'adv' ? (
          <WorkspaceReset />
        ) : tab === 'version' ? (
          <VersionPanel />
        ) : (
          // 照实说而不是留一片空白：用户点进来看到空白会以为界面坏了
          <p className="runs__empty">这一档还没有可配置的项。</p>
        )}
      </div>
    </div>
  );
}
