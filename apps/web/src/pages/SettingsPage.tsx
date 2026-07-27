import { EnvHealth } from '../settings/EnvHealth.js';
import { createUpdaterBackend } from '../updater/backend.js';
import { UpdateCard } from '../updater/UpdateCard.js';
import { useAppVersion } from '../updater/useAppVersion.js';

/**
 * 设置与环境。
 *
 * 版本号必须走 useAppVersion —— 它会在桌面形态下从 Tauri 取真实版本。
 * 用 import.meta.env 会让应用把自己当 dev 版而跳过更新检查。
 *
 * 「权限策略」三档（Review Every Change / Workspace Safe / Trusted Workflow）
 * 还没做：那要引擎侧真的按档位拦截，而不是界面上摆三个单选。
 */
export function SettingsPage() {
  const versionInfo = useAppVersion();
  return (
    <div className="settings">
      <EnvHealth />
      <UpdateCard versionInfo={versionInfo} backend={createUpdaterBackend()} />
    </div>
  );
}
