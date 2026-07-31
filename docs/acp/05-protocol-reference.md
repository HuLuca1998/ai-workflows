# 协议完整参考（对照官方 schema）

来源：<https://agentclientprotocol.com>（[GitHub](https://github.com/agentclientprotocol/agent-client-protocol)）
+ **本机实跑**（`codex-acp 1.1.7`）。本页核对日期 **2026-07-31**。

标着 **实测** 的地方，字节级证据在
[transcripts/](transcripts/README.md)——那不是示例，是真跑出来的往返记录。
**实测与官方文档冲突时，以实测为准并标注版本**：官方页面写的是协议应该长什么样，
runtime 实际发的可能更多（比如两个官方 schema 里没有的 `session/update` 类型）。

[01-protocol-lifecycle](01-protocol-lifecycle.md) 讲的是「一条会话怎么走完」，
是叙事；这一页是**清单**——协议到底有哪些方法、哪些字段、哪些枚举值。
两者的分工：想知道该怎么写看 01，想确认某个东西存不存在看这里。

最后一列 **本仓库**说明我们用没用它。写着「未用」的多数不是遗漏，
是还没到；但**「未用」与「不存在」是两件事**——把没用的东西当成协议不支持，
是这份清单要防的第一件事（02-runtime-findings §5 的 usage 结论就这么翻转过）。

---

## 1. 协议版本

`protocolVersion` 是**单个整数**，标识 MAJOR 版本。当前是 **1**。

协商规则（`initialize`）：

- Client **MUST** 发自己支持的最新版本；
- Agent 支持就回同一个版本，否则 **MUST** 回它支持的最新版本；
- Client 不支持 Agent 回的那个版本时，**SHOULD** 关掉连接并告诉用户。

所以只支持单版本时，「不相等就报错」是合规的（`acp.rs:230` 就是这么写的）。
但**将来支持多版本时必须改成取 agent 回的那个**，不能继续要求相等——
那时相等检查会把一个本可以降级工作的 agent 判死。

---

## 2. Agent 侧方法（Client → Agent）

| 方法 | 用途 | 本仓库 |
|---|---|---|
| `initialize` | 握手：协商版本、交换 capability、拿 authMethods | ✅ `acp.rs:218` |
| `authenticate` | 按 `authMethods` 之一认证 | ⛔ 不需要（复用本机登录态） |
| `logout` | 登出（需 `auth.logout` capability） | ⛔ 未用 |
| `session/new` | 新建会话，传 `cwd` + `mcpServers` | ✅ `acp.rs:300` |
| `session/load` | 恢复会话，**完整重放历史** | ⛔ 未用（见 [07 O-2](07-violations.md)） |
| `session/resume` | 恢复会话，**不重放历史** | ⛔ 未用 |
| `session/list` | 列出该 agent 已有的会话 | ⛔ 未用 |
| `session/close` | 关掉单条会话，**不必杀整个进程** | ⛔ 未用（见 [07 O-5](07-violations.md)） |
| `session/delete` | 删除会话及其历史（需 `session.delete`） | ⛔ 未用 |
| `session/prompt` | 发一轮，阻塞到整个 turn 结束 | ✅ `acp.rs:348` |
| `session/cancel` | 中止当前 turn（**通知，不是请求**） | ⚠️ `acp.rs:388` 实现了但**零调用点** |
| `session/set_mode` | 切权限档 / 沙箱档 | ⛔ 未用（见 [07 O-3](07-violations.md)） |
| `session/set_config_option` | 逐项设置会话配置 | ⛔ 未用 |

**实测可用性**（codex 1.1.7，[codex-new-methods.jsonl](transcripts/codex-new-methods.jsonl)）：

| 方法 | 结果 |
|---|---|
| `session/list` | ✅ 返回 `{sessions:[{sessionId,cwd,title,updatedAt}], nextCursor}` —— **⚠️ 返回的是本机全部会话，跨项目**，见下方警告 |
| `session/set_mode` | ✅ 返回 `{}` |
| `session/close` | ✅ 返回 `{}` |
| `session/resume` | ❌ 刚建、没跑过 turn 的会话上失败：`no rollout found for thread id …`。**要 resume 的会话必须已经落过盘** |

> ⚠️ **`session/list` 是一条数据泄漏通道**。实测一调下去，codex 回了本机
> **25 条会话，全部属于别的项目**，`title` 字段是那些会话的完整 prompt 正文。
> 它读的是 runtime 自己的历史目录，不受你的 cwd 约束。
>
> 要用它做「历史会话列表」的话**必须按 cwd 过滤**，而且要想清楚：
> 那些标题是用户在别处输入的内容，落进你的日志、事件流或导出物就是泄漏。
> 本仓库的 transcript 就因此需要一道脱敏（[06 规则 22](06-repo-rules.md)）。

### `session/new`

```jsonc
{ "cwd": "/绝对路径", "mcpServers": [ … ] }
```

- `cwd` **必需**，必须是**已存在的绝对路径**（[03-pitfalls #8](03-pitfalls.md)）；
- `mcpServers` **必需**（可以是空数组）。HTTP 形态要先确认
  `agentCapabilities.mcpCapabilities.http`——不支持时发过去多半让 `session/new`
  直接失败，那比「没有工具」糟得多（`acp.rs:275` 就是这么防的）。

返回的东西比文档表面上多得多。**实测**（codex 1.1.7，
[codex-handshake.jsonl](transcripts/codex-handshake.jsonl)）：

```jsonc
{
  "sessionId": "019fb64d-ac79-7871-abec-d4c977968bdb",   // uuid v7
  "models": {                                            // ← 模型清单，25 个
    "availableModels": [
      { "modelId": "gpt-5.6-sol[high]", "name": "GPT-5.6-Sol (high)", "description": "…" },
      …
    ],
    "currentModelId": "gpt-5.6-sol[high]"
  },
  "modes": {                                             // ← 权限 / 沙箱档
    "availableModes": [
      { "id": "read-only",        "name": "Read-only",         "description": "Requires approval to edit files and run commands." },
      { "id": "agent",            "name": "Agent",             "description": "Read and edit files, and run commands." },
      { "id": "agent-full-access","name": "Agent (full access)","description": "…network access…" }
    ],
    "currentModeId": "agent"                             // ← 默认就是可读写可跑命令
  },
  "configOptions": [                                     // ← 逐项配置，配 session/set_config_option
    { "id": "mode",              "type": "select", "currentValue": "agent",        "options": […] },
    { "id": "collaboration_mode","type": "select", "currentValue": "default",      "options": […] },  // default / plan
    { "id": "model",             "type": "select", "currentValue": "gpt-5.6-sol",  "options": […] },
    { "id": "reasoning_effort",  "type": "select", "currentValue": "high",         "options": […] },  // low…ultra
    { "id": "fast-mode",         "type": "select", "currentValue": "off",          "options": […] }
  ]
}
```

**三件事值得单独记住**：

1. **模型清单是 agent 给的**。要做「切换模型」的界面，这里就是数据源——
   不必自己维护一张表，也不会列出 agent 其实用不了的模型
   （对照 [07 H-8](07-violations.md)：本仓库的模型下拉列的是自己库里的登记项，
   而且引擎根本不读）；
2. **`currentModeId` 默认是 `agent`**，不是只读。它可读写文件、可跑命令；
3. `configOptions` 里的 `model` 与 `reasoning_effort` 是**分开的两项**，
   而 `models.availableModels` 里是二者的笛卡尔积（`gpt-5.6-sol[high]`）。
   两条路都能设，别设岔了。

### `session/load` 与 `session/resume` 的区别

两者参数相同（`sessionId` + `cwd` + `mcpServers`，支持时还有 `additionalDirectories`），
区别在**要不要重放**：

- `load`：Agent **MUST** 把整段对话以 `session/update` 通知重放给 Client，
  每条带 `messageId`（不透明唯一标识）与 `content`；全部推完才回应原请求。
  界面要恢复历史就用它。
- `resume`：恢复上下文但**不重放**。历史已经在你自己库里时用这个——
  少一次全量回放，会话大时差别明显。

需要 `agentCapabilities.loadSession`。两个 runtime 实测都是 `true`
（[02-runtime-findings §1](02-runtime-findings.md)）。

### `session/prompt`

```jsonc
{ "sessionId": "…", "prompt": [ ContentBlock, … ] }
```

**它阻塞到整个 turn 结束**才 resolve，turn 期间的内容全部由 `session/update`
异步推来。这是流式的唯一来源，也是[天真实现丢掉流式](03-pitfalls.md#7-天真的-runturn-不是流式--设计缺陷)的根因。

返回：

```jsonc
{
  "stopReason": "end_turn",
  "usage": { "inputTokens": 2, "outputTokens": 4,
             "cachedReadTokens": 15498, "cachedWriteTokens": 12973,
             "totalTokens": 28477 }
}
```

`stopReason` 全部取值：

| 值 | 含义 |
|---|---|
| `end_turn` | 模型说完了，没有再要工具 |
| `max_tokens` | 撞到 token 上限 |
| `max_turn_requests` | 撞到单轮模型请求次数上限 |
| `refusal` | agent 拒绝继续 |
| `cancelled` | Client 取消 |

**`max_tokens` / `max_turn_requests` / `refusal` 三种都不是成功**。
把它们与 `end_turn` 一样处理，等于把截断的半个答案当完整答案交出去。

---

## 3. Client 侧方法（Agent → Client）

你声明了对应 capability，agent 才会反向调你。

| 方法 | 用途 | 需要的 capability | 本仓库 |
|---|---|---|---|
| `session/update` | 推送 turn 内的一切（**通知**） | 无 | ✅ `acp.rs:583` |
| `session/request_permission` | 请求逐工具裁决（**请求，阻塞等你**） | 无 | ⚠️ `acp.rs:423` 一律拒（见 [07 H-4](07-violations.md)） |
| `fs/read_text_file` | 代理读文件 | `fs.readTextFile` | ⛔ 声明为 `false` |
| `fs/write_text_file` | 代理写文件 | `fs.writeTextFile` | ⛔ 声明为 `false` |
| `terminal/create` | 起一条终端跑命令 | `terminal` | ⛔ 未声明 |
| `terminal/output` | 取当前输出（不阻塞） | `terminal` | ⛔ 未声明 |
| `terminal/wait_for_exit` | 阻塞等命令结束 | `terminal` | ⛔ 未声明 |
| `terminal/kill` | 杀命令，**保留终端**（还能取输出） | `terminal` | ⛔ 未声明 |
| `terminal/release` | 杀命令并释放，之后 id 失效 | `terminal` | ⛔ 未声明 |
| `elicitation/create` | 向用户要结构化输入（表单 / URL） | `elicitation` | ⛔ 未声明 |
| `elicitation/complete` | 告知 URL 式征询已完成 | `elicitation` | ⛔ 未声明 |

协议级还有一个 `$/cancel_request`，用于取消进行中的请求。

### `session/request_permission`

**这是 request 不是 notification——agent 阻塞等你回**。不回它就一直挂着，
直到你的超时把整轮打断。

**实测**（[codex-permission-readonly.jsonl](transcripts/codex-permission-readonly.jsonl)）：

```jsonc
// 收到（注意 id 从 0 开始，agent 侧的 id 空间与你的独立）：
{ "jsonrpc":"2.0", "id":0, "method":"session/request_permission",
  "params":{
    "sessionId":"019fb652-…",
    "toolCall":{ "toolCallId":"exec-7d752ac7-…", "kind":"edit", "status":"pending" },
    "options":[
      { "optionId":"allow_once",   "name":"Allow Once",        "kind":"allow_once" },
      { "optionId":"allow_always", "name":"Allow for Session", "kind":"allow_always" },
      { "optionId":"reject_once",  "name":"Reject",            "kind":"reject_once" }
    ]}}

// 回：
{ "outcome": { "outcome": "selected", "optionId": "<必须来自 options>" } }
// 或
{ "outcome": { "outcome": "cancelled" } }
```

`kind` ∈ `allow_once` / `allow_always` / `reject_once` / `reject_always`
（codex 实测只给前三种）。

三条硬要求：

1. **optionId 必须从 `options` 里挑**。自己编一个 agent 不认识的 id，
   等于没回答；
2. **`toolCall` 里没有 `title`**——实测只有 `toolCallId` / `kind` / `status`。
   想在弹窗上告诉用户「它要干什么」，得按 `toolCallId` 去关联之前收到的
   `tool_call` 通知（那里才有 `title` 与 `rawInput`）。**只读权限请求本身
   是画不出一个像样的确认框的**；
3. **它是协作式执法**——runtime 不问就不经过你。

第 3 条的分量比文字看起来重得多。实测三组对照
（[transcripts §2](transcripts/README.md#2-权限默认档下我们的裁决代码根本不会被调用-)）：

| 档位 | 请求权限次数 | 文件建了吗 |
|---|---|---|
| `agent`（**codex 默认**）+ 客户端全拒 | **0** | ✅ 建了 |
| `agent` + 客户端全允许 | **0** | ✅ 建了 |
| `read-only` + 客户端全拒 | **2** | ❌ 没建 |

**默认档下你的裁决代码一次都不会被调用。** 真正的开关是
`session/set_mode`。这不是「权限回调是策略层」这句话的抽象重述——
它意味着**只写裁决逻辑、不设档位，等于完全没有防线**
（本仓库正踩着：[07 H-6](07-violations.md)）。

### `fs/read_text_file` / `fs/write_text_file`

```jsonc
// read:  { "sessionId": "…", "path": "/绝对路径", "line": 1, "limit": 100 }
//   →    { "content": "文件内容（保留换行）" }
// write: { "sessionId": "…", "path": "/绝对路径", "content": "…" }
//   →    null
```

`line`（1-based 起始行）与 `limit`（最多几行）都是可选。

官方给的理由是它能读到**编辑器里未保存的状态**，并让 client 追踪 agent 改了什么。
对我们更重要的是另一条：**它是 canonical path guard 唯一能硬落地的地方**。
但边界必须诚实——它只覆盖「编辑器型」文件操作，runtime 自带 shell 写文件不走这里。
实测 claude 走、**codex 完全不走**（[02-runtime-findings §3](02-runtime-findings.md)）。

### `terminal/*`

整个家族靠 `clientCapabilities.terminal: true` 开启，不声明就一个都不会被调用。

```jsonc
// create: { "sessionId", "command", "args": [], "env": [{"name","value"}],
//           "cwd": "/绝对路径", "outputByteLimit": 1048576 }
//   →      { "terminalId": "…" }        ← 立刻返回，不等命令跑完
// output: { "sessionId", "terminalId" }
//   →      { "output": "…", "truncated": false,
//            "exitStatus": { "exitCode": 0, "signal": null } }   ← 结束了才有
// wait_for_exit → { "exitCode": 0, "signal": null }
// kill    → 杀命令，terminalId 仍可用（还能取输出与退出码）
// release → 杀并释放，terminalId 此后对所有 terminal 方法失效
```

`outputByteLimit` 截断按字符边界做，`truncated` 告诉你发生过截断。

终端可以嵌进工具调用：在 `tool_call` 的 `content` 里放
`{"type": "terminal", "terminalId": "…"}`，界面就能实时显示命令输出，
**release 之后仍然继续显示**。

推荐生命周期：`create` →（嵌进 tool_call）→ `output` 轮询或
`wait_for_exit` 阻塞 →（超时就 `kill`）→ **无论如何最后 `release`**。

### `elicitation/*`

`elicitation/create` 让 agent 向用户要结构化输入，能力对象
`ElicitationCapabilities` 区分 form（表单）与 url（跳转）两种模式；
`elicitation/complete` 用于告知 URL 式征询已完成。

与 `session/request_permission` 的分工：**权限是「这件事让不让做」，
征询是「这件事要你补一个值」**。

> 细节（完整字段与 outcome 形状）尚未逐条复验——官方 schema 里有，
> 但本仓库还没有落点。真要接的时候先跑一遍 probe 再照抄这一段。

---

## 4. `session/update` 全部变体

这是你主要消费的东西。

| `sessionUpdate` 值 | 含义 | 本仓库 |
|---|---|---|
| `agent_message_chunk` | 回复正文分片 | ✅ 攒成整段（见 [07 H-2](07-violations.md)） |
| `agent_thought_chunk` | 思考过程分片 | ⚠️ 收到即丢 |
| `user_message_chunk` | 用户消息回放（`session/load` 时才出现） | ⛔ 未用 |
| `tool_call` | 工具调用开始 | ⚠️ 只计数 |
| `tool_call_update` | 工具调用状态变化 | ⚠️ 只计数 |
| `plan` | agent 的执行计划 | ⛔ 丢弃 |
| `current_mode_update` | **agent 自己切了档**，带新的 `modeId` | ⛔ 丢弃 |
| `available_commands_update` | 可用斜杠命令清单变了 | ⛔ 丢弃 |
| `config_option_update` | 会话配置项变了 | ⛔ 丢弃 |
| `usage_update` ⭐ | **官方 schema 未列**：`{used, size}` = 上下文水位 | ⛔ 丢弃 |
| `session_info_update` ⭐ | **官方 schema 未列**：codex 私有线程状态 | ⛔ 丢弃 |

⭐ 那两条是实测抓到的（七个场景里 `usage_update` 出现 18 次、
`session_info_update` 35 次，见
[transcripts](transcripts/README.md#6-实际收到的事件类型八种两种官方文档没列)）。
**这就是为什么消费端不能写成穷举 match 然后对未知类型 panic**——
runtime 会发官方 schema 里没有的东西。

`usage_update` 容易与 `session/prompt` 响应里的 `usage` 搞混，它们是两回事：

| | 形状 | 语义 |
|---|---|---|
| `usage_update` 通知 | `{"used":15317,"size":258400}` | **上下文窗口水位**，turn 进行中流式推 |
| `PromptResponse.usage` | `{totalTokens, inputTokens, cachedReadTokens, outputTokens, thoughtTokens}` | **本轮 token 计费**，turn 结束时一次 |

要在界面上画「上下文快满了」用前者，要算钱用后者。
**codex 的 `usage` 没有 `cost` 字段**（claude 有），多一个 `thoughtTokens`。

两条容易忽略的：

- **`current_mode_update` 是 agent 主动推的**。它会自己从 plan 模式切出来
  （通常经一个「切模式」工具，那个工具照样会请求权限）。不听这条通知的话，
  界面显示的权限档会与实际的不一致——**而界面上写着档位名**。
- **`available_commands_update` 可以在会话中途多次推**。斜杠命令不是建会话时
  定死的一张表。

### `tool_call` / `tool_call_update`

```jsonc
{ "toolCallId": "…", "title": "人话描述在干什么",
  "kind": "execute", "status": "in_progress",
  "content": [ … ], "locations": ["/受影响的文件"],
  "rawInput": { … }, "rawOutput": { … } }
```

**`tool_call_update` 里除 `toolCallId` 外全是可选**，只带变了的字段。
所以界面必须**按 `toolCallId` 合并**，否则一次工具调用会显示成好几条。

`kind` 全部取值：`read` / `edit` / `delete` / `move` / `search` / `execute` /
`think` / `fetch` / `other`（默认）。

`status` 流转：`pending`（等审批或正在流式接收参数）→ `in_progress` →
`completed` / `failed`。

`content` 里三种块：

| 类型 | 形状 | 用途 |
|---|---|---|
| `content` | `{"type":"content","content":{…}}` | 普通内容块 |
| `diff` | `{"type":"diff","path","oldText","newText"}` | 文件改动，`oldText` 为 null 表示新建 |
| `terminal` | `{"type":"terminal","terminalId"}` | 实时命令输出 |

> **修正**：`rawInput` / `rawOutput` 是官方 schema 里的**正式字段**，
> 不是扩展字段。01-protocol-lifecycle 早期版本说它们「不在 SDK 的
> TypeScript 类型里，取的时候要 `as unknown` 绕过」——那是 0.4.5 时代的情况，
> 已经不成立。

---

## 5. Capabilities 全字段

### ClientCapabilities（你在 `initialize` 里声明）

```jsonc
{
  "fs": { "readTextFile": true, "writeTextFile": true },
  "terminal": true,
  "elicitation": { /* form / url 两种模式 */ },
  "session": { "configOptions": { "boolean": { … } } }
}
```

**声明什么决定 agent 会不会反向调你**。声明了却不实现比不声明糟——
agent 调过来你回 `-32601`，它可能整轮失败。

### AgentCapabilities（agent 在握手响应里回）

**实测**（`codex-acp 1.1.7`，2026-07-31，
[codex-handshake.jsonl](transcripts/codex-handshake.jsonl)）：

```jsonc
{
  "auth": { "logout": {} },
  "providers": {},
  "loadSession": true,
  "promptCapabilities": { "embeddedContext": true, "image": true },
  "sessionCapabilities": {                 // ← 注意字段名是 sessionCapabilities
    "resume": {}, "list": {}, "close": {}, "delete": {}, "additionalDirectories": {}
  },
  "mcpCapabilities": { "acp": false, "http": true, "sse": false }
}
```

三点只有实测才看得到：

- **字段名是 `sessionCapabilities`**，子项是**空对象而不是布尔**——
  `if (caps.session?.close === true)` 这种判法会全部落空，
  要判的是**键存不存在**；
- codex 1.1.7 **五项会话能力全支持**（resume / list / close / delete /
  additionalDirectories），本仓库一个都没用；
- 握手响应还带 `agentInfo`（`{name, title, version}`）与
  `_meta.steering.supported`——版本号从这里取，比问 CLI 可靠。

用之前**先查这张表**，别假定。`mcpCapabilities.http` 尤其重要：
不支持时把 HTTP 形态的 MCP server 发过去会让 `session/new` 直接失败。

---

## 6. ContentBlock 全类型

`session/prompt` 的 `prompt` 是 ContentBlock 数组，不只是文本。

| 类型 | 字段 | 需要的 promptCapability |
|---|---|---|
| `text` | `type` / `text` / `annotations` | **无——所有 agent MUST 支持** |
| `image` | `type` / `mimeType` / `data` / `uri` / `annotations` | `image` |
| `audio` | `type` / `mimeType` / `data` / `annotations` | `audio` |
| `resource`（嵌入式） | `type` / `resource{uri, mimeType, text\|blob}` / `annotations` | `embeddedContext` |
| `resource_link` | `type` / `uri` / `name` / `mimeType` / `title` / `description` / `size` / `annotations` | 无 |

**嵌入式 resource 与 resource_link 的分工**：嵌入式把内容直接塞进请求，
用于 agent 自己够不着的来源（比如我们库里的草稿图）；resource_link 只给指针，
让 agent 自己去取。

> 本仓库目前只发 `[{ "type": "text", "text": … }]` 一种（`acp.rs:352`）。
> 把当前草稿图作为嵌入式 resource 发过去，比现在拼进提示词正文更合适——
> 见 [06 规则 2](06-repo-rules.md)。

---

## 7. 斜杠命令

Agent 通过 `available_commands_update` 通知推一张表：

```jsonc
{ "name": "web", "description": "搜网页",
  "input": { "hint": "还没输入时显示的提示" } }
```

Client 侧的调用方式很朴素：**就是普通用户消息**，前缀加斜杠——
`/web agent client protocol` 原样放进 `session/prompt` 的文本块，
agent 自己认前缀。

---

## 8. `_meta`

协议给所有消息保留了 `_meta` 字段做扩展。跨实现传私有数据走它，
别往标准字段里塞。

---

## 9. SDK 与协议的关系（别搞混）

`@agentclientprotocol/sdk` 里的 `listSessions` / `resumeSession` /
`closeSession` / `deleteSession` / `setSessionConfigOption`
**不是 SDK 自己的便利封装**，它们背后就是协议方法
`session/list` / `session/resume` / `session/close` / `session/delete` /
`session/set_config_option`。

这件事对我们有实际后果：**Rust 侧没有 SDK**，`crates/engine/src/acp.rs`
是手写 JSON-RPC。所以「SDK 有没有这个方法」在这个仓库里是个假问题——
**该问的是协议有没有**。协议有，我们就能直接发那行 JSON。

`ClientSideConnection` 在 SDK 1.3.0 里标了 `@deprecated` 但仍然导出可用，
推荐写法是 `client({name}).connectWith(stream, ctx => …)`。这只影响
`services/acp-sidecar`，不影响 Rust 侧。

---

## 核对方式

这一页的每一条都可以自己复核：

```bash
# 官方 schema（权威源）
open https://agentclientprotocol.com/protocol/schema

# 本仓库实际发出去的 JSON —— adapter 的 stderr 会打出来
RUST_LOG=debug cargo test -p aiwf-engine acp -- --nocapture
```

结论会过期。**任何「某能力不支持」的判断都要带上日期与版本**，
升级后跑一遍 [reference/probe.ts](reference/probe.ts) 再下结论——
usage 那条结论三个月就翻转了一次。
