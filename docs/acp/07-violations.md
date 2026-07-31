# 当前违反清单

**盘点日期**：2026-07-31 · **基线**：`f430b61`
**方式**：逐条读代码 + 跑验证命令 + **双端实跑**（`codex-acp 1.1.7` 8 个场景 · `claude-agent-acp 0.63.0` 4 个）

带 ⚠️ 实测 标记的条目有字节级证据，在
[transcripts/](transcripts/README.md)。其中三条的修法**已经在真实
runtime 上验证可行**（不是「理论上应该能」）：

| 结论 | 证据 |
|---|---|
| 同一条会话里系统提示词只发一次就够，第二轮只发用户原话它照样记得 | [multi-turn](transcripts/codex-multi-turn.jsonl) |
| 每轮新建会话则第二轮什么都不记得（= 现状） | [fresh-session-per-turn](transcripts/codex-fresh-session-per-turn.jsonl) |
| 杀掉进程后 `session/load` 能真正恢复上下文 | [session-load](transcripts/codex-session-load.jsonl) |
| `session/cancel` 真的停住远端 | [cancel](transcripts/codex-cancel.jsonl) |

对照 [06-repo-rules.md](06-repo-rules.md) 的 22 条规则。分两档：

- **硬性错误**：功能不工作，或**界面说了一件实现里没有的事**。必须改。
- **可优化**：协议给了能力，我们没用。不改也能工作，但一直在付利息。

修一条**就从这份文件里删掉它**——`git log` 是历史，这份文件是现状。
（与 [docs/DEBT.md](../DEBT.md) 同一条维护纪律。台账里记的是
`B-8 · 主管 AI 的 ACP 用法`，那条是索引，明细在这里。）

---

## 一、硬性错误

### H-1 · 会话 id 在映射层被丢，每条消息变成一条会话

**位置**：`packages/client-core/src/ipc-mapping.ts:189` · **违反规则 1、19**

```ts
if (method === 'supervisor.ask') {
  return {
    question: record.question,
    ...(record.modelRef ? { modelRef: record.modelRef } : {}),
    contextJson: JSON.stringify(record.context ?? {}),
  };   // ← 白名单里没有 sessionId
}
```

前端是对的：`SupervisorDrawer.tsx:371` 存下后端给的 id，`:341` 下一问带上。
后端也是对的：`SupervisorAnswer` 是 camelCase，池按会话 id 复用。
**钥匙在中间这一层掉了**，而且桌面与 Web 两条路都走它。

连锁后果：

| 位置 | 后果 |
|---|---|
| `dispatch.rs:42` / 桌面 `lib.rs:34` | 收到的 `session_id` 恒为 `None` |
| `core-api/src/lib.rs:2091` | 池键恒为 `新对话:{question}`，**每问一句起一个新 adapter 进程**，重走握手 + `session/new` + MCP 连接 |
| `core-api/src/lib.rs:2144` | 每问一句 `create_supervisor_session`，**历史列表里每条消息一条会话** |
| `acp.rs:865` `rekey` | 改挂到 DB id 后那个键再没人用，空转到 600 秒才回收——连问 5 句挂 5 个 node 进程 |

**掩护**：`apps/web/tests/supervisor-history.test.tsx:150` 那条
「第二问带上后端给的 sessionId」一直是绿的。它 `vi.mock` 掉了整个
`workspace.js`，断言的是**组件传给 `coreClient` 的参数**，
根本不经过 `toIpcInput`。`apps/web/tests/ipc-mapping.test.ts` 覆盖了
run.\* 与分页，**没有一条测 supervisor.ask**。

**验证**：

```bash
grep -A 8 "method === 'supervisor.ask'" packages/client-core/src/ipc-mapping.ts | grep -c sessionId
# 0
```

**⚠️ 实测**：两个场景除「每轮是否新建会话」外完全相同
（[transcripts §1](transcripts/README.md#1-多轮对话上下文在-agent-侧系统提示词只需发一次)）：

| | 第 1 轮「记住暗号：紫水晶七号」 | 第 2 轮「暗号是什么？」 |
|---|---|---|
| 同一条会话 | 已记住：紫水晶七号。 | **紫水晶七号。** ✅ |
| 每轮新建（= 现状） | 记住了：紫水晶七号。 | **「当前没有提供暗号；工作区也是空的。」** ❌ |

对照组里它还跑了 `pwd && rg --files -g 'AGENTS.md'` 去翻工作区找线索 ——
**这就是用户报的「它不记得我刚说了什么」的字节级证据**。

**还清判据**：映射层发出 sessionId；补一条**不 mock transport** 的用例，
断言同一条对话的第二问落在同一个池键上（用 `pid_for_test`——
session id 靠不住，两个新起的 adapter 可能给出一样的 id）。

---

### H-2 · 流式断在 core-api，而且没有推送通道

**位置**：`crates/core-api/src/lib.rs:2112` · **违反规则 4**

```rust
|update| match update {
    SessionUpdate::AgentText { text: chunk } => text.push_str(chunk),  // ← 攒进 String
    SessionUpdate::ToolCall { .. } => tool_calls += 1,                 // ← 只数个数
    _ => {}
}
```

ACP → Rust 这一段是**真流式**（`acp.rs:342` 的 `on_update` 回调做对了）。
断在下一跳：攒完整轮才随 RPC 返回。

而且**没有任何推送通道可用**：

| 位置 | 现状 |
|---|---|
| `ipc-mapping.ts:564` | 桌面 `subscribeEvents` 空实现，注释「事件流在 M2 随引擎接上」 |
| `apps/web/src/data/httpTransport.ts` | Web `subscribeEvents` 空实现，注释「M6 随远程引擎一起做」 |

于是 `SupervisorDrawer.tsx:333` 那条 `streaming: true` 的消息，`text` 永远是
空串，只显示「正在想…」，输入框 `disabled={busy}` 整轮禁用，超时 180 秒。

叠加 H-1（每句重起进程 + 握手 + 重发整份提示词），体感就是卡死。

[03-pitfalls #7](03-pitfalls.md) 用整整一节警告过这个形态——
**它警告的是 TypeScript 写法，我们在 Rust 里换个姿势重现了它**。

**还清判据**：一条从引擎到界面的增量通道（`conversation.agent_delta`
在契约里已经有了，见 [DEBT.md](../DEBT.md) B-2 的 23 个零发射事件），
用户在第一个 token 到达时看到它。

---

### H-3 · 系统提示词每轮重发

**位置**：`crates/core-api/src/lib.rs:2063` · **违反规则 2**

每一轮都调 `supervisor_prompt()` 重拼一整份：应用说明（约 1500 字）+ 工具说明
+ 全部记忆（上限 20 条）+ context JSON + **整张草稿图的 JSON** +
proposal 格式说明，用户那句话拼在最后。

[04-recipes 配方 1](04-recipes.md) 的标题就叫「多轮对话（**系统提示只发一次**）」，
正文写着「重复发不仅浪费 token，还会让模型行为漂移」。

比浪费更糟的是：那 N 份说明里夹着 N 份**已经过期的上下文快照**——
第 1 轮的草稿是 rev 12，第 5 轮已经是 rev 17，而 rev 12 那份还在上下文里。

**注意修复顺序**：H-1 不修，这条无从谈起——每轮都是新会话，
不发系统提示词等于什么都没说。

**还清判据**：`turns == 0` 才拼 preamble；大块上下文改用嵌入式 resource
（[05 §6](05-protocol-reference.md)）；补一条断言「第二轮的 prompt
不含系统提示词特征串」的用例。

---

### H-4 · 翻开历史会话继续问，agent 其实一无所知

**位置**：`apps/web/src/supervisor/SupervisorDrawer.tsx:299` `openSession` · **违反规则 3**

点一条历史会话，界面从数据库读出完整消息渲染出来，然后 `setSessionId(id)`。
用户看到的是「上次那段对话回来了」，接着问下一句——

而那条 ACP 会话早就不在池里了（空闲 600 秒就回收，何况用户是隔天回来的）。
于是新建一条 ACP 会话，**agent 手上是白纸**，全程没有 `session/load`。

**界面显示着完整历史，模型一个字都不知道。**

`agentCapabilities.loadSession` 两个 runtime 实测都是 `true`，
且新 turn 能正确复述之前的内容（[02-runtime-findings §1](02-runtime-findings.md)）——
**能力是现成的，一次都没用过**。

**⚠️ 实测**（[session-load](transcripts/codex-session-load.jsonl)）：
建会话 → 记住暗号「青金石九号」→ **SIGKILL 掉整个进程** → 新进程
`initialize` → `session/load` 同一个 sessionId → 回放 2 条
`*_message_chunk` → 追问「暗号是什么？」→ **「青金石九号」**。

**这条修法已经在真实 runtime 上跑通了**，不是理论上可行。
一个坑：`session/resume`（不重放的那个）在**刚建、还没跑过 turn**
的会话上会报 `no rollout found for thread id …`——要 resume 的会话
必须已经落过盘。

这正是 [03-pitfalls #6](03-pitfalls.md) 那条：「面向用户的状态承诺
（记得 / 忘记 / 恢复）必须在后端真实兑现，用户一测就穿帮。」

**还清判据**：翻开历史会话时走 `session/load`（要重放）或 `session/resume`
（历史已在库里，不必重放）；load 失败就**明说这是新会话**，别假装连续。
持久化 `sessionId` 的同时要持久化 `cwd`。

---

### H-5 · `stopReason` 被丢弃，截断的答案当成功交出去

**位置**：`crates/core-api/src/lib.rs:2099` · **违反规则 5**

```rust
pool.prompt(&池键, || { … }, &prompt, |update| { … })
    .map_err(|error| ApiError { … })?;       // ← 返回值直接丢了
```

`PromptOutcome` 五种取值里只有 `EndTurn` 是正常说完。现在
`MaxTokens`（答案被截断）、`Refusal`（模型拒绝）、`MaxTurnRequests`
全部当成功，用户拿到半个答案而界面上没有任何标记。

**对照**：`executor.rs:659` 的 AI 节点**做对了**——
`Ok(PromptOutcome::Refusal) => Err("模型拒绝了这一轮")`。
同一个客户端、同一个返回值，两条路径两种处理。

**验证**：

```bash
grep -n "pool.prompt" -A 2 crates/core-api/src/lib.rs   # 返回值无绑定
grep -n "PromptOutcome" crates/engine/src/executor.rs   # 节点路径读了
```

**还清判据**：接住 `PromptOutcome`，非 `EndTurn` 的四种各自有说法，
并且这句说明要到达用户。

---

### H-6 · 权限防线够不着：全拒的代码一次都没生效过 ⚠️ 实测

**位置**：`crates/engine/src/acp.rs:423` `answer_reverse_call` · **违反规则 7、8**

```rust
.find(|option| option.get("kind")…is_some_and(|kind| kind.starts_with("reject")))
.or_else(|| options.last())
```

收到 `session/request_permission` 一律挑一个 **reject 类**选项回过去。
看起来是一道很严的防线。

**实测三组对照，同一件事（在 cwd 里建一个文件）**
（[transcripts §2](transcripts/README.md#2-权限默认档下我们的裁决代码根本不会被调用-)）：

| 档位 | `request_permission` 次数 | 文件建了吗 |
|---|---|---|
| `agent`（**codex 默认**）+ 客户端全拒 | **0** | ✅ **建了** |
| `agent` + 客户端全允许 | **0** | ✅ 建了 |
| `read-only`（`set_mode` 之后）+ 客户端全拒 | **2** | ❌ 没建 |

**上面那段代码在当前配置下一次都没有被调用过。** codex 建会话的默认档是
`agent`（「Read and edit files, and run commands」），它自己做主，不问。

于是实际情况是：

1. **主管 AI 对 `data_dir` 有完整的读写与命令执行权限**——
   而 `cwd` 传的就是 `data_dir`（`core-api/src/lib.rs:2097`），
   那里放着这个应用的数据库；
2. **与应用自己的权限档完全无关**。`workspace.settings.permissionPreset`
   有三档，`crates/mcp/src/catalog.rs` 的 `gate_for` 是真拦截，
   ACP 这条通道整个绕过了它。`SupervisorDrawer.tsx:736` 底部还常驻着一行
   「本次会话授予：workflow:read …」——**那行说的权限，管不到这里**；
3. **没有任何裁决落事件流**，而可解释性是这个产品的核心承诺。

这不是「防线太严」，是 **CLAUDE.md 说的那种「够不着的防线」——
比没有防线更糟，因为下一个人会在错的安全假设上继续加东西**。

### 产品决定（2026-07-31）：给 AI 最高权限

项目所有者的决定是**不再对单个节点设权限门槛，AI 按最高权限运行**。

**这不是放弃管控，是把执法层从 ACP 挪到了工作流编排上：**

| 层 | 管什么 |
|---|---|
| ACP（单次 AI 调用） | **不设卡**。逐工具的确认框拦不住设计上就该做的事，只会把每次运行变成点击练习 |
| **工作流编排** | **审批节点就是门禁**。位置由设计者定——比如「编码完成之后、开 PR 之前」插一个 |
| 审批节点自己 | 谁来批可配：**人批，或者 AI 批** |

这套已经在实现了（`2ec6eaf`「审批换成三档『谁来批』」），
判定是**档位 × 操作实际风险**两维，而不是按节点类型一刀切：

| 风险 \ 档位 | 我来审批 | AI 审批 + 关键节点问我 | 无人值守 |
|---|---|---|---|
| `read_only` | 放行 | 放行 | 放行 |
| `workspace_write` | 人工 | AI | AI |
| `external_write` | 人工 | **人工** | AI |

**所以 ACP 层给最高权限与流程层做门禁是同一个设计的两半**，
不是「安全被放弃了」。门设在流程里，比设在每次工具调用上更准——
它拦的是「要不要开这个 PR」，而不是「要不要读这个文件」。

这套**靠一个前提撑着，而那个前提现在是缺的**：

> **门禁要判得准，得知道 AI 干了什么。** 而现在 **23 个事件类型零发射**
> （[DEBT.md](../DEBT.md) B-2），主管 AI 的工具调用只留了个计数
> （[O-4](#二可优化)）。审批节点弹到人面前时，人看到的是「AI 说它改完了」，
> 而不是「它改了这 7 个文件、跑了这 3 条命令」。

**下面第 4 条不是安全要求，是这个架构自己的前提。**

还有一处不在这套覆盖范围内：**主管 AI 不在任何工作流里**。
它是编辑时的自由对话，没有前置审批节点可插，cwd 又是应用数据目录。
它至少要能回答「刚才它动了什么」。

剩下的四件事：

**1. 档位要显式设，不能靠 runtime 默认值。**
现在的「全权限」是 codex 恰好默认 `agent` 带来的副作用，不是我们选的。
而这个默认值**会漂移**——codex 0.16 → 1.1.7 之间档位名已经改过一次
（`auto` → `agent`）。下个版本默认值一变，主管 AI 可能突然什么都做不了，
而代码里没有任何一行表达过「我们要的是全权限」。

所以：`session/new` 之后显式 `session/set_mode`，
codex 用 `agent-full-access`、claude 用 `bypassPermissions`
（[08 的档位映射表](08-runtime-abstraction.md)要相应改成「全部映射到最高档」）。

**2. 界面上那些话必须改成实话。** 这与权限高低无关，是纪律二第三形态：

| 界面上现在写着 | 实际 |
|---|---|
| `SupervisorDrawer.tsx:736`「本次会话授予：`workflow:read` `memory:read`」 | 主管 AI 有 cwd 的完整读写与命令执行权 |
| 同行「任何写操作都需逐项确认」（默认档文案） | 不确认，直接做 |
| 「设置与环境」的权限档三选一 | 对 ACP 这条通道无效 |

**还清判据**：

1. 显式 `set_mode` 到最高档（理由见上，别依赖默认值）；
2. `acp.rs:423` 那段拒绝代码改成放行——**留着一段永不生效的拒绝逻辑
   比没有更糟**，下一个人会以为它在起作用；
3. 界面上那行 Scope 说明改成实话，或者删掉；
4. 裁决与工具调用**仍然要落事件流**——这一条与权限无关，
   是可解释性：用户有权知道 AI 动过什么。

---

### H-7 · 「取消」不取消远端，那一轮照跑

**位置**：`crates/engine/src/acp.rs:388` · **违反规则 12**

`AcpClient::cancel` 实现了 `session/cancel`，**零调用点**。

`SupervisorDrawer.tsx:763` 的取消按钮做的是：把 `askSeq` 加一（让回来的答案被丢掉）、
`setBusy(false)`、留一条「已取消」回执。**远端那一轮还在跑**，
还在烧配额，还占着那个 adapter 进程直到它自己讲完。

**验证**：

```bash
grep -rn "\.cancel(" --include="*.rs" crates/ | grep -v "fn cancel" | grep -v "supervisor\|runner\|run_cancel"
# 无输出
```

**⚠️ 实测**（[cancel](transcripts/codex-cancel.jsonl)）：让它「从 1 数到 300」，
4 秒后发 `session/cancel`（**通知，不是请求**），**4007ms 时
`session/prompt` 就带着 `stopReason: "cancelled"` 返回了**，
正文只吐了 26 个字符。停得干净利落。

**还清判据**：取消要发到 `session/cancel`；超时路径同样要发，
并且发完杀进程组（[03-pitfalls #10](03-pitfalls.md)：只 reject 不取消，
子进程还在跑）。注意它同时也是 H-5 的一半——
取消之后 `stopReason` 是 `cancelled`，得有人读。

---

### H-8 · 主管 AI 的模型下拉是装饰

**位置**：`apps/web/src/supervisor/SupervisorDrawer.tsx:508` · **违反规则 20**

抽屉顶上有一个「切换模型」下拉，列出所有已启用的模型。映射层也老实地把
`modelRef` 发了出去（`ipc-mapping.ts:194`）。

然后就没有然后了：`dispatch.rs:37-43` 与桌面 `lib.rs:31` 都不读它，
`api::supervisor_ask` 的签名里根本没有这个参数。运行时用哪个模型完全由
`preferred_acp_runtime()` 与 adapter 自己的配置决定。

**用户选了另一个模型，什么都不会变，界面上没有任何提示。**
这是 CLAUDE.md 纪律二的第二形态：能填能存能校验，而引擎从不读它。

**验证**：

```bash
grep -rn "modelRef" crates/core-api/src/dispatch.rs apps/desktop/src-tauri/src/lib.rs | grep -i supervisor
# 无输出
```

**实测把这条的性质改了**：原以为「协议不支持选模型，所以只能装饰」——
不是的。`session/new` 的响应里**直接给了模型清单**
（[codex-handshake.jsonl](transcripts/codex-handshake.jsonl)）：

```jsonc
"models": {
  "availableModels": [ /* 25 个：gpt-5.6-sol[low…ultra] / terra / luna / 5.5 / 5.2 */ ],
  "currentModelId": "gpt-5.6-sol[high]"
},
"configOptions": [
  { "id": "model",            "type": "select", "currentValue": "gpt-5.6-sol" },
  { "id": "reasoning_effort", "type": "select", "currentValue": "high" },
  … ]
```

也就是说**数据源本来就在手上**，而且比现在这个下拉更准——
它列的是 agent 真正能用的模型，而当前下拉列的是我们数据库里登记的条目
（那些 id 与 agent 认的 `modelId` 根本不是一套东西）。

**还清判据**：三选一。

1. **真接**：下拉的数据源换成 `session/new` 回的 `configOptions`，
   选择走 `session/set_config_option`；
2. **诚实降级**：照 `NodeConfigDialog.tsx:269` 的写法，在下拉旁边直说
   「引擎目前不读它」；
3. **删掉它**，等真做的时候再加。

**方案 1 已经全程实测过，不再是纸面方案**
（[codex-model.jsonl](transcripts/codex-model.jsonl) /
[claude-model.jsonl](transcripts/claude-model.jsonl)，探针场景 `model`）：

- 清单按 `configOptions` 的 **`category`** 取（`model` / `thought_level`），
  两端同构，**不用 id 映射表**；
- 设置用 `session/set_config_option`（参数名是 **`configId`**），
  响应回全量 `configOptions` 可当场回读；
- 设错值 agent 自己会拒 —— 校验不必我们做；
- **`session/new` 的 params 里带 `model` 是没用的**：两端都静默忽略。

顺带修正一条：`system.model_resolved` 该写**回读到的 `currentValue`**。
codex 的 `_meta.quota.model_usage[].model` 虽然直接报模型名，
但 **claude 没有这个字段** —— 拿它当跨端方案会在 claude 侧写出空事件。

---

### H-9 · 池键用问题原文，问同一句话会撞进同一条会话

**位置**：`crates/core-api/src/lib.rs:2091` · **违反规则 10（历史串味那条）**

```rust
let 池键 = session_id.clone().unwrap_or_else(|| format!("新对话:{question}"));
```

在 H-1 的现状下 `session_id` 恒为 `None`，所以**池键就是问题原文**。
两个人（或同一个人先后）问一模一样的第一句——「你好」「这条工作流怎么改」——
会命中同一个池键，落进**同一条 ACP 会话**，看见彼此的上下文。

H-1 修好之后这条依然存在：两条新对话的第一句相同时照样撞。

**还清判据**：临时键用一个不可能相撞的值（会话建库前先生成 id，
或用一个进程内自增序号），别用用户输入拼。

---

### H-10 · Web 形态下上下文可能整个丢失 ⚠️ 待实证

**位置**：`crates/core-api/src/dispatch.rs:41` · **违反规则 19**

`dispatch` 读的是 `input.get("context")`，而映射层发的是 `contextJson`
（`ipc-mapping.ts:195`）。

桌面那条对得上——Tauri 把 JS 的 `contextJson` 映射到 Rust 参数 `context_json`。
devserver 这条对不上：草稿 rev / runId / workflowId 全丢，
`context_graph` 恒为 `None`，主管 AI 提不出能落地的 proposal。

**这条是读代码推断的，我没有实跑 devserver 验证**。验证方式：

```bash
pnpm dev:server &
# 浏览器里打开主管 AI 问一句，看 devserver 收到的 input 里有没有 context
```

**还清判据**：两条路径接同一份参数名，或让 dispatch 同时认
`context` 与 `contextJson`（照 `agent.update` 的 `capabilitiesJson`
两边都给的做法）。

---

## 二、可优化

协议给了能力，我们没用。按「拿到的收益 ÷ 改动大小」排。

| 编号 | 事项 | 现状 | 收益 |
|---|---|---|---|
| **O-1** | **不读 `usage`** ⚠️ 实测 | `acp.rs:370` 只取了 `stopReason`。codex 实测形状：`{totalTokens:15369, inputTokens:255, cachedReadTokens:15104, outputTokens:10, thoughtTokens:0}`（**没有 `cost`**，claude 有） | 精确的 token 核算——**数据已经在手上，只差读一行** |
| **O-1b** | **不读 `usage_update` 通知** ⚠️ 实测 | 七个场景里推了 18 次，`{used:15317, size:258400}` = 上下文水位，**流式推送**，全被 `_ => {}` 丢掉 | 「这条对话快满了」是长对话唯一的预警。与 O-1 那个 `usage` 是两回事，两个都有 |
| **O-2** | **大块上下文拼进正文** | 整张草稿图 JSON 拼进提示词文本 | 改用嵌入式 resource（`embeddedContext` 实测为 true），模型对结构化附件的处理好过正文里的一大坨 JSON |
| **O-3** | **不用 `session/set_mode`** | `new_session_with_mcp` 拿到了 `modes` 就扔了，跑在 agent 默认档上 | 权限姿态可以按任务标准化设置（claude 的 permission mode / codex 的 sandbox 档），不必碰 runtime 配置文件。**这是 H-6 的正解之一** |
| **O-4** | **`thought` / `plan` / 工具详情全丢** | `tool_call` 只 `tool_calls += 1`，界面显示「工具活动 · N 次」；思考过程与执行计划直接丢弃 | 「它到底做了什么」现在只有一个数字。`tool_call` 带着 `title` / `kind` / `locations` / `rawInput`，够画一条真正的活动流 |
| **O-5** | **一条会话一个进程** | 池里每个槽位一个 adapter 进程 | 协议有 `session/close`，一个子进程可以复用多条会话。当前设计（`acp.rs:716` 的注释）是在没有 `closeSession` 的年代定的，可以重新权衡 |
| **O-6** | **`fs` capability 声明为 `false`** | `acp.rs:222`：`{"fs": {"readTextFile": false, "writeTextFile": false}}` | 声明为 true 后 claude 的文件操作会走我们的进程，PathGuard 才有硬落点。**注意边界**：对 codex 无效，它用自带 shell（[02 §3](02-runtime-findings.md)） |
| **O-7** | **未声明 `terminal` capability** ⚠️ 实测 | 没声明不等于它不跑命令：codex 照跑，把输出塞进 `tool_call_update._meta.terminal_output_delta` 这条**私有通道** | 声明之后拿到的是标准化的 `terminal/*`，命令与输出在我们进程里过一遍，才谈得上审计与落事件流 |
| **O-8** | **stderr 只进 `eprintln!`** | `acp.rs:191` 起了线程排空（这一半对），但只打到进程 stderr | agent 崩溃 / 认证失败 / 版本错配的信息**只在 stderr 里**。打包版用户看不到任何东西，报错时也不附最后几行 |
| **O-9** | **`current_mode_update` 不听** | agent 自己切档时我们不知道 | 界面上显示的权限档会与实际不符——而界面上写着档位名 |
| **O-10** | **`session/list` 的隐私处置没有决定** ⚠️ 实测 | 它返回**本机全部会话（跨项目）**，`title` 是完整 prompt 正文。要用它做历史列表就必须按 cwd 过滤 | 现在没用它，所以不是错误；但**用之前必须先定这条规矩**，否则一接就泄漏（[06 规则 22](06-repo-rules.md)） |
| **O-11** | **没有 runtime 抽象层** ⚠️ 实测 | `acp.rs` 直接对着协议写，runtime 差异散在调用点。而两端**语义不一致**：档位名零交集、模型清单在两个不同字段、`effort` vs `reasoning_effort`、`cost` 只有 claude 有 | 这是 H-6 与 H-8 的**共同成因**。接口设计已经写好在 [08-runtime-abstraction](08-runtime-abstraction.md)，照着落地即可 |
| **O-12** | **`session/load` 的 claude 侧未实跑** | codex 侧已验证可恢复；claude 侧只有 2026-07-27 的旧数据 | 做 H-4 之前补一跑：`transcript-probe.mjs session-load --agent claude` |

---

## 怎么用这份清单

1. **改 ACP 相关代码之前先扫一眼**——多数新问题是这些老问题的新形态；
2. **修一条删一条**，别标「已修」；
3. 新发现的违反**写进这里**，同时确认它对应 [06-repo-rules.md](06-repo-rules.md)
   的哪条规则。**对不上任何一条规则，说明规则缺了一条**——那时先补规则。
