# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 两条不可协商的纪律

### 一、UI 严格按图纸施工

图纸在 `docs/design/client/`：

| 文件                          | 内容                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `AI Workflows 客户端.dc.html` | **可交互原型**：每一屏的真实布局、间距、图标、文案、状态样式 |
| `功能文档与里程碑.dc.html`    | 全部菜单与功能细节、屏幕清单与布局规格、快捷键               |
| `技术选型.dc.html`            | 分层架构、数据模型、Core API 契约、状态机、质量门禁          |
| `_ds/nocturne-*/`             | Nocturne 设计系统：令牌、组件类、用法约定                    |

**图纸里的 UI 就是最终形态，照做。** 原型里的每一屏都带 `data-screen-label`，按标签定位：

```bash
F="docs/design/client/AI Workflows 客户端.dc.html"
grep -n 'data-screen-label' "$F"                      # 屏幕及其起始行号
sed -n '<起>,<止>p' "$F"                               # 读真实 HTML 与内联样式
```

图纸共 10 屏：`01 工作流首页`、`02 画布编辑器`、`03 执行记录`、`04 记忆管理`、
`05 Agent 角色`、`06 提示词库`、`07 模型`、`05 设置与环境`、`06 首次安装与检测`、
`07 技术架构`（末三个的编号在原型里就是这样，不是笔误）。
另有非整屏的浮层：节点配置弹层、运行启动表单、版本抽屉、主管 AI 抽屉。

实现某一屏时先把它的 HTML 读完，逐项对齐布局、间距、图标、文案与状态样式，再动手写组件。

不要做这些事（都属于"自作聪明"，会让 UI 被推翻重做）：

- 改动图纸的布局、间距、字号、颜色、圆角、图标选择
- 改写图纸上的文案，或自行增删界面元素
- 用"更合理""更现代""更简洁"的理由偏离图纸
- 把图纸里的具体界面替换成占位骨架

图纸确实无法直接实现时（例如依赖尚未存在的引擎数据），**先问，不要自己决定替代方案**。

已有的合理偏离只有一处，并且已记录在 `apps/web/src/layout/TitleBar.tsx` 的注释里：
桌面形态不自绘交通灯圆点（macOS 会在 Overlay 位置画同样的按钮，自绘会重叠）。
新增任何偏离都要先确认，并在代码注释与 `docs/adr/` 里写明理由。

### 二、测试先行

先写测试描述期望行为 → 跑一遍确认它失败 → 再写实现。详见 `docs/TESTING.md`。

必须有测试的地方：契约（`packages/contracts` 每个导出）、安全基元（PathGuard / Redactor /
能力校验，每种绕过方式一条用例）、状态机、存储层约束、事件投影、UI 组件的无障碍与空态、
以及**每一个修过的坑**（防止重构时踩回去）。

## 界面审查：六个角色，Claude 执行

自动化测试只回答「我写的断言成不成立」。回答不了的有一整类：
拖起来卡不卡、翻页找不找得到、这个东西看着能点其实点不动、图纸上有的实现里有没有。

那一类走 [`docs/testing/ui-cases/`](docs/testing/ui-cases/README.md)：
**总纲 + 六个角色剧本 + 十七份模块地图**。执行者是 **Claude**。

> 别与下面「ACP：测试与试验优先用 codex」那节混了：那说的是**被测的 adapter**
> （应用要对接哪个 ACP runtime），与**谁来执行审查**是两回事。
> 审查一律 Claude 做；测 AI 功能时仍然优先接 `acp.codex`。

| 角色 | 视角                                               | 静态/动态 |
| ---- | -------------------------------------------------- | --------- |
| F1   | 界面与体验（审美 + 图纸符合性 + 可发现性）         | 动态      |
| F2   | 交互健壮性（性能 + 混沌输入 + 键盘无障碍）         | 动态      |
| F3   | 前端代码审查（重复 / 命名 / 副作用 / 测试覆盖）    | 静态      |
| B1   | 契约与 API 审查（防漂移、DTO 形状、Scope）         | 静态      |
| B2   | 引擎与存储审查（错误处理、并发、事务、失败路径）   | 静态      |
| B3   | 安全与可解释性（脱敏、权限档、界面说的话是否真的） | 动态      |

三条纪律：

- **一个会话一个角色**。换角色开新会话——上一个角色的发现留在上下文里，
  会让下一个带着答案去找问题，那正是漏检的来源
- **要真的点**。每条「预期」都肉眼可验证；看不到就是 FAIL，
  不能因为「代码里写了所以应该对」判 PASS
- **顺序**：F3 → B1 → B2（静态，可并行开子代理）→ F1 → F2 → B3
  （动态，共享浏览器与数据库，必须串行；F2 跑完重建数据库）

判定标准全部量化，写在总纲 §3.5：帧率 ≥55 / 最长帧 ≤50ms、
主操作入口滚动 0px 可见、响应 >1s 必须有中间态且可取消。
每个可点元素过「三问」：想不想点 / 点得动吗 / 点完给的是不是他要的。

产出落在 `docs/testing/evidence/round-<N>/<代号>/`（报告 + 截图 + 控制台日志）。

## 常用命令

```bash
pnpm env:check          # 环境检查：缺什么、怎么装（--json 供程序消费）
pnpm verify             # 提交前的完整门禁，等价于 CI
pnpm dev                # Web 形态 → localhost:5173
pnpm --filter @aiwf/desktop dev     # 桌面 App（自动带起 Web 开发服务器）
pnpm --filter @aiwf/ui preview      # 组件画廊 → localhost:5175
```

测试：

```bash
pnpm test                                            # 全部 TS
pnpm vitest run --project contracts                  # 单个包（contracts/ui/client-core/web/acp-sidecar/mcp-server）
pnpm vitest run packages/contracts/tests/events.test.ts   # 单个文件
pnpm vitest run --project web -t "根路径渲染概览页"    # 单个用例
pnpm rs:test                                         # 全部 Rust
cargo test -p aiwf-store 事件_seq                    # 单个 Rust 用例（需 ~/.cargo/bin 在 PATH）
```

改了契约之后必须重新生成并提交生成物，否则 CI 打回：

```bash
pnpm contracts:gen      # 写入 packages/contracts/generated/
pnpm contracts:check    # 只校验不写（CI 用这条）
```

打包与发布：

```bash
# 本地出 dmg。注意必须用 exec 直传参数
pnpm --filter @aiwf/desktop exec tauri build --target aarch64-apple-darwin

# 线上发布：只手动触发，且只在 main 上跑（缓存作用域的缘故，见下表）
gh workflow run Release --repo HuLuca1998/ai-workflows -f version=0.2.0   # 正式版
gh workflow run Release --repo HuLuca1998/ai-workflows                     # 预发布快照
```

`pnpm run build -- --target ...` 里的 `--` 会把参数交给 cargo 而不是 tauri，
结果 cargo 编到 `target/<triple>/` 而 bundler 去找 `target/release/`，报 `can't open main binary`。

## 架构：三条主线

分层是单向的：`UI → Client Core → Core API → Engine → Store`。
UI 只做「订阅 RunEvent 的只读投影」和「发命令」，不碰文件与进程。

### 1. 契约是单一真源

`packages/contracts`（TypeScript + Zod）定义 Core API 方法表与 Scope 映射、RunEvent 九类事件、
16 种节点定义 Schema（节点库展示 15 条，脚本节点合并）、Run/Node 状态机、结构化 Patch。
它同时服务四方：React 界面、Rust 引擎、Node sidecar、MCP Server。

三道防漂移门禁：

| 门禁                                        | 守什么                                              |
| ------------------------------------------- | --------------------------------------------------- |
| `pnpm contracts:check`                      | `generated/` 与源一致；**手改生成物会被打回**       |
| `crates/engine/tests/contract_sync_test.rs` | Rust 侧镜像（状态机、事件分类、节点数量）没脱离契约 |
| `packages/contracts/tests/`                 | 契约自身的行为（94 项）                             |

节点配置表单由 Schema 驱动渲染 —— **新增节点类型不改 UI 代码**。
如果发现必须改 UI，说明 Schema 表达力不够，那才是要解决的问题。

### 2. RunEvent 是唯一事实来源

不存在第二份运行状态。`packages/client-core/src/event-store.ts` 把同一条流投影成
对话视图、事件视图、产物视图、节点进度、运行状态、可解释性证据（用了哪个模型 / 提示词 /
注入了哪些记忆 / 谁批准了什么）。禁止为某个视图新建状态表，或从消息文本里拼状态字段。

存储层保证 `(run_id, seq)` 唯一且 seq 由存储分配；摘要超 2000 字符直接拒收，
逼大内容走 artifact + `payload_ref`。

### 3. Core API 是唯一写入口

`workflow.patch` 携带 `baseRevision` 做版本守卫，只接受结构化操作
（`addNode` / `connect` / `setConfig`…），**刻意没有整份回写**——那会绕过 Diff 与审计。
`services/mcp-server` 的工具清单由契约派生，不存在旁路；CI 有门禁守这条。

AI 的改动一律先进 `DraftStore.propose()`（出 Diff），用户确认才 `acceptProposal()` 落草稿。

## 关键机制

**桌面与 Web 同形**：`Transport` 接口（`packages/client-core/src/transport.ts`）两端同形，
桌面走 Tauri IPC、Web 走 tRPC + SSE。界面代码不感知差异。
桌面侧的方法名映射在 `apps/web/src/data/workspace.ts`（`workflow.list` → `workflow_list`）。

**草稿与版本分离**：`workflow_revision` 是可变草稿（rev 单调递增），`workflow_version` 是
不可变发布快照（带 config_hash）。运行记录永远引用版本，改草稿不影响运行中的版本。

**版本号不在仓库里**：`tauri.conf.json` 的 version 始终是 `0.0.0`，发布时由 CI 用 jq 注入。
前端读版本必须走 `useAppVersion()`（桌面从 Tauri `getVersion()` 取）——
用 `import.meta.env` 会让应用把自己当 dev 版而跳过更新检查。

**发布只在主动触发时跑**：push main **不**发版（macOS runner 按 10 倍计费）。
只有 `v*` tag 或手动 `workflow_dispatch` 才发。CI 里的 macOS 编译也按变更路径过滤。

## 已经踩过的坑

改这些地方前先看一眼，都有对应的注释或测试：

| 现象                           | 原因                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 窗口拖不动                     | 两个条件都要满足：标题栏有 `data-tauri-drag-region`（只有被标记的元素本身能拖，子元素不冒泡），**且** capabilities 里有 `core:window:allow-start-dragging`。`core:window:default` 是个**空权限集**，窗口操作必须逐条列出 |
| 某个 Tauri 功能安静地不工作    | 先查 capabilities。权限缺失不报错，只是调用被拒——自动更新（`core:app:allow-version`）、窗口拖动（`allow-start-dragging`）都因此栽过                                                                                      |
| 应用报「已损坏」               | Apple Silicon 要求 arm64 有 bundle 级签名；链接器那份 linker-signed 不覆盖 bundle。构建时设 `APPLE_SIGNING_IDENTITY: '-'`                                                                                                |
| CI 代码签名失败                | 空的 `APPLE_CERTIFICATE` 也算「已设置」，tauri-action 会去 import 空证书。必须拆成两个互斥的构建步骤                                                                                                                     |
| Preview.js 显示空组件          | 它不解析 CSF 的 `args`，stories 必须写成函数形式并用 `Frame` 包裹（`packages/ui/src/components/_frame.tsx`）                                                                                                             |
| `pnpm doctor` 跑的不是脚本     | pnpm 有同名内置命令，所以环境检查叫 `env:check`                                                                                                                                                                          |
| Tauri 配置报 BundleTargetInner | `updater` 不是 bundle target，更新包由 `createUpdaterArtifacts: true` 控制                                                                                                                                               |

## 现在做到哪

M0（地基）与 M1（设计态）已完成，下一步是 **M2 执行态**：Rust 引擎、脚本与 worktree 节点、
RunEvent 事件流、启动表单与 Dry Run、并行 / 汇聚调度、审批与检查点、执行记录三级视图。
进度与出口标准见 `docs/ROADMAP.md`。

M2 的出口标准是「杀掉 App 后重启能回到同一审批点；同一工作流不同参数并行运行互不影响；
事件流可完整回放」——三条都要有可执行的验证，而不是手工点一遍确认。

动手前先确认这件事属于哪个里程碑 —— 提前做后面的阶段会让前面的地基失去验证机会。

## ACP：测试与试验优先用 codex

**不要用 claude 的 adapter 做测试和试验**（`acp.claude`）。这个应用本身
跑在 Claude Code 里开发，用它去测会与开发环境撞在一起：嵌套的 agent 会话、
共用的登录态、同一份配额 —— 跑一次测试就可能把正在进行的开发会话搅乱。

契约的 `AGENT_RUNTIMES` 把 `acp.codex` 排在第一位，默认值、探测顺序
（`preferred_acp_runtime()`）、AI 节点的默认 runtime、新建 Agent 表单
都跟着它。详见 `docs/TESTING.md`。

只装了 claude adapter 的机器上仍然要能用 —— 那是退路，不是首选。

## 风格

- 注释与文档用中文，标识符用英文；注释解释「为什么」，不复述「是什么」
- Rust：`unsafe` 在 workspace 级禁用；`unwrap`/`expect`/`panic` 在生产代码里是警告（测试已豁免）
- TypeScript：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开，别关
- Secret 只进 Keychain；仓库、事件、日志、导出物里一律用 `keychain://` 引用
