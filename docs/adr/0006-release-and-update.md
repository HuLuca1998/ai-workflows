# ADR-0006：双通道自动发布 + 应用内一键更新

- 状态：已采纳
- 日期：2026-07-27

## 背景

要求：GitHub 自动发布 + 应用内一键更新。参考实现是 `codex-ui`
（Go + Swift，push main 出版本，30 分钟轮询 GitHub Releases，助手脚本原地替换）。

## 决策

**发布**：push `main` → nightly 预发布；push tag `v*` → 正式版并标记 latest。
更新端点指向 `releases/latest/...`，所以日常提交不会推给已安装用户。

**更新**：Tauri updater 插件（minisign 签名校验），状态机独立于 Tauri 可测试。

## 与参考实现的差异及理由

| 维度     | 参考实现             | 本项目               | 理由                                         |
| -------- | -------------------- | -------------------- | -------------------------------------------- |
| 分发     | 手写 zip + 替换脚本  | Tauri updater        | 签名校验，中间人无法替换更新包               |
| 检查时机 | 启动后 + 30 分钟轮询 | 进设置页时检查       | 常驻工具的轮询是持续开销，收益极低           |
| 安装前置 | 直接替换             | 未结束的运行要确认   | 运行会挂在审批上数小时，静默重启等于打断用户 |
| 版本号   | 7 位 commit hash     | 语义化 tag + nightly | 用户要能区分稳定版与今天的构建               |

## 代价

- 私钥丢失 = 无法再给已安装用户推更新。缓解：本地备份 + 文档明确警告
- 未做 Apple 公证（无证书），首次打开需右键。workflow 已留好条件分支，
  拿到证书后设置 Secret 即自动启用

## 落地

`.github/workflows/release.yml`、`packages/client-core/src/updater.ts`、
`apps/web/src/updater/`。细节见 [../RELEASE.md](../RELEASE.md)。
