# 发布与自动更新

## 两条通道

| 触发           | 版本号                          | Release 类型 | 谁会收到                               |
| -------------- | ------------------------------- | ------------ | -------------------------------------- |
| push 到 `main` | `0.0.0-nightly.<日期>.<短 sha>` | prerelease   | 只有手动下载的人                       |
| push tag `v*`  | tag 上的版本，如 `1.2.0`        | latest       | **所有已安装用户**（应用内检查更新时） |

关键点：nightly 是 prerelease，不会成为 `latest`，
而更新端点指向 `releases/latest/download/latest.json`——
**所以日常提交不会把用户推到未验证的版本上**，只有打 tag 才会。

发正式版：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

流水线是幂等的：同一个 tag 重跑不会产生第二份 release。

## 发布前会跑什么

`.github/workflows/release.yml` 在构建前跑一遍门禁：全部测试、契约不漂移、
Secret 扫描、Rust 测试。**不把坏版本推给用户**比早十分钟发布重要。

版本号只在发布时用 `jq` 注入 `tauri.conf.json`，仓库里始终是 `0.0.0`——
避免每次发版都产生一次「bump version」提交。

## 应用内一键更新

用户路径：**设置与环境 → 版本 → 检查更新 → 下载更新 → 重启并安装**。

状态机（`packages/client-core/src/updater.ts`）：

```
idle → checking → up-to-date
                → available → downloading → ready → 重启安装
                → error（可重试）
```

三条刻意的设计：

1. **不弹窗打断**。发现新版本不主动弹窗，只在用户进入设置页时提示。
   这是个会长时间挂着等审批的工具，打断的代价比晚一天更新大。
2. **下载失败退回 `available`**，不停在 `downloading`。用户能直接重试，
   而不是重启应用才恢复。
3. **有未结束的运行时，安装前要确认**（`setBlockers`）。重启会中断运行——
   虽然检查点能恢复，但这个决定该由用户做。

## 与参考实现的差异

参考了 `codex-ui` 的状态划分（idle / checking / available / downloading / ready / error），
但三处按本产品的特性做了不同选择：

| 维度       | codex-ui                         | 本项目                      | 为什么                                                                     |
| ---------- | -------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| 更新包分发 | 手写 zip 下载 + 助手脚本原地替换 | Tauri updater 插件          | 更新包经 minisign 签名，公钥内嵌在应用中；私钥泄漏之外没有中间人替换的可能 |
| 检查时机   | 启动 30s 后 + 每 30 分钟轮询     | 进入设置页时检查            | 轮询对一个常驻工具是持续的网络与注意力开销，收益极低                       |
| 安装前置   | 直接替换                         | 未结束的运行要先确认        | 本产品的运行会挂在审批上数小时，静默重启等于打断用户                       |
| 版本号     | 7 位 commit hash                 | 语义化 tag + nightly 预发布 | 用户需要区分「稳定版」与「今天的构建」；hash 无法表达这个区别              |
| 状态机位置 | 与 HTTP/SSE 服务耦合             | 独立于 Tauri，后端可注入    | 能在普通单测里验证重试、并发保护、未确认不安装                             |

## 签名密钥

更新包用 minisign 签名，Tauri 校验后才安装。

- **公钥**：内嵌在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，公开无妨
- **私钥**：只存在两个地方——GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`，以及生成时的本地备份 `~/.aiwf-updater/updater.key`

⚠️ **私钥丢了就无法再给已安装的用户推更新**（他们的应用只认这一个公钥）。
本地备份要另存一份到密码管理器。

重新生成密钥对（只在私钥泄漏时做，会导致老版本用户无法自动更新）：

```bash
cd apps/desktop
pnpm exec tauri signer generate -w ~/.aiwf-updater/updater.key --password ""
gh secret set TAURI_SIGNING_PRIVATE_KEY --body "$(cat ~/.aiwf-updater/updater.key)"
# 把新公钥写回 tauri.conf.json
```

## Apple 签名与公证

当前**未启用**——没有 Apple 开发者证书。后果：用户首次打开要右键 → 打开。

流水线里有两个互斥的构建步骤，按 `APPLE_CERTIFICATE` 是否存在自动选择——
**不需要改 workflow**，设置下面这几个 Secret 即可启用签名与公证：

```
APPLE_CERTIFICATE           # base64 的 .p12
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY      # Developer ID Application: ...
APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   # 公证用
```

## 排查

| 现象                                                  | 检查                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 应用内检查更新一直「已是最新」                        | 当前版本是不是 `dev`（开发构建会跳过检查）；`latest.json` 里的版本是否真的更高                                                               |
| 下载后安装失败                                        | 签名是否匹配：`tauri.conf.json` 的公钥与 CI 用的私钥必须是同一对                                                                             |
| CI 发布成功但 latest.json 缺失                        | `includeUpdaterJson: true` 与 bundle targets 里的 `updater` 都要在                                                                           |
| nightly 把稳定版用户带跑了                            | 检查 release 的 prerelease 标记——它必须为 true                                                                                               |
| bundle 阶段报 `failed to import keychain certificate` | 说明空的 `APPLE_CERTIFICATE` 被传进了构建步骤。GitHub Actions 无法条件性地不设置 env，所以必须走两个互斥步骤，而不是靠 tauri-action 自己判空 |
