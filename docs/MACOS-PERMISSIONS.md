# macOS 权限

这个应用要碰哪些受 macOS 保护的资源、什么时候触发、不给会怎样、怎么检测。

每一条都写了**检测方式**。没有检测方式的权限项不要往引导页里加 ——
「请去系统设置里授权」而不告诉用户授没授成功，等于把问题推给他。

---

## 先说一条会影响全部的事：ad-hoc 签名让授权活不过一次更新

实测已安装的 App：

```console
$ codesign -dvvv "/Applications/AI Workflows.app"
CodeDirectory v=20500 flags=0x10002(adhoc,runtime)
TeamIdentifier=not set
Signature=adhoc

$ codesign -d -r- "/Applications/AI Workflows.app"
# designated => cdhash H"fb9e1363584a5035ab5b6d2f4014e6535acf52cf" or cdhash H"3420a677..."
```

TCC（就是弹「想访问你的"文稿"文件夹」那套）按 **designated requirement** 认 App。
有 Developer ID 时那是 `identifier "com.huluca.aiworkflows" and anchor apple generic and
certificate leaf[subject.OU] = "TEAMID"` —— 换版本不换身份，授权一直有效。

我们是 ad-hoc，designated requirement 退化成 **cdhash 精确匹配**。
改一个字符重新构建，cdhash 就变，**上一版拿到的每一条 TCC 授权都不再适用**：
文稿访问要重新弹窗，通知授权回到「未询问」，全盘访问要重新去系统设置里勾。

这不是缺陷，是不买 Developer ID 的直接后果（[RELEASE.md](RELEASE.md) 里的取舍）。
但它有两个必须落到实现上的推论：

1. **引导不是「首次配置」，是「版本变化后重新验」**。判据不能只是
   `envCheckedAt` 存在，还得带上当时的 App 版本；版本对不上就重走一遍。
2. **权限检测必须是真探测，不能记「用户点过授权按钮」**。
   点过按钮而授权已失效的状态是存在的，而且每次更新后都会出现。

> 系统设置里会因此攒下多条同名的「AI Workflows」。这是 ad-hoc 签名的已知现象，
> 换 Developer ID 签名才会消失。

---

## 一、通知

|                |                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **谁要它**     | `notify` 节点；运行完成 / 失败 / 等审批时提醒                                                           |
| **触发时机**   | 第一次调用 `requestPermission()`，系统弹一次窗；用户拒绝后不再弹                                        |
| **不给会怎样** | 通知静默丢弃。**必须报「未授权」而不是当成功** —— 这正是 DEBT.md B-1 那条坏账的形态                     |
| **怎么检测**   | `tauri-plugin-notification` 的 `isPermissionGranted()`，返回 `granted` / `denied` / `default`（未询问） |
| **怎么修**     | 拒绝之后 App 无法再弹窗，只能给深链：`x-apple.systempreferences:com.apple.preference.notifications`     |

`default`（未询问）与 `denied`（拒绝过）要分开显示。前者引导页点一下就能解决，
后者只能去系统设置 —— 两者提示同一句话的话，用户会一直点那个不会再弹窗的按钮。

## 二、文件与文件夹（TCC）

macOS 13+ 对这些位置有 TCC 保护，App 首次访问时弹窗：

- `~/Desktop`、`~/Documents`、`~/Downloads`
- iCloud Drive、外接卷、网络卷
- 其他 App 的容器目录

|                |                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------- |
| **谁要它**     | 用户选的工作目录；工作流里的本地 git 仓库路径；worktree（落在仓库旁的 `.aiwf-worktrees`） |
| **触发时机**   | 第一次读写该目录下的文件。**子进程（git / gh）触发的访问算在 App 头上**                   |
| **不给会怎样** | `Operation not permitted`。而 git 报的错完全不提 TCC，用户只看到一句莫名其妙的权限拒绝    |
| **怎么检测**   | 在目标目录下写一个探针文件再删掉，捕获 `PermissionDenied`（EPERM 1，不是 EACCES 13）      |

**用原生目录选择器本身就是一次授权**：`NSOpenPanel`（`tauri-plugin-dialog` 的
`open({ directory: true })`）走 macOS 的 powerbox —— 用户在面板里选中的路径，
系统直接给 App 授权，**即使它在 `~/Documents` 下也不会再弹第二次窗**。

所以引导页的「选择工作目录」不只是填一个路径，它是这一类权限的申请动作本身。
手输路径拿不到这个授权，Web 形态只能退化成「先试着写，写不了再说」。

## 三、全盘访问（可选）

|                |                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| **谁要它**     | 没人**必须**要。给了就不用逐个目录弹窗                                                                        |
| **不给会怎样** | 完全可用，只是每碰一个受保护目录弹一次                                                                        |
| **怎么检测**   | 尝试读 `~/Library/Application Support/com.apple.TCC/TCC.db`。读得到＝有全盘访问，`authorization denied`＝没有 |
| **深链**       | `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`                                    |

标成**可选**，别劝进。全盘访问是这台机器上权限最大的一档，
为了少几次弹窗让用户交出它，不值。

## 四、子进程执行

`git` / `gh` / `node` / `python3` / `docker`。

**不需要任何 macOS 权限**，但有两个 ad-hoc 签名带来的坑：

- **Gatekeeper 隔离标记**：从浏览器下载的 `.dmg` 带 `com.apple.quarantine`，
  未公证的 App 会被判「已损坏」。`scripts/install-app.sh` 清这个标记
- **PATH**：GUI 进程由 launchd 拉起，`PATH=/usr/bin:/bin:/usr/sbin:/sbin`，
  nvm 的 node、homebrew 的 gh 全找不到。所有子进程走
  `aiwf_engine::tooling`（它去问登录 shell 要一份真 PATH）

这两条都不是权限问题，但症状长得像权限问题，排查时先排除它们。

## 五、网络

| 用途                             | 需要权限吗                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| MCP Server 监听 `127.0.0.1:port` | **不需要**。Local Network 权限只在访问局域网设备、Bonjour/mDNS、多播广播时才触发，纯 loopback 不算 |
| 自动更新拉 `github.com`          | **不需要**。出站 HTTPS 不受 macOS 管控                                                             |
| ACP adapter 连各家 AI 服务       | **不需要**，同上                                                                                   |

**如果哪天 MCP Server 改成绑 `0.0.0.0`**，就要加
`NSLocalNetworkUsageDescription` 到 Info.plist，并且引导页要多一项 ——
写在这里是为了那时候有人记得。目前 `crates/mcp/src/http.rs:83` 绑的是 `127.0.0.1`。

## 六、Keychain

`gh auth token` 读的是 **gh 自己的** keychain 条目，弹窗归 gh，与本 App 无关。

App 自己**目前不写 Keychain**（`Cargo.toml` 里没有 keyring 依赖）——
而 CLAUDE.md 写着「Secret 只进 Keychain」。这是一条待确认的账，
不属于权限范畴，记在这里免得下次盘点时又当成「已实现」。

## 七、明确不需要的

写出来是为了防止后面有人「顺手」加进去 —— 每加一项都是一次弹窗和一份不信任。

| 权限                            | 为什么不需要                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------- |
| 辅助功能（Accessibility）       | 不控制其他 App 的界面                                                           |
| 屏幕录制                        | 不截屏、不录屏                                                                  |
| 麦克风 / 摄像头                 | 没有音视频功能                                                                  |
| 通讯录 / 日历 / 提醒事项 / 照片 | 不碰个人数据                                                                    |
| Apple Events（自动化）          | 不用 AppleScript 驱动别的 App                                                   |
| 定位                            | 不用位置                                                                        |
| 登录项 / 开机自启               | 目前没有。要做的话走 `SMAppService`（`tauri-plugin-autostart`），是一项独立授权 |

---

## 检测清单（引导页照这个实现）

| 项           | 必需                           | 检测方式                | 拒绝后的出路             |
| ------------ | ------------------------------ | ----------------------- | ------------------------ |
| 通知         | 否（用了 `notify` 节点才必需） | `isPermissionGranted()` | 系统设置深链             |
| 工作目录可写 | 是                             | 目录下写探针文件再删    | 重新用原生选择器选一个   |
| 全盘访问     | 否                             | 读 `TCC.db` 是否成功    | 系统设置深链；不给也能用 |
| git / node   | 是                             | `env.health` 已有       | 给一行安装命令           |
| gh 已登录    | 否（GitHub 工作流才必需）      | `gh auth token`         | `gh auth login`          |
| ACP adapter  | 否（AI 节点才必需）            | `env.health` 已有       | 给一行安装命令           |

「必需」那几项没过就**不放行进入应用** —— 这是产品决定，不是技术限制：
带着一个写不进去的工作目录进主界面，第一次运行才发现，那时用户已经配了半条工作流。
