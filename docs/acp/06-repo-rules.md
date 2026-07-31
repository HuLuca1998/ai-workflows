# 本仓库的 ACP 使用规范

[01](01-protocol-lifecycle.md)–[05](05-protocol-reference.md) 说的是**协议是什么**，
这一页说的是**在这个仓库里必须怎么用**。

前面几页换个项目还成立，这一页不行——它绑死在本仓库的两条 ACP 路径上：

| 路径 | 入口 | 形态 |
|---|---|---|
| **主管 AI** | `core-api/src/lib.rs:2002` `supervisor_ask` | 多轮对话，一条会话跨多轮 |
| **AI 节点** | `crates/engine/src/executor.rs:652` `run_ai` | 单轮执行，一个节点一条会话 |

两条路径**共用** `crates/engine/src/acp.rs` 那一个手写 JSON-RPC 客户端。
所以「改 acp.rs」永远是双向影响，动它之前先想清楚另一条路径。

违反现状见 [07-violations.md](07-violations.md)。

---

## 一、会话与上下文

### 规则 1 · 一条用户对话 = 一条 ACP 会话，会话 id 必须端到端穿透

多轮对话的每一轮**必须落在同一条 ACP 会话上**。ACP 会话自带上下文，
这是 agent 记得上一句的唯一机制。

穿透链有五跳，**任何一跳丢掉 sessionId，整条规则就失效，而且不报错**：

```
SupervisorDrawer 的 useState
  → coreClient.call('supervisor.ask', { sessionId })
    → toIpcInput（ipc-mapping.ts）        ← 白名单式转换，最容易在这里丢
      → Tauri IPC / devserver dispatch
        → api::supervisor_ask 的 session_id 参数
          → SessionPool 的池键
```

失效时的症状**不是报错，是变慢加失忆**：每问一句起一个新 adapter 进程、
重走一遍握手，agent 手上永远是白纸。用户看到的是「它不记得我刚说了什么」，
而日志里一切正常。

> **守卫**：缺。需要一条端到端用例，断言同一条对话的第二问落在同一个
> `SessionPool` 键上（`pid_for_test` 是现成的判据——session id 靠不住，
> 两个新起的 adapter 完全可能给出一样的 id）。

### 规则 2 · 系统提示词只在首轮发，之后只发用户原话

```
第一轮：系统提示词 + 上下文 + 用户这句话
第二轮起：只有用户这句话
```

这是 [04-recipes 配方 1](04-recipes.md) 写死的做法。重发不只是浪费 token——
**同一份系统说明在上下文里出现 N 次会让模型行为漂移**，而且那 N 份说明里
夹着 N 份可能已经过期的上下文快照（草稿 rev 变了、运行状态变了）。

大块上下文（草稿图、运行事件）**用嵌入式 resource 发**，别拼进正文文本：

```jsonc
"prompt": [
  { "type": "text", "text": "用户这句话" },
  { "type": "resource", "resource": { "uri": "aiwf://draft/wf_x@rev12",
                                      "mimeType": "application/json", "text": "…" } }
]
```

需要 `promptCapabilities.embeddedContext`（claude 实测为 true）。
拿不到这个能力时才降级为拼正文。

> **守卫**：缺。可以断言「第二轮发出去的 prompt 里不含系统提示词的特征串」。

### 规则 3 · 恢复历史走协议，不要自己拼

要让用户翻回一条旧会话继续问，**用 `session/load`（要重放）或
`session/resume`（不重放）**，别把库里的消息拼成一段「以下是我们之前的对话」
塞进 prompt。

两个 runtime 的 `loadSession` 实测都是 true，且新 turn 能正确复述之前的内容
（[02-runtime-findings §1](02-runtime-findings.md)）——**上下文是真的恢复了**，
不是回放了个日志。

恢复需要你自己持久化 `sessionId` **和 `cwd`**（load 时要重新传 cwd）。

capability 缺失或 load 失败时才降级重建，**并且要告诉用户这是新会话**——
[03-pitfalls #6](03-pitfalls.md)：面向用户的状态承诺（记得 / 忘记 / 恢复）
必须在后端真实兑现，用户一测就穿帮。

---

## 二、流式与结果

### 规则 4 · chunk 必须逐条到达用户，中间层不许攒

`session/prompt` 阻塞到整轮结束，**流式的唯一来源是 `session/update` 通知**。
`acp.rs` 的 `prompt()` 已经把它做成了 `on_update` 回调——**这一层是对的，
不要退化它**。

会退化的是上面：

```rust
// ✗ 攒成 String 再一次性返回 —— 流在这里断了
|update| match update {
    SessionUpdate::AgentText { text: chunk } => text.push_str(chunk),
    …
}
```

[03-pitfalls #7](03-pitfalls.md) 警告的是 TypeScript 那个写法，
**在 Rust 里换个姿势就重现了**：ACP → Rust 是流式的，Rust → UI 不是。

判据很简单：**用户在第一个 token 到达时应该看到它**，而不是在整轮结束时。
做不到就得有中间态 + 可取消（CLAUDE.md 的界面判据：响应 >1s 必须有中间态）。

> **守卫**：缺。需要一条断言「第一个 chunk 到达界面的时间 << 整轮耗时」的用例。

### 规则 5 · `stopReason` 必须被读，不是 `end_turn` 就不算成功

五种取值里**只有 `end_turn` 是正常说完**：

| 值 | 必须怎么处理 |
|---|---|
| `end_turn` | 正常 |
| `max_tokens` | 答案是**截断的**，要么续，要么告诉用户 |
| `max_turn_requests` | agent 工具调用次数用尽，任务多半没做完 |
| `refusal` | 模型拒绝了，别把空回答当答案 |
| `cancelled` | 用户取消 |

`executor.rs:659` 做对了（至少拦了 `Refusal`）。**丢弃 `PromptOutcome`
等于把截断的半个答案当完整答案交出去**——而用户没有任何线索。

### 规则 6 · `session/update` 的每一类都要有去处

收到即丢是允许的，但**必须是个决定，不是遗漏**。当前九类的处置见
[05 §4](05-protocol-reference.md)。特别注意两类：

- **`current_mode_update`**：agent 会自己切档。不听这条，界面上显示的权限档
  就与实际不符——**而界面上写着档位名**（`SupervisorDrawer` 底部那行）；
- **`tool_call_update`** 除 `toolCallId` 外全是可选字段，**必须按 id 合并**，
  否则一次工具调用显示成一堆重复条目。

---

## 三、权限与安全

### 规则 7 · 反向权限请求必须走应用自己的权限档，并且落事件流

`session/request_permission` 是**唯一一条跨 runtime 统一的逐工具执法通道**。
本仓库已经有一套权限档（`workspace.settings.permissionPreset`，
`crates/mcp/src/catalog.rs` 的 `gate_for` 是真拦截），**ACP 这条通道必须接到
同一套上**，而不是自己硬编码一个策略。

三条硬要求：

1. **optionId 必须从 agent 给的 `options` 里挑**，自己编等于没回答；
2. **裁决结果落事件流**——谁在什么时候批准了什么，是这个产品的可解释性承诺；
3. **拒绝要让用户看得见**。全拒且不告诉用户，症状是
   [03-pitfalls #2](03-pitfalls.md)：agent 工具被拒 → 没有素材 →
   不产出结构化输出 → 用户看到一句语焉不详的话，**完全不知道是被自己的
   权限设置挡了**。

### 规则 8 · 先设档，再谈裁决 —— `session/set_mode` 才是执法开关

这条原本写的是「权限回调是策略层，不是安全边界」。实测之后必须说得更硬：

**默认档下，你的裁决代码一次都不会被调用。**
同一件事（建一个文件）跑三遍
（[transcripts §2](transcripts/README.md#2-权限默认档下我们的裁决代码根本不会被调用-)）：

| 档位 | `request_permission` 次数 | 文件建了吗 |
|---|---|---|
| `agent`（**codex 默认**）+ 客户端全拒 | **0** | ✅ 建了 |
| `agent` + 客户端全允许 | **0** | ✅ 建了 |
| `read-only`（`set_mode` 之后）+ 客户端全拒 | **2** | ❌ 没建 |

所以顺序是**先 `session/set_mode` 设档，再谈裁决逻辑**。
只写裁决不设档，等于完全没有防线——而且是**看起来有**的那种，
下一个人会在这个错的安全假设上继续加东西。

read-only 档下拒绝是真生效的，agent 会明确说明：
「无法完成：写入权限请求被拒绝，`hello.txt` 未创建。」

三层防线缺一不可：**runtime 沙箱档（`set_mode`）+ 隔离的 cwd + OS 级兜底**。

推论：任何「所有文件操作都过我的 path guard」的设计**对 codex 不成立**——
它用自带 shell 写文件，实测 `clientFsWriteCalls` 为 0
（[02-runtime-findings §3](02-runtime-findings.md)）。

### 规则 9 · 声明了什么 capability 就要实现什么，反之亦然

`clientCapabilities` 是一份承诺。声明了不实现，agent 调过来吃到 `-32601`，
整轮可能失败；**该声明的不声明，等于自断一条能力**——
`fs` 声明为 false 就意味着 claude 不走 fs 代理，你的 path guard 在 ACP 路径上
没有任何落点。

要改这个声明时，把「为什么」写进注释——它是安全姿态的一部分，
不是一个可以随手翻转的布尔值。

### 规则 10 · cwd 必须是已存在的绝对路径，且是隔离的

- 相对路径或不存在的目录 → `session/new` 失败，错误信息还不清楚
  （[03-pitfalls #8](03-pitfalls.md)）；
- **固定前缀的临时目录会让会话历史串味**：claude 按 cwd 路径在
  `~/.claude/projects/<路径编码>` 下存历史，新会话可能读到同前缀的旧历史
  （[03-pitfalls #5](03-pitfalls.md)）。这在多用户场景里是数据串扰，
  不只是体验问题。

---

## 四、进程与资源

### 规则 11 · 每一个 adapter 进程都要有回收路径，且不依赖 Drop

`SessionPool`（`acp.rs:716`）是唯一的持有方，三条保险都要在：

1. 空闲超时回收（当前 600 秒）；
2. App 退出时 `shutdown()` **按记下来的 pid 主动杀进程组**——不能依赖 Drop，
   正被别的线程持有的那条 `Live` 的 Drop 永远不会跑；
3. adapter 自成进程组（`process_group(0)`），杀的时候整组一起收，
   否则留下孙子进程。

**新增任何一条 ACP 调用路径，都必须经过这个池**。绕过它直接
`AcpClient::connect` 的进程不在 `spawned` 里，`shutdown` 收不走它——
症状是用户 ⌘Q 之后机器上还挂着 node 进程。

> `executor.rs:992` 的 AI 节点目前就是绕过池直连的。那是**有理由的**
> （单轮执行，用完即弃），但它的进程同样要保证退出时被收走。

### 规则 12 · 超时之后必须 `session/cancel` + 杀进程

只 reject 不取消的话，子进程还在那儿跑，还在烧配额。
`AcpClient::cancel` 已经实现（`acp.rs:388`），**但目前零调用点**——
用户点「取消」只是让界面不再等，远端那一轮照跑不误。

超时档位参考（[03-pitfalls #10](03-pitfalls.md)）：握手 / 建会话 60s，
prompt 240s 起步，真实编码任务更长。

### 规则 13 · stderr 必须收集，并且在报错时带到用户面前

**agent 崩溃、认证失败、版本错配的信息只在 stderr 里**，ACP 消息流里什么都没有。

`acp.rs:191` 已经起了线程排空 stderr（不排空的话管道填满，adapter 会阻塞在写上）——
这一半做对了。**另一半是把它带出来**：现在只 `eprintln!("[acp] …")`，
打包版的用户看不到任何东西，报错时也不会附上最后几行 stderr。

### 规则 14 · 所有子进程走 `aiwf_engine::tooling`

adapter 是 node 脚本，GUI 进程由 launchd 拉起时 `PATH=/usr/bin:/bin:...`，
nvm 的 node 根本找不到。`acp.rs:172` 已经走了 tooling——
**新增的任何 spawn 都要照做**，直接 `Command::new` 在 dev 下看不出问题，
打包后必炸。

---

## 五、运行时选择与版本

### 规则 15 · 测试与试验一律优先 codex

**不要用 `acp.claude` 做测试和试验**。这个应用本身跑在 Claude Code 里开发，
用它去测会与开发环境撞在一起：嵌套的 agent 会话、共用的登录态、同一份配额。

契约的 `AGENT_RUNTIMES` 把 `acp.codex` 排在第一位，
`preferred_acp_runtime()` 跟着它。只装了 claude 的机器上仍然要能用——
**那是退路，不是首选**。

### 规则 16 · 起 adapter 前必须清嵌套环境变量

```rust
env_to_remove("acp.claude")  // CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / CLAUDE_CODE_SSE_PORT
env_to_remove("acp.codex")   // CODEX_SANDBOX / CODEX_SANDBOX_NETWORK_DISABLED
```

不清的话，claude 误判自己跑在另一个 agent 内部而**拒绝服务**
（[03-pitfalls #1](03-pitfalls.md)）。这个坑只在「从 agent 终端启动」时复现——
自己开发时多半碰不到，一交给用户就炸。

### 规则 17 · adapter 与它背后的 CLI 成对锁定

`codex-acp` 与 `codex-cli` 是两个独立版本，错配会出现莫名其妙的行为差异
（实测过一次模型元数据警告）。升级一边就要复验另一边。

### 规则 18 · 任何「某能力不支持」的结论都要带日期与版本，升级后复跑 probe

usage / token 数据的结论**三个月内翻转过一次**：旧版零命中、新版有完整计量
与美元成本（[02-runtime-findings §5](02-runtime-findings.md)）。

这就是把 [reference/probe.ts](reference/probe.ts) 留在仓库里的意义。
改 ACP 依赖版本时，**先跑 probe 再下判断**：

```bash
pnpm --filter @aiwf/acp-sidecar exec tsx ../../docs/acp/reference/probe.ts all --agent codex
```

---

## 六、跨层纪律（这一组是成因）

### 规则 19 · 跨层字段转换用穷举，不用白名单

`ipc-mapping.ts` 那层是**白名单式**的：只挑出列出来的字段，其余静默丢弃。
这个形态已经吃掉过三次字段——`ver`、`run.list` 的分页参数、
`supervisor.ask` 的 `sessionId`，而**症状都是「数据莫名为空」而不是报错**。

新增 ACP 相关参数时：

1. 优先**原样透传** + 只转换真正需要变形的字段；
2. 必须白名单时，**同一个 commit 里补一条断言「这个字段发得出去」的测试**；
3. 组件级测试 mock 掉 `coreClient` 的，**不算数**——它测的是组件传了什么，
   不是引擎收到了什么。接缝要在接缝上测。

### 规则 20 · 界面上关于 ACP 的每一句话都要是真的

三种违反形态（CLAUDE.md 纪律二）在 ACP 这条路上都出现过：

- 控件能选但引擎不读（主管 AI 的模型下拉）；
- 界面写着权限档，而 ACP 的裁决与它无关；
- 消息气泡标着 `streaming`，实际没有流。

拿不准就照 `NodeConfigDialog.tsx:269` 的写法：**在界面上直说
「引擎目前不读它，改了也不会生效」**。

### 规则 21 · 每加一道 ACP 门禁，配一条故意违反它、断言它变红的元测试

守卫不能证明自己会红，就不是守卫。ACP 这条路上尤其要小心**假测试**——
`mock adapter` 起不来时测试会「0.29 秒全绿跑完」，
而真实握手至少要几百毫秒。**耗时是证据**，判据见
[docs/TESTING.md](../TESTING.md) 的「测试自己也会假装成功」。

实测的量级参考（[transcripts](transcripts/README.md)，codex 1.1.7）：

| 动作 | 耗时 |
|---|---|
| `initialize` 握手 | ~170ms |
| `session/new` | ~140ms |
| 一轮真实对话（含模型调用） | 10~30s |

**一整套 ACP 用例在 1 秒内跑完，说明它没有真的连上。**

### 规则 22 · agent 回给你的东西可能是别人的，进仓库前必须脱敏

**`session/list` 返回本机全部会话，不受 cwd 约束。** 实测一调下去，
codex 回了 25 条，**全部属于别的项目**，`title` 字段是那些会话的完整
prompt 正文。`available_commands_update` 同理会带上用户本机装的全部 skill
及其描述（实测 43 个）。

这两样都是**用户的东西，不是协议的东西**。三条：

1. **落盘的 ACP 往返记录进仓库前必须过
   [`reference/redact-transcript.mjs`](reference/redact-transcript.mjs)**
   （探针跑完会自动调）。它保留结构、抹掉内容——结构才是文档价值；
2. 真要用 `session/list` 做历史列表，**必须按 cwd 过滤**，
   并且想清楚那些标题会流到哪（日志、事件流、导出的诊断包都算）；
3. 同理适用于**任何**要落进事件流或诊断包的 agent 原始响应。
   Secret 有 `Redactor` 守着，**别人项目的 prompt 正文没有**——
   它不长得像密钥，正则匹配不到。
