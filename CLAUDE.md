# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 现在的阶段：完善与优化

框架已经建完（M0–M7）。**不再按里程碑推进新范围，也不再按设计图纸施工** ——
界面形态以当前实现为准，图纸已归档到 `docs/archive/design/`，
只在回头查「这一屏当初为什么长这样」时才翻。

工作项来自 [`docs/DEBT.md`](docs/DEBT.md) 与 [`docs/ROADMAP.md`](docs/ROADMAP.md)。
**动手前先看台账**：那里记着「已经声称做完但没做实」的东西，
在这样的地基上加功能只会让账变长。

## 三条不可协商的纪律

### 一、测试先行

先写测试描述期望行为 → 跑一遍确认它失败 → 再写实现。详见 `docs/TESTING.md`。

必须有测试的地方：契约（`packages/contracts` 每个导出）、安全基元（PathGuard / Redactor /
能力校验，每种绕过方式一条用例）、状态机、存储层约束、事件投影、UI 组件的无障碍与空态、
以及**每一个修过的坑**（防止重构时踩回去）。

### 二、绝不假装成功

没实现的东西必须明确报「尚未实现」。这条在 `crates/engine/src/executor.rs`
第 3 行就写着，而 `notify` 节点仍然违反了它 —— 它归在 `entry | end` 那一档，
什么都不做直接返回成功，Dry Run 也不报，还有一条绿着的测试掩护（DEBT.md 的 B-1）。

三种形态都算违反：

- 节点类型在 `IMPLEMENTED` 清单里但 executor 什么都不做
- 配置字段能填能存能校验，而引擎从不读它（**填了不生效比报错更糟**）
- 界面文案承诺了一件事，实现里没有对应代码

拿不准就照 `apps/web/src/editor/NodeConfigDialog.tsx:269` 那个写法：
**在界面上直说「引擎目前不读它，改了也不会生效」**。

### 三、接缝要有守卫

单侧测试全绿而功能不工作，是这个仓库最常见的缺陷形态 ——
DEBT.md 里 7 条坏账有 5 条是这么来的。契约声明了一样东西，
前端实现了消费侧并且测得很认真，后端从不产出它，**两侧的绿灯合起来像一条通的链路**。

契约能声明三样东西（节点类型、配置字段、事件类型），三样都要有跨侧守卫。
有意暂不实现的进白名单**并写明理由**，照 `crates/mcp/src/catalog.rs` 的
`DELIBERATELY_HIDDEN`。

第四道守的是反过来的那半句：**引擎实现了的，够得着吗**
（`crates/engine/tests/capability_reach_test.rs`）。能力校验里给
`script.shell` / `git.worktree` 写的分支一次都没走到过 ——
那几种节点挂不上角色，而角色页顶上写着「权限（引擎强制）」。
够不着的防线比没有防线糟：下一个人会在错的安全假设上继续加东西。

### 推论一：每加一道门禁，配一条故意违反它、断言它变红的元测试

守卫不能证明自己会红，就不是守卫。

### 推论二：这条不只适用于门禁，适用于**每一条测试**

写完把实现改坏，确认它变红 —— 这一步没做，这条测试不算数。
复核那几轮里，我自己写的修复配套测试有相当一部分是假的：
mock 从没起来（10 条 ACP 测试 0.29 秒跑完）、setup 里注入了本该验证的状态、
断言是实现那一行的同义反复、判据的正则匹配不到任何真实写法。

**八种可识别的形态、元测试怎么做、以及「耗时是证据」这类经验判据，
写在 [`docs/TESTING.md`](docs/TESTING.md) 的「测试自己也会假装成功」一节。
动手修坑之前先读它。**

### 推论三：别把「我刚修完还跑了 verify」当成验收

`pnpm verify` 只回答「已有断言成不成立」，而问题恰恰出在断言本身。
复核要换一个会话，专挑刚改过的地方看 —— 写修复的会话带着答案，
找到的只会是它已经想到的那几种。实测：第 7 轮独立 agent 报的四条命中，
三条是上一轮刚提交的东西。做法见 TESTING.md 的
「复核自己的修复」一节。

## 界面审查：六个角色，Claude 执行

自动化测试只回答「我写的断言成不成立」。回答不了的有一整类：
拖起来卡不卡、翻页找不找得到、这个东西看着能点其实点不动、界面说的话是不是真的。

那一类由 **Claude** 分六个角色去点：

| 角色 | 视角                                               | 静态/动态 |
| ---- | -------------------------------------------------- | --------- |
| F1   | 界面与体验（审美 + 一致性 + 可发现性）             | 动态      |
| F2   | 交互健壮性（性能 + 混沌输入 + 键盘无障碍）         | 动态      |
| F3   | 前端代码审查（重复 / 命名 / 副作用 / 测试覆盖）    | 静态      |
| B1   | 契约与 API 审查（防漂移、DTO 形状、Scope）         | 静态      |
| B2   | 引擎与存储审查（错误处理、并发、事务、失败路径）   | 静态      |
| B3   | 安全与可解释性（脱敏、权限档、界面说的话是否真的） | 动态      |

> 别与下面「ACP：测试与试验优先用 codex」那节混了：那说的是**被测的 adapter**
> （应用要对接哪个 ACP runtime），与**谁来执行审查**是两回事。

三条纪律：

- **一个会话一个角色**。换角色开新会话——上一个角色的发现留在上下文里，
  会让下一个带着答案去找问题，那正是漏检的来源
- **要真的点**。每条「预期」都肉眼可验证；看不到就是 FAIL，
  不能因为「代码里写了所以应该对」判 PASS
- **顺序**：F3 → B1 → B2（静态，可并行开子代理）→ F1 → F2 → B3
  （动态，共享浏览器与数据库，必须串行；F2 跑完重建数据库）

判定标准量化：帧率 ≥55 / 最长帧 ≤50ms、主操作入口滚动 0px 可见、
响应 >1s 必须有中间态且可取消。每个可点元素过「三问」：
想不想点 / 点得动吗 / 点完给的是不是他要的。

角色剧本与历史教训在 `docs/archive/`（`ui-cases/` 与 `审查历史.md`）。
发现的问题直接进 `docs/DEBT.md`，不再单独存证据目录 ——
过程报告的价值在结论，而结论应该长在台账上。

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
pnpm vitest run --project contracts                  # 单个包（contracts/ui/client-core/web/acp-sidecar）
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

**引擎自己应用 Patch**（ADR-0009）。`crates/engine` 里有 `patch.rs` /
`validate.rs` / `diff.rs`，与 `packages/contracts` 那三份 TypeScript
**逐字等价**——包括错误文案。两份实现的代价由
`crates/engine/tests/conformance_test.rs` 对冲：43 组夹具的期望输出由
TypeScript 那份算出来写进 `generated/conformance.json`，Rust 逐条比。
改任何一侧的行为，它会先红一次。

`workflow_save_draft`（整份回写）只留给界面 —— 界面在本地已经走过一次
applyPatch，Diff 给用户看过了。它**不对 MCP 开放**。

AI 的改动一律先进 `DraftStore.propose()`（出 Diff），用户确认才 `acceptProposal()` 落草稿。

### 4. 系统级 MCP 是对外的唯一门

`crates/mcp` 把整个应用通过 MCP Streamable HTTP 开出去：50 个工具
（清单 = 契约方法 ∩ 可分派命令，由契约派生）、7 份系统知识资源、
2 条提示词模板。详见 [`docs/MCP.md`](docs/MCP.md)。

三件事必须记住：

- **调用一律经 `aiwf_core_api::dispatch`**，没有直连数据库或文件的路径
- **写操作挂在权限档上**，与节点执行同一个开关；认不出的档位按最严处理
- **主管 AI 走的是同一条**：`session/new` 把这个 MCP 接给 ACP agent，
  所以界面里的 AI 与外部客户端看到的是同一份能力与知识

加一个 Core API 命令时，它会**自动**出现在 MCP 里（`catalog_test` 守着
「界面上有的 MCP 里也有」）。真要藏就写进 `DELIBERATELY_HIDDEN` 并说明理由。

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
| 打包版说什么工具都没装         | GUI 进程由 launchd 拉起，`PATH=/usr/bin:/bin:/usr/sbin:/sbin`、`cwd=/` —— nvm 的 node、homebrew 的 gh 全找不到。**所有子进程都走 `aiwf_engine::tooling`**，别直接 `Command::new`。dev 从终端起，看不见这个坑             |
| 提示词 / 记忆页报「不合契约」  | 种子 SQL 写进去的**值**不合契约（`datetime('now')` 不是 ISO、枚举外的值）。字段名由 dto-drift 守着，值层面归 `crates/core-api/tests/seed_contract_test.rs` —— 加内置数据前先跑它                                         |
| 应用报「已损坏」               | Apple Silicon 要求 arm64 有 bundle 级签名；链接器那份 linker-signed 不覆盖 bundle。构建时设 `APPLE_SIGNING_IDENTITY: '-'`                                                                                                |
| CI 代码签名失败                | 空的 `APPLE_CERTIFICATE` 也算「已设置」，tauri-action 会去 import 空证书。必须拆成两个互斥的构建步骤                                                                                                                     |
| Preview.js 显示空组件          | 它不解析 CSF 的 `args`，stories 必须写成函数形式并用 `Frame` 包裹（`packages/ui/src/components/_frame.tsx`）                                                                                                             |
| `pnpm doctor` 跑的不是脚本     | pnpm 有同名内置命令，所以环境检查叫 `env:check`                                                                                                                                                                          |
| Tauri 配置报 BundleTargetInner | `updater` 不是 bundle target，更新包由 `createUpdaterArtifacts: true` 控制                                                                                                                                               |

## 接下来做什么

排期在 `docs/ROADMAP.md`，具体条目在 `docs/DEBT.md`。当前最该先修的六条：

| 顺序 | 事项                                       | 为什么排这里                                     |
| ---- | ------------------------------------------ | ------------------------------------------------ |
| 1    | `notify` 节点假装成功                      | 示例工作流里就有一个，用户第一次跑就撞上         |
| 2    | 杀掉 App 后运行永远卡在「运行中」          | 用户可见，而且连「恢复」都点不了                 |
| 3    | worktree 不清理                            | 唯一一条在用户磁盘上持续累积的                   |
| 4    | **三条接缝守卫**（节点类型/配置字段/事件） | 这三条是**成因**。不补，前面几条会以新形态长出来 |
| 5    | 23 个事件类型零发射                        | 违反架构第一原则「RunEvent 是唯一事实来源」      |
| 6    | 提示词库接上执行路径                       | 一整屏功能没有出口                               |

**修一条就从 DEBT.md 里删掉它**，不要标「已修」—— `git log` 是历史，那份文件是现状。

还没开始做的能力（`branch` / `mcp.tool` / `subworkflow` 等节点、WKWebView 性能基准、
Web 形态）排在还账之后，理由见 ROADMAP。

## ACP：全部 AI 能力的唯一入口

**改任何 ACP 代码之前先读 [`docs/acp/`](docs/acp/)** ——
那里有协议参考、22 条使用规范、当前违反清单、两个 runtime 的差异表，
以及 12 份**真实往返记录**（`docs/acp/transcripts/`，不是示例，是跑出来的字节）。

三件必须先知道的事：

1. **协议一致，语义不一致**。claude 与 codex 的档位名零交集，
   默认档一个会问权限、一个不问；模型清单在两个不同字段；
   `cost` 只有 claude 报。差异表与抽象层设计在
   [`08-runtime-abstraction.md`](docs/acp/08-runtime-abstraction.md)
2. **一条对话 = 一条 ACP 会话，系统提示词只在首轮发**。
   ACP 会话自带上下文，两端实测都成立。每轮新建会话 = agent 手上永远是白纸
3. **`session/new` 之后必须 `set_mode`**。不设就是 runtime 的默认档，
   而 codex 的默认档是 `agent`（可读写、可跑命令、**不问权限**）——
   客户端那套裁决代码在那一档下一次都不会被调用

### 测试与试验优先用 codex

**不要用 claude 的 adapter 做日常测试**（`acp.claude`）。这个应用本身
跑在 Claude Code 里开发，用它去测会与开发环境撞在一起：嵌套的 agent 会话、
共用的登录态、同一份配额 —— 跑一次测试就可能把正在进行的开发会话搅乱。

契约的 `AGENT_RUNTIMES` 把 `acp.codex` 排在第一位，默认值、探测顺序
（`preferred_acp_runtime()`）、AI 节点的默认 runtime、新建 Agent 表单
都跟着它。详见 `docs/TESTING.md`。

只装了 claude adapter 的机器上仍然要能用 —— 那是退路，不是首选。
**但退路也要验**：涉及跨 runtime 语义的改动（权限、模型、配置项）
必须两端各跑一遍探针，那类差异只测一端发现不了。

```bash
PATH="$PWD/node_modules/.bin:$PATH" \
  node docs/acp/reference/transcript-probe.mjs handshake --agent codex
```

⚠️ **落盘的往返记录进仓库前必须脱敏**（探针会自动调）。
`session/list` 返回本机全部会话、跨项目——实测 claude 侧 766 条，
codex 侧 25 条带完整 prompt 正文。

## 风格

- 注释与文档用中文，标识符用英文；注释解释「为什么」，不复述「是什么」
- Rust：`unsafe` 在 workspace 级禁用；`unwrap`/`expect`/`panic` 在生产代码里是警告（测试已豁免）
- TypeScript：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开，别关
- Secret 只进 Keychain；仓库、事件、日志、导出物里一律用 `keychain://` 引用
