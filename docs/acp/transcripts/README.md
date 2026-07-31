# 真实往返记录（jsonl）

**这不是示例，是真跑出来的字节。** 每个文件是一次完整的 ACP 会话，
从 `initialize` 到进程结束，每一行 JSON-RPC 原样落盘。

- **环境**：Node v25.6.1 · macOS · 2026-07-31
  - `@agentclientprotocol/codex-acp 1.1.7`，模型 `gpt-5.6-sol[high]`（8 个场景）
  - `@agentclientprotocol/claude-agent-acp 0.63.0`，模型 default（4 个场景）
- **产生方式**：[`../reference/transcript-probe.mjs`](../reference/transcript-probe.mjs)，
  手写 JSON-RPC，**与 `crates/engine/src/acp.rs` 同构**——
  记录下来的就是我们实际会发出去的东西，不是 SDK 美化过的版本

> **两端对比的完整结论在 [08-runtime-abstraction](../08-runtime-abstraction.md)。**
> 一句话：协议一致，语义不一致——最要命的是权限档
> （claude 默认会问、codex 默认不问）。

## 格式

每行一条：

```jsonc
{"t": 173, "dir": "←", "raw": { …原始 JSON-RPC… }}
```

| `dir` | 含义 |
|---|---|
| `→` | 我们发给 agent 的 |
| `←` | agent 发给我们的（含它反向调我们的请求） |
| `#` | 探针自己的标注（阶段说明、stderr、结论） |

`t` 是相对这次会话开始的毫秒数——**耗时是证据**：握手 173ms、
一轮真实对话 10~30s，如果哪条测试「0.3 秒跑完全部 ACP 用例」，
那它没有真的连上。

## 怎么读

```bash
# 按顺序看整条会话
node -e "require('fs').readFileSync('docs/acp/transcripts/codex-multi-turn.jsonl','utf8')
  .trim().split('\n').map(JSON.parse)
  .forEach(e => console.log(e.dir, e.t+'ms', JSON.stringify(e.raw).slice(0,200)))"

# 只看某一类事件
grep -o '"sessionUpdate":"[a-z_]*"' codex-multi-turn.jsonl | sort | uniq -c
```

---

## 十二份记录

### codex（`codex-acp 1.1.7`）

| 文件 | 证明了什么 |
|---|---|
| [`codex-handshake.jsonl`](codex-handshake.jsonl) | agent 声明的全部能力、`session/new` 返回的 **models / modes / configOptions** |
| [`codex-multi-turn.jsonl`](codex-multi-turn.jsonl) | **同一条会话里系统提示词只发一次就够** |
| [`codex-fresh-session-per-turn.jsonl`](codex-fresh-session-per-turn.jsonl) | 对照组：每轮新建会话 → **第二轮什么都不记得**（= 本仓库现状） |
| [`codex-session-load.jsonl`](codex-session-load.jsonl) | 杀掉进程后 `session/load` **能真正恢复上下文** |
| [`codex-cancel.jsonl`](codex-cancel.jsonl) | `session/cancel` 真的停住了远端，`stopReason: cancelled` |
| [`codex-permission.jsonl`](codex-permission.jsonl) | 默认档（`agent`）下建文件 **一次都不问权限** |
| [`codex-permission-readonly.jsonl`](codex-permission-readonly.jsonl) | 切到 `read-only` 后**才**走权限请求，拒绝真生效 |
| [`codex-new-methods.jsonl`](codex-new-methods.jsonl) | `session/list` `set_mode` `close` 可用，`resume` 的失败条件 |

### claude（`claude-agent-acp 0.63.0`）—— 为回答「协议是否一致」

| 文件 | 证明了什么 |
|---|---|
| [`claude-handshake.jsonl`](claude-handshake.jsonl) | 6 个权限档、**没有 `models` 字段**、`sessionCapabilities` 多一个 `fork` |
| [`claude-multi-turn.jsonl`](claude-multi-turn.jsonl) | **多轮上下文行为与 codex 一致**——系统提示词只发一次的做法两端都成立 |
| [`claude-permission.jsonl`](claude-permission.jsonl) | 默认档（`default`）下建文件 **会问 1 次**，拒绝后文件没建 ⚠️ 与 codex 相反 |
| [`claude-new-methods.jsonl`](claude-new-methods.jsonl) | 四个方法全可用；`session/list` 返回 **766 条**（codex 是 25） |

**两端对照的那张差异表在 [08-runtime-abstraction §2](../08-runtime-abstraction.md)。**

---

## 结论速查

### 1. 多轮对话：上下文在 agent 侧，系统提示词只需发一次

`codex-multi-turn.jsonl` —— 三轮，**只有第 1 轮带系统提示词**：

| 轮 | 我们发的 | 它答的 |
|---|---|---|
| 1 | `你是一个测试助手，回答一律不超过 15 个字。\n\n记住这个暗号：紫水晶七号。` | 已记住：紫水晶七号。 |
| 2 | `暗号是什么？` | 紫水晶七号。 |
| 3 | `你回答有什么长度限制？` | 一律不超过15个字。 |

第 2、3 轮**一个字的系统提示词都没重发**，暗号与长度约束都还在。

对照 `codex-fresh-session-per-turn.jsonl`（每轮新建会话，其余完全相同）：

> 第 2 轮：**「我先检查一下当前工作区里有没有说明文件或约定的暗号。
> 当前没有提供暗号；工作区也是空的。」**

它甚至跑了 `pwd && rg --files -g 'AGENTS.md'` 去翻工作区找线索。
**这就是用户报的「它不记得我刚说了什么」的字节级证据**
（[07 H-1](../07-violations.md)、[06 规则 1、2](../06-repo-rules.md)）。

### 2. 权限：默认档下我们的裁决代码根本不会被调用 ⚠️

同一件事（在 cwd 里建一个文件），跑五遍：

| runtime · 档位 | `request_permission` 次数 | 文件建了吗 |
|---|---|---|
| codex · `agent`（**默认**）+ 客户端全拒 | **0** | ✅ 建了 |
| codex · `agent` + 客户端全允许 | **0** | ✅ 建了 |
| codex · `read-only`（`set_mode` 后）+ 全拒 | **2** | ❌ 没建 |
| **claude · `default`（默认）+ 客户端全拒** | **1** | ❌ **没建** |
| **claude · `default` + 客户端全允许** | **1** | ✅ 建了 |

**同一份客户端裁决代码，在 claude 上是一道真防线，在 codex 上一次都没被调用。**

这条差异有个副作用值得记住：**只用 claude 测过权限的人会看到一切正常**——
而本仓库的首选 runtime 是 codex。差异的完整清单见
[08-runtime-abstraction §2](../08-runtime-abstraction.md)。

两条硬结论：

1. **`session/set_mode` 才是执法开关**，客户端的裁决逻辑只在
   `read-only` 档下才会被调用；
2. 本仓库 `acp.rs:423` 那段「一律挑 reject」的代码，在当前配置下
   **一次都没生效过**——而主管 AI 的 cwd 是应用数据目录。
   这不是「防线太严」，是**防线够不着**（[07 H-6](../07-violations.md)）。

read-only 档下拒绝是**真生效**的，而且 agent 会说清楚：

> 「我现在创建该文件。无法完成：写入权限请求被拒绝，`hello.txt` 未创建。」

权限请求的真实形状（注意 **`toolCall` 里没有 `title`**，
想显示「它要干什么」得靠 `tool_call` 通知）：

```jsonc
{ "jsonrpc":"2.0", "id":0, "method":"session/request_permission",
  "params":{
    "sessionId":"019fb652-…",
    "toolCall":{ "toolCallId":"exec-7d752ac7-…", "kind":"edit", "status":"pending" },
    "options":[
      { "optionId":"allow_once",   "name":"Allow Once",        "kind":"allow_once" },
      { "optionId":"allow_always", "name":"Allow for Session", "kind":"allow_always" },
      { "optionId":"reject_once",  "name":"Reject",            "kind":"reject_once" }
    ]}}
```

### 3. `session/load` 能真正恢复上下文

`codex-session-load.jsonl`：建会话 → 记住暗号「青金石九号」→ **SIGKILL 掉整个进程**
→ 新进程 `initialize` → `session/load` 同一个 sessionId → 回放 2 条
`*_message_chunk` → 追问「暗号是什么？」→ **「青金石九号」**。

所以 [07 H-4](../07-violations.md)（翻开历史会话时 agent 一无所知）
是可修的，能力现成。

`session/resume` 在**刚建、还没跑过 turn** 的会话上会失败：

```json
{"code":-32603,"message":"Internal error",
 "data":{"details":"no rollout found for thread id 019fb64f-…"}}
```

要 resume 的会话必须已经落过盘。

### 4. `session/cancel` 真的停得住

`codex-cancel.jsonl`：让它「从 1 数到 300」，4 秒后发 `session/cancel`
（**通知，不是请求**），4007ms 时 `session/prompt` 就带着
`stopReason: "cancelled"` 返回了，正文只吐了 26 个字符。

对照本仓库现状：取消按钮只是让界面不再等，远端照跑
（[07 H-7](../07-violations.md)）。

### 5. `session/new` 一次性给了模型清单、模式、配置项

**这一条直接改变了 [07 H-8](../07-violations.md)（模型下拉是装饰）的性质**——
不是「协议不支持选模型」，是我们没接：

```jsonc
{ "sessionId":"019fb64d-…",
  "models":{ "availableModels":[ /* 25 个，gpt-5.6-sol[low…ultra]、terra、luna、5.5、5.2 */ ],
             "currentModelId":"gpt-5.6-sol[high]" },
  "modes":{ "availableModes":[
             {"id":"read-only","name":"Read-only","description":"Requires approval to edit files and run commands."},
             {"id":"agent","name":"Agent","description":"Read and edit files, and run commands."},
             {"id":"agent-full-access","name":"Agent (full access)","description":"…network access…"}],
            "currentModeId":"agent" },
  "configOptions":[ /* mode / collaboration_mode / model / reasoning_effort / fast-mode */ ]}
```

顺带修正 [02-runtime-findings §6](../02-runtime-findings.md)：codex 的档位名
**不再是** `read-only` / `auto` / `full-access`，1.1.7 上是
`read-only` / `agent` / `agent-full-access`，**默认 `agent`**。

### 6. 实际收到的事件类型（八种，两种官方文档没列）

七个场景累计：

| `sessionUpdate` | 次数 | 说明 |
|---|---|---|
| `agent_message_chunk` | 125 | 正文分片 |
| `session_info_update` | 35 | **官方 schema 未列**，codex 私有：`_meta.codex.threadStatus` |
| `usage_update` | 18 | **官方 schema 未列**：`{used, size}` = 上下文已用 / 窗口大小，**流式推送** |
| `agent_thought_chunk` | 14 | 思考分片，带 `messageId` |
| `available_commands_update` | 10 | 斜杠命令表 |
| `tool_call` | 8 | 带 `title`（完整命令行）、`rawInput`、`content[{type:"terminal"}]` |
| `tool_call_update` | 8 | 带 `rawOutput.{formatted_output,exit_code}` |
| `user_message_chunk` | 1 | 只在 `session/load` 回放时出现 |

`usage_update` 值得单独说：它是**流式的上下文水位**（`used/size`），
与 `session/prompt` 响应里那个 `usage`（token 计费）是两回事，两个都有。

**codex 侧的 `usage` 没有 `cost` 字段**，而 claude 有
（[02 §5](../02-runtime-findings.md)）。codex 实测形状：

```json
{"totalTokens":15369,"inputTokens":255,"cachedReadTokens":15104,
 "outputTokens":10,"thoughtTokens":0}
```

比 claude 多一个 `thoughtTokens`，少 `cachedWriteTokens` 与 `cost`。

### 7. 没声明 terminal capability 时，codex 走 `_meta` 私有通道

我们在 `initialize` 里 `fs` 给的是 `false`，`terminal` 根本没声明。
codex 照样跑了命令，把输出塞在 `tool_call_update._meta.terminal_output_delta`
与 `_meta.terminal_exit` 里。

也就是说**它不会因为你没声明能力就不干活，只是改用私有字段**——
想拿到标准化的终端流（以及在我们进程里管住它），得声明
`terminal: true`（[07 O-7](../07-violations.md)）。

---

## 重跑与脱敏

```bash
PATH="$PWD/node_modules/.bin:$PATH" node docs/acp/reference/transcript-probe.mjs <场景>
```

场景名见上表（`handshake` / `multi-turn` / `fresh-session-per-turn` /
`session-load` / `cancel` / `permission` / `permission-readonly` / `new-methods`）。
除 `handshake` 外都会产生**真实模型调用**。

> ⚠️ **提交前必须过脱敏**（探针跑完会自动调，手动补跑用
> `node docs/acp/reference/redact-transcript.mjs`）。
>
> 这是一次真实事故的教训：`session/list` 一调下去，codex 把**本机全部
> 会话**都回了过来——实测 25 条，**全部属于别的项目**，`title` 字段是那些
> 会话的完整 prompt 正文。`available_commands_update` 同理会带上本机装的
> 全部 skill 及其描述（实测 43 个）。
>
> 这两样都是**用户的东西，不是协议的东西**。脱敏器保留结构、抹掉内容。
> 它也是 [06 规则 22](../06-repo-rules.md) 的由来。
