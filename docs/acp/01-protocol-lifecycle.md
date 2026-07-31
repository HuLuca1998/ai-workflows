# ACP 协议与会话生命周期

## 1. 通信模型

```
你的程序（client）  ←── JSON-RPC 2.0 over stdio (ndjson) ──→  claude-agent-acp / codex-acp（agent）
                                                                  └── 内含完整 agentic loop
```

- **传输**：子进程的 stdin/stdout，每行一条 JSON（ndjson）。stderr 是纯日志，
  必须单独收集——agent 崩溃时错误信息只在 stderr 里。
- **双向**：不只是你调它。agent 也会**反向调用你**（请求权限、读写文件），
  所以你要实现一个 `Client` 处理器。
- **一个子进程可以开多个 session**；但如果你要的是强隔离（每个任务独立进程、
  独立生命周期、杀掉互不影响），就一会话一进程。PolyCrew 选了后者，代价是
  进程数上限要自己管（见 [04-recipes](04-recipes.md) 会话池）。

## 2. 生命周期

```
spawn 子进程
  └→ initialize            协商协议版本、交换 capability、拿 authMethods
      └→ (authenticate)    通常不需要：直接复用本机登录态
          └→ session/new   传 cwd + mcpServers，返回 sessionId 和 modes
              └→ session/prompt      ← 主循环，可多次调用（多轮对话）
                  ├→ session/update     agent 推来的通知流（消息/思考/工具调用/计划）
                  ├→ session/request_permission   agent 反向请求你裁决
                  └→ fs/read_text_file, fs/write_text_file   agent 反向读写文件（若你声明了 fs capability）
              └→ session/cancel   中止当前 turn
          └→ session/load  跨进程恢复历史会话（optional capability）
kill 子进程
```

### 关键点

**`initialize` 里你要声明 client capability**，决定 agent 会不会反向调你：

```ts
await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },  // 声明后 agent 才会走 fs 代理
    terminal: false,        // ← 不是简单开关：它开启的是整个 terminal/* 家族（5 个方法）
    // elicitation: { … }   // 让 agent 能向用户要结构化输入（表单 / URL）
  },
});
```

**声明是一份承诺，两个方向都要兑现**：声明了不实现，agent 调过来吃到
`-32601`，整轮可能失败；该声明的不声明，等于自断一条能力——
`fs` 给 false 就意味着 claude 不走你的 fs 代理，path guard 没有落点。
全部字段见 [05-protocol-reference §5](05-protocol-reference.md)。

返回值里最有用的三个字段：
- `agentCapabilities.loadSession` — 能否跨进程恢复会话（两个 runtime 实测都是 `true`）
- `agentCapabilities.promptCapabilities` — prompt 支持哪些内容类型
- `authMethods` — 需要认证时可用的方法；本机已登录时用不到

**`session/new` 的 `cwd` 必须是已存在的绝对路径**。这是 agent 的工作目录，
也是它文件操作的基准。agent 不参与选择 cwd——由你（client）决定并校验。

**返回的 `modes`** 是被低估的能力：claude 把 permission mode
（`default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`）、
codex 把 sandbox 档位（`read-only` / `auto` / `full-access`）都作为标准
ACP session modes 暴露，可以用 `session/set_mode` 切换。**这意味着权限姿态
可以被程序标准化设置，不需要为每个 runtime 写私有配置通道**——这是 M0 探针最
有价值的发现之一。

**`session/prompt` 是阻塞的**：它在整个 turn 结束后才 resolve，返回
`{ stopReason }`。turn 期间的所有内容都通过 `session/update` 通知**异步推来**。
这就是为什么天真实现会丢掉流式性（见 [03-pitfalls #7](03-pitfalls.md)）。

## 3. 方法映射（内部接口 → ACP）

如果你要在 ACP 之上封一层通用 adapter 接口，映射关系是：

| 你的接口 | ACP 调用 |
|---|---|
| `createSession` | `initialize` → (`authenticate`) → `session/new` |
| `resumeSession` | `session/load`（要重放历史）或 `session/resume`（不重放）；capability 缺失时降级为新建 + 用结构化状态重建 prompt |
| `runTurn` | `session/prompt`，事件来自 `session/update` 通知流 |
| `cancel` | `session/cancel` |
| `close` | `session/close` 关单条会话；要收进程才结束子进程（先等未完成的 update 刷完） |

**这张表只是常用的五个。** 协议实际有 13 个 agent 侧方法与 11 个 client 侧方法
（`session/list`、`session/delete`、`session/set_mode`、整个 `terminal/*`
与 `elicitation/*` 家族都不在上面）。完整清单见
[05-protocol-reference](05-protocol-reference.md)——
**没列在这张表上不等于协议没有**。

## 4. `session/update` 事件类型

这是你主要要消费的东西。归一化成自己的事件类型（参考实现见
[reference/normalize.ts](reference/normalize.ts)）：

| `sessionUpdate` 值 | 含义 | 归一化建议 |
|---|---|---|
| `agent_message_chunk` | agent 回复正文分片 | 累加成最终回复文本 |
| `agent_thought_chunk` | 思考过程分片 | 单独展示，别混进正文 |
| `user_message_chunk` | 用户消息回放（`session/load` 时才出现） | 恢复历史用 |
| `tool_call` | 工具调用开始（`toolCallId`/`title`/`status`/`rawInput`） | 展示"正在做什么" |
| `tool_call_update` | 工具调用状态变化（`status`/`rawOutput`/`content`） | 按 `toolCallId` 更新同一条 |
| `plan` | agent 的执行计划 | 原样保留 |
| `current_mode_update` | **agent 自己切了档**，带新的 `modeId` | 更新界面上显示的权限档 |
| `available_commands_update` | 可用斜杠命令清单变了（会话中途可多次推） | 刷新命令列表 |
| `config_option_update` | 会话配置项变了 | 更新对应设置 |

`tool_call` 的 `status` 流转：`pending` → `in_progress` → `completed` / `failed`。
UI 上要按 `toolCallId` 合并同一个工具调用的多条更新，否则会显示成一堆重复条目。
`tool_call_update` 里**除 `toolCallId` 外全是可选**，只带变了的字段。

`rawInput` / `rawOutput` 是**官方 schema 里的正式字段**（工具调用的实际参数与结果），
不是扩展字段。

> 这里原先写着「它们不在 SDK 的 TypeScript 类型里，取的时候要 `as unknown`
> 绕过类型检查」——那是 0.4.5 时代的情况，2026-07-31 对照官方 schema 已不成立。
> 各字段的完整形状见 [05-protocol-reference §4](05-protocol-reference.md)。

## 5. 反向调用：权限与文件

### `session/request_permission`

agent 在做敏感操作前请求裁决。**这是 request/response，不是通知**——你必须返回
一个 outcome，agent 阻塞等待你：

```ts
async requestPermission(req) {
  // req.toolCall: { title, kind, ... }
  // req.options: [{ optionId, name, kind }]  kind ∈ allow_once|allow_always|reject_once|reject_always
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
  // 或 { outcome: { outcome: "cancelled" } }
}
```

这是**统一的逐工具调用执法通道**，两个 runtime 都走它。但它是**协作式的**：
runtime 不问就不经过你。所以沙箱兜底不可省（见
[02-runtime-findings](02-runtime-findings.md)）。

### `fs/read_text_file` / `fs/write_text_file`

只有你在 `initialize` 里声明了 `fs` capability，agent 才可能走这条路。
好处是你能在自己进程里做 canonical path guard（硬拦截工作区外的读写）。

**但边界必须诚实**：fs 代理只覆盖"编辑器型"文件操作。runtime 自己的
shell/terminal 写文件不走这里。实测 claude 走 fs 代理，**codex 完全不走**
（用自带 shell）——详见 [02-runtime-findings #3](02-runtime-findings.md)。

### 还有两条反向通道

- **`terminal/*`**（create / output / wait_for_exit / kill / release）：
  声明 `terminal: true` 之后，agent 跑命令会经过你——**这正是补上 codex
  那个缺口的地方**，它自带 shell 绕过 fs 代理，但终端可以由你提供。
  终端还能嵌进 `tool_call` 的 content 实时显示输出。
- **`elicitation/*`**（create / complete）：agent 向用户要结构化输入。
  与权限请求的分工是「这件事让不让做」对「这件事要你补一个值」。

两条本仓库都没声明。字段细节见
[05-protocol-reference §3](05-protocol-reference.md)。

## 6. 会话恢复（`session/load`）

两个 runtime 实测都支持且保真度良好：杀掉进程后重启新进程、`session/load`
同一个 sessionId，历史会被完整回放（用户消息 + agent 消息都以
`*_message_chunk` 通知形式推回来），且新 turn 能正确延续上下文。

策略建议：
1. capability 存在 → 正常恢复。
2. capability 缺失或 load 失败 → 新建会话，用你自己持久化的结构化状态重建 prompt。
   **不要伪造"会话仍连续"的假象**——用户会发现。

恢复需要你持久化 `sessionId` **和 `cwd`**（load 时要重新传 cwd）。

## 7. 关于 SDK 1.x 的新 API

SDK 1.3.0 把 `ClientSideConnection` 和它的构造函数标记为 `@deprecated`，
推荐新写法：

```ts
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

await client({ name: "my-app" }).connectWith(stream, async (ctx) => {
  // ctx: ClientContext，提供 agent 侧方法调用与 session 辅助
});
```

`connectWith(stream, op)` 的语义是"连接在 `op` 的生命周期内有效，`op` resolve
或 reject 时关闭连接"——这与"长期持有一个会话句柄"的用法不完全契合，
迁移时要注意把整个会话生命周期包进 `op` 里，或改用 `connect(stream)` 拿
`ClientConnection`。

`ClientSideConnection` 在 1.3.0 中**依然导出可用**，`ndJsonStream`、
`PROTOCOL_VERSION`、`Client` 接口形状都没变——参考实现就是用它在 1.3.0 上
编译并跑通的。新项目如果想跟上游走，建议先用旧写法跑通、再择机迁移。

### 会话管理方法（**是协议方法，不是 SDK 便利封装**）

0.4.5 时代没有、现在有的一组。SDK 里的名字与协议方法是一一对应的：

| SDK 方法名 | 协议方法 | 用途 |
|---|---|---|
| `listSessions` | `session/list` | 列出该 agent 下已有的会话 |
| `resumeSession` | `session/resume` | 恢复会话，**不重放历史**（与 `load` 并存） |
| `closeSession` | `session/close` | 关掉单条会话，不必杀整个进程 |
| `deleteSession` | `session/delete` | 删除会话及其历史 |
| `setSessionConfigOption` | `session/set_config_option` | 逐项设置会话配置 |

**这个区分对本仓库有实际后果**：Rust 侧没有 SDK，`crates/engine/src/acp.rs`
是手写 JSON-RPC。所以「SDK 有没有这个方法」是个假问题——**协议有，
我们就能直接发那行 JSON**。用之前确认 agent 声明了对应 capability。

`session/close` 值得注意：有了它就能**一个子进程复用多条会话**而不泄漏——
可以重新考虑「一会话一进程」的取舍（那个设计是在它还不存在的年代定下的）。
本仓库的会话池目前仍是一会话一进程，见
[07 O-5](07-violations.md)。
