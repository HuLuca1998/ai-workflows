# 安装与环境

## 一、装来用（不改代码）

从 [Releases](https://github.com/HuLuca1998/ai-workflows/releases) 下载
`AI.Workflows_<版本>_aarch64.dmg`，打开后拖进「应用程序」。

⚠️ **首次打开会被 macOS 拦下**（应用未经 Apple 公证）：

```
右键点击「AI Workflows」→ 打开 → 在弹窗里再点「打开」
```

只需做一次。之后正常双击即可。想彻底消掉这一步，需要 Apple 开发者证书，
见 [RELEASE.md](RELEASE.md#apple-签名与公证)。

**两个通道的区别**：

| 通道                   | 版本号                     | 适合谁                         |
| ---------------------- | -------------------------- | ------------------------------ |
| Latest（正式版）       | `v0.1.0` 这样的语义化版本  | 日常使用                       |
| Pre-release（nightly） | `nightly-20260727-abc1234` | 想试最新提交、能接受偶尔出问题 |

应用内的自动更新**只跟随正式版**，nightly 需要手动下载。

## 二、装来开发

### 前置

| 依赖                     | 版本   | 装法                                                              |
| ------------------------ | ------ | ----------------------------------------------------------------- |
| Node.js                  | ≥ 22   | [nodejs.org](https://nodejs.org) 或 nvm / fnm                     |
| pnpm                     | ≥ 11   | `npm i -g pnpm`                                                   |
| Rust                     | ≥ 1.85 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Xcode Command Line Tools | ——     | `xcode-select --install`                                          |

### 步骤

```bash
git clone https://github.com/HuLuca1998/ai-workflows.git
cd ai-workflows
pnpm install
pnpm env:check      # 确认环境齐了
pnpm verify         # 跑一遍完整门禁（首次含 Rust 编译，约 2–3 分钟）
```

### 跑起来

```bash
pnpm dev                              # 只跑 Web 形态 → http://localhost:5173
pnpm --filter @aiwf/desktop dev       # 跑桌面 App（会自动带起 Web 开发服务器）
pnpm --filter @aiwf/ui preview        # 组件画廊 → http://localhost:5175
```

### 自己打包

```bash
pnpm --filter @aiwf/desktop build
# 产物：target/aarch64-apple-darwin/release/bundle/
#   ├─ macos/AI Workflows.app
#   └─ dmg/AI Workflows_0.0.0_aarch64.dmg
```

本地构建的版本号是 `0.0.0`，会被识别为开发版本——**自动更新会自动跳过**，
不会把你的本地构建覆盖掉。

## 三、环境检查

```bash
pnpm env:check           # 人读
pnpm env:check --json    # 机器读
```

输出示例：

```
✓ Node.js           25.6.1
✓ pnpm              11.17.0
✓ Rust（rustc）     1.97.1
✓ Git               2.50.1
✓ GitHub CLI        2.96.0
✓ 依赖已安装        node_modules 就绪
✓ 契约生成物        契约 v1 · 16 种节点 · 50 类事件 · 35 个方法

环境就绪。下一步：pnpm verify
```

缺东西时会直接给出装法，并区分**必需**与**可选**（可选项只影响部分工作流，
比如没有 `gh` 只是不能用发布流水线与 issue 操作）。

原则和产品一致：**只检测，不静默安装**。

这个命令是 M5「环境健康中心」的前身——到时候同一份检查项由引擎实现，
在设置页展示 Ready / Needs Attention 并提供 Repair。届时它还会多检查
ACP adapter 握手、Python 运行时、目录授权与 Keychain 可写性，
现在这些能力还没接上（见 [ROADMAP.md](ROADMAP.md)）。

## 四、自动更新

### 用户视角

**设置与环境 → 版本 → 检查更新**

```
检查更新 → 发现新版本 x.y.z → 下载更新 → 重启并安装
```

三件事值得知道：

- **不会弹窗打断你**。只在你打开设置页时才提示——这工具会挂着等审批数小时，
  打断的代价比晚一天更新大
- **有未结束的运行时会先问你**。重启会中断运行（检查点能恢复），但这个决定归你
- **下载失败可以直接重试**，不会卡在中间状态

### 更新包怎么保证是真的

更新包用 minisign 签名，公钥内嵌在应用里。**签名不匹配就拒绝安装**，
所以即使有人能替换下载链接，也装不进去。

### 当前状态（重要）

自动更新的链路已经完整，但**还差一个正式版才能闭环**：

更新端点指向 `releases/latest/download/latest.json`，而 latest 只会指向正式版。
目前仓库里只有 nightly 预发布，所以现在装上的应用点「检查更新」会拿不到清单。

发出第一个正式版后即闭环：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

之后每个 `v*` tag 都会自动构建、签名、发布，并成为已安装用户的更新目标。
细节见 [RELEASE.md](RELEASE.md)。
