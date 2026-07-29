import { createUpdaterBackend } from '../updater/backend.js';
import { UpdateCard } from '../updater/UpdateCard.js';
import { useAppVersion } from '../updater/useAppVersion.js';

/**
 * 设置 →「系统版本」。
 *
 * 更新入口原先是「运行环境与工具」滚到底的第三块卡片，前面挡着
 * 8 行环境健康表与三张权限卡。这个应用装在本地、靠自更新分发，
 * 又刻意不做「发现新版本就弹窗」—— 于是「用户主动来看」是新版本
 * 到达他机器的唯一路径，那条路径不该要滚一屏才走得到。
 *
 * 版本号必须走 useAppVersion（桌面形态从 Tauri getVersion() 取）。
 * 用 import.meta.env 会让应用把自己当 dev 版而跳过更新检查。
 */
export function VersionPanel() {
  const versionInfo = useAppVersion();

  return (
    <section className="verpanel" aria-label="系统版本">
      <UpdateCard versionInfo={versionInfo} backend={createUpdaterBackend()} />

      {/* 更新怎么来的说清楚。用户点「下载更新」时下载的是什么、
          从哪来、验没验签，这些不说就只能靠信任 */}
      <p className="verpanel__note">
        更新包由 GitHub Releases 分发，安装前校验签名。 应用不会自动下载或自动安装 ——
        检查、下载、重启安装三步都由你按。
      </p>
    </section>
  );
}
