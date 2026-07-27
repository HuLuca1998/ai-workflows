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
    terminal: false,
  },
});
```

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
| `resumeSession` | `session/load`（capability 缺失时降级为新建 + 用结构化状态重建 prompt） |
| `runTurn` | `session/prompt`，事件来自 `session/update` 通知流 |
| `cancel` | `session/cancel` |
| `close` | 结束子进程（先等未完成的 update 刷完） |

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

`tool_call` 的 `status` 流转：`pending` → `in_progress` → `completed` / `failed`。
UI 上要按 `toolCallId` 合并同一个工具调用的多条更新，否则会显示成一堆重复条目。

注意 `rawInput` / `rawOutput` 不在 SDK 的 TypeScript 类型里（属于扩展字段），
取的时候要 `as unknown as { rawInput?: unknown }` 绕过类型检查——但它们确实存在
且很有用（工具调用的实际参数与结果）。

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

### SDK 1.x 新增的会话管理方法

0.4.5 没有、1.3.0 有的（都需要 agent 侧声明对应 capability 才可用）：

| 方法 | 用途 |
|---|---|
| `listSessions` | 列出该 agent 下已有的会话 |
| `resumeSession` | 恢复会话（与 `loadSession` 并存，语义更明确） |
| `closeSession` | 显式关闭单个会话，不必杀整个进程 |
| `deleteSession` | 删除会话及其历史 |
| `setSessionConfigOption` | 逐项设置会话配置 |

`closeSession` 值得注意：有了它就能**一个子进程复用多个会话**而不泄漏——
可以重新考虑"一会话一进程"的取舍（那个设计是在没有 `closeSession` 的年代
定下的）。用之前先确认 runtime 是否声明了对应 capability。
