# ACP —— 这个应用的 AI 能力全都从这里进来

ACP = Agent Client Protocol，JSON-RPC 2.0 over stdio。我们的程序扮演 **client**，
`claude-agent-acp` / `codex-acp` 扮演 **agent**（各自包着 Claude Code / Codex 的
完整 agentic loop：读写文件、跑命令、检索）。

**我们不实现 agentic loop**，只负责：拉起进程 → 握手 → 开会话 → 发 prompt →
消费事件流 → 裁决权限。

官方规范：<https://agentclientprotocol.com> ·
[GitHub](https://github.com/agentclientprotocol/agent-client-protocol)。
**它是权威源**——这里的文档是「实测经验 + 本仓库怎么用」，
协议本身以官方为准，冲突时改这里。

## 在本仓库的位置

ACP 不是一个可选集成，**它是这个应用全部 AI 能力的唯一入口**。断了它，
主管 AI 与所有 AI 节点同时失效。

| 代码 | 角色 |
|---|---|
| `crates/engine/src/acp.rs` | 手写的 ACP 客户端（**没有用 SDK**，Rust 侧直接发 JSON-RPC）+ 会话池 |
| `crates/core-api/src/lib.rs:2002` `supervisor_ask` | **主管 AI**：多轮对话，一条会话跨多轮 |
| `crates/engine/src/executor.rs:652` `run_ai` | **AI 节点**：单轮执行，一个节点一条会话 |
| `services/acp-sidecar` | Node 侧的 runtime 注册表与探测（TypeScript，用 SDK） |
| `crates/mcp` | 反过来的方向：把本应用作为 MCP server 接给 agent |

两条 ACP 路径共用同一个客户端。**改 `acp.rs` 永远是双向影响。**

---

## 文档地图

| 文件 | 内容 | 什么时候看 |
|---|---|---|
| [01-protocol-lifecycle.md](01-protocol-lifecycle.md) | 协议全貌、会话生命周期、事件类型 | 第一次接触 ACP |
| [02-runtime-findings.md](02-runtime-findings.md) | **实测结论**：claude 与 codex 的行为差异 | 选 runtime、判断某能力能不能依赖 |
| [03-pitfalls.md](03-pitfalls.md) | **踩坑清单**，每条都真实踩过 | 出了怪事、或动手前扫一遍 |
| [04-recipes.md](04-recipes.md) | 实战配方：多轮对话、真流式、会话池、超时、成本 | 要写具体某个功能 |
| [05-protocol-reference.md](05-protocol-reference.md) | **完整方法与类型清单**（对照官方 schema） | 确认某个方法 / 字段 / 枚举值存不存在 |
| [06-repo-rules.md](06-repo-rules.md) | **本仓库的 22 条使用规范** | **改任何 ACP 代码之前** |
| [07-violations.md](07-violations.md) | **当前违反清单**：10 条硬性错误 + 13 条可优化 | 动手前扫一眼，多数新问题是老问题的新形态 |
| [08-runtime-abstraction.md](08-runtime-abstraction.md) | **claude 与 codex 的差异清单 + 抽象层接口设计** | 要写「两端都能跑」的代码 |
| [transcripts/](transcripts/README.md) | **12 份真实往返记录（jsonl）** —— 不是示例，是真跑出来的字节 | 想确认「它到底发了什么」 |
| [reference/](reference/) | 参考实现 + [探针](reference/transcript-probe.mjs) + [脱敏器](reference/redact-transcript.mjs) | 要抄代码、要自己复跑 |

### 我要做 X，看哪篇

| 我要… | 看 |
|---|---|
| 让主管 AI 记得上一句 | [06 规则 1](06-repo-rules.md) → [07 H-1](07-violations.md) |
| 做流式输出 | [03 #7](03-pitfalls.md) + [04 配方 5](04-recipes.md) → [07 H-2](07-violations.md) |
| 少发点提示词 / 省 token | [04 配方 1](04-recipes.md) + [05 §6](05-protocol-reference.md) |
| 恢复一条历史会话 | [05 §2](05-protocol-reference.md)（load vs resume）→ [07 H-4](07-violations.md) |
| 让 AI 能读写文件 / 跑命令 | [05 §3](05-protocol-reference.md)（fs 与 terminal）+ [02 §3](02-runtime-findings.md) |
| 管权限 | [06 规则 7、8](06-repo-rules.md) + [02 §2](02-runtime-findings.md) |
| 算成本 | [02 §5](02-runtime-findings.md) + [04 配方 10](04-recipes.md) |
| 排查「agent 起不来」 | [03 #1、#9、#11](03-pitfalls.md) |
| 升级 adapter 版本 | [06 规则 17、18](06-repo-rules.md)，先跑 `probe.ts` |
| **写两端都能跑的代码** | [08](08-runtime-abstraction.md) —— 协议一致，**语义不一致** |
| 确认「它到底发了什么字节」 | [transcripts/](transcripts/README.md)，或自己跑一遍探针 |

---

## 当前健康状况

**这条链路上有 10 条硬性错误没修**，全部集中在主管 AI 那条路径上，
明细见 [07-violations.md](07-violations.md)，台账索引在
[docs/DEBT.md](../DEBT.md) 的 `B-8`。

最要紧的三条，症状是复合的（用户看到的是「主管 AI 很卡而且不记事」）：

1. **会话 id 在 `ipc-mapping.ts:189` 被丢掉** → 每问一句新建一条 ACP 会话，
   agent 手上永远是白纸，每句都要重起一个 node 进程；
2. **流式断在 `core-api/src/lib.rs:2112`** → chunk 攒成整段才返回，
   而且两端的 `subscribeEvents` 都是空实现，没有推送通道；
3. **系统提示词每轮重发** → [04 配方 1](04-recipes.md) 明确写了不该这么做。

第 1 条不修，第 3 条无从谈起（每轮都是新会话，不发提示词等于什么都没说）。

还有一条性质不同、但更该先看一眼的：

> ⚠️ **权限防线在 codex 上从未生效过。** `acp.rs:423` 一律拒绝权限请求，
> 看起来很严——但 codex 的默认档是 `agent`，**根本不问**，实测建文件
> 请求权限 0 次、文件照建。同样的代码在 claude 上问 1 次、拒绝生效。
> 而我们的首选 runtime 是 codex，cwd 是应用数据目录。
> 修法很短：`session/new` 之后调一次 `session/set_mode`。
> 证据 [transcripts §2](transcripts/README.md#2-权限默认档下我们的裁决代码根本不会被调用-)，
> 详情 [07 H-6](07-violations.md)。

---

## 版本状态（先读这段）

**三个包在 2026 年全部改名**，旧包已 deprecated：

| 用途 | 旧包（已 deprecated） | 现在该用的 | 2026-07-31 实跑的 |
|---|---|---|---|
| 协议 SDK | `@zed-industries/agent-client-protocol` 0.4.5 | `@agentclientprotocol/sdk` 1.3.0 | —（Rust 侧不用 SDK） |
| Claude runtime | `@zed-industries/claude-code-acp` 0.16.2 | `@agentclientprotocol/claude-agent-acp` ^0.62.0 | **0.63.0** |
| Codex runtime | `@zed-industries/codex-acp` 0.16.0 | `@agentclientprotocol/codex-acp` ^1.1.7 | **1.1.7** |

**2026-07-31 复核：SDK 最新仍是 1.3.0，两端 `protocolVersion` 都是 1。**
实跑的 claude 是 0.63.0（`package.json` 锁的是 `^0.62.0`，`^` 放它升上来了）——
`agentInfo.version` 是取真实版本最可靠的地方，别信 `package.json`。

**验证边界（诚实说明）**：

| 内容 | 验证情况 |
|---|---|
| 6 组能力探针的完整结论 | 2026-07-24 在**旧版本**实跑，claude 与 codex 双侧 |
| [reference/](reference/) 参考实现 | 2026-07-27 在**新版本**编译通过并端到端跑通真实对话 |
| **多轮上下文 / 权限 / 恢复 / 取消 / 会话方法** | **2026-07-31 双端实跑**，往返记录在 [transcripts/](transcripts/README.md)（codex 8 个场景 + claude 4 个） |
| [08 的差异表](08-runtime-abstraction.md) | 同上，逐字段对照两端的 `initialize` 与 `session/new` |
| [05-protocol-reference](05-protocol-reference.md) | 2026-07-31 逐条对照官方 schema 页核对 + 双端实跑校正；`elicitation/*` 与 `terminal/*` 的字段细节**未实跑**（本仓库没有落点） |
| fs 代理行为 | **仅旧版本**数据（本仓库把 `fs` capability 声明为 false，没有复验条件） |

**2026-07-31 的双端复验推翻了三条旧结论**：codex 的档位名
（`auto` → `agent`）、codex 默认档下的权限触发（0 次）、
`cost` 字段的归属（**只有 claude 有**）。详见
[02 的修正块](02-runtime-findings.md)。

已经翻转过的结论：**usage / token 数据**旧版零命中、新版有完整计量与美元成本。
三个月翻一次。**任何「某能力不支持」的判断都要带日期与版本**——
这就是把 [reference/probe.ts](reference/probe.ts) 留在仓库里的意义。

---

## 30 秒上手（TypeScript 侧）

```bash
npm i @agentclientprotocol/sdk @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
```

```ts
import { AcpAdapter, ACP_RUNTIME_REGISTRY, allowPolicy } from "./reference/index.js";

const adapter = new AcpAdapter(ACP_RUNTIME_REGISTRY["codex"], allowPolicy);
const { sessionId } = await adapter.createSession({ cwd: "/abs/path/to/workdir" });

for await (const ev of adapter.runTurn(sessionId, { prompt: "总结这个目录的代码结构" })) {
  if (ev.kind === "message-chunk") process.stdout.write(ev.text);
  if (ev.kind === "tool-call") console.log(`\n[工具] ${ev.title} ${ev.status}`);
}
await adapter.close(sessionId);
```

前置条件：本机已登录 Codex（`codex login` 或设 `CODEX_API_KEY`）或
Claude Code（`claude /login`）。ACP 直接复用本机登录态。

**测试与试验一律用 codex**（[06 规则 15](06-repo-rules.md)）：
这个应用本身跑在 Claude Code 里开发，用 claude 的 adapter 去测会与开发环境
撞在一起——嵌套会话、共用登录态、同一份配额。

Rust 侧没有 SDK，`crates/engine/src/acp.rs` 是手写 JSON-RPC。
所以「SDK 支不支持」在这个仓库里多数时候是个假问题，
**该问的是协议支不支持**（[05](05-protocol-reference.md)）。

---

## 一句话总结每个大坑

1. 从 agent 终端里启动时**必须清除 `CLAUDECODE` 等嵌套标记**，否则 runtime
   拒绝服务（[03 #1](03-pitfalls.md)）。
2. 真实任务用 `rejectPolicy` 会让 agent 工具被拒后**不产出结构化输出**，
   要用 `allowPolicy` + 沙箱兜底（[03 #2](03-pitfalls.md)，
   本仓库正踩着：[07 H-6](07-violations.md)）。
3. token / usage **旧版没有、新版有了**，别照抄过时的「ACP 无法做预算」
   （[02 §5](02-runtime-findings.md)）。
4. codex **不走** client fs 代理（自带 shell 写文件），文件隔离只能靠它的
   sandbox 档（[02 §3](02-runtime-findings.md)）。
5. 临时 cwd 的目录名会进 `~/.claude/projects` 成为历史，**下一次新会话串味**
   （[03 #5](03-pitfalls.md)）。
6. 天真的 `runTurn` 是「等 prompt 返回后再补发全部事件」，**不是流式**
   （[03 #7](03-pitfalls.md)，本仓库正踩着：[07 H-2](07-violations.md)）。
7. `session/prompt` 阻塞到整轮结束，**流式的唯一来源是 `session/update` 通知**。
