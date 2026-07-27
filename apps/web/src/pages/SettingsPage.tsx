import { createUpdaterBackend } from '../updater/backend.js';
import { UpdateCard } from '../updater/UpdateCard.js';
import { useAppVersion } from '../updater/useAppVersion.js';

/**
 * 设置与环境。
 *
 * M0 只落地「版本与更新」这一块；环境健康表、权限三档与其余分区在 M5。
 * 版本号必须走 useAppVersion——它会在桌面形态下从 Tauri 取真实版本。
 */
export function SettingsPage() {
  const version = useAppVersion();
  return <UpdateCard currentVersion={version} backend={createUpdaterBackend()} />;
}
