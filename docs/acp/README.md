# ACP 调用经验（Claude Code / Codex）

把 Claude Code 与 Codex 当作**可编程的子进程 agent** 来调用的完整实战经验。
来源是 PolyCrew 项目（已废弃）里唯一被真实验证过、值得留下的部分：M0 的 12 项
能力探针 + 后续在真实工作流引擎与多轮对话构建器里的踩坑记录。

ACP = Agent Client Protocol，JSON-RPC 2.0 over stdio。你的程序扮演 **client**，
`claude-agent-acp` / `codex-acp` 扮演 **agent**（各自包着 Claude Code / Codex 的
完整 agentic loop：读写文件、跑命令、检索）。你不需要自己实现 agentic loop，
只负责：拉起进程 → 握手 → 开会话 → 发 prompt → 消费事件流 → 裁决权限。

## 文档

| 文件 | 内容 |
|---|---|
| [01-protocol-lifecycle.md](01-protocol-lifecycle.md) | 协议全貌、会话生命周期、方法映射、事件类型 |
| [02-runtime-findings.md](02-runtime-findings.md) | **实测结论**：claude 与 codex 的行为差异（权限/文件/恢复/认证/usage） |
| [03-pitfalls.md](03-pitfalls.md) | **踩坑清单**：每条都是真实踩过并修复的 |
| [04-recipes.md](04-recipes.md) | 实战配方：多轮对话、结构化输出、真流式、会话池、超时 |
| [reference/](reference/) | 可直接复制进新项目的参考实现（含修好的真流式版本） |

## 版本状态（重要，先读这段）

**三个包在 2026 年全部改名**，旧包已 deprecated：

| 用途 | 旧包（实测用的） | 新包（现在该用的） |
|---|---|---|
| 协议 SDK | `@zed-industries/agent-client-protocol` 0.4.5 | `@agentclientprotocol/sdk` 1.3.0 |
| Claude runtime | `@zed-industries/claude-code-acp` 0.16.2 | `@agentclientprotocol/claude-agent-acp` 0.62.0 |
| Codex runtime | `@zed-industries/codex-acp` 0.16.0 | `@agentclientprotocol/codex-acp` 1.1.7 |

版本号为 2026-07-27 查询 npm registry 所得。

**验证状态（诚实边界）**：

| 内容 | 验证情况 |
|---|---|
| 6 组能力探针的完整结论 | 2026-07-24 在**旧版本**（SDK 0.4.5 / claude-code-acp 0.16.2 / codex-acp 0.16.0）实跑，claude 与 codex 双侧 |
| [reference/](reference/) 参考实现 | 2026-07-27 在**新版本**（SDK 1.3.0 + claude-agent-acp 0.62.0）编译通过（TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）并端到端跑通真实对话 |
| handshake / auth / usage 三项 | 已在**新版本**复跑，数据见 [02-runtime-findings §8](02-runtime-findings.md) |
| session-load / permission / fs 三项 | **仅旧版本**数据，新版未复跑 |
| codex 侧 | **仅旧版本**数据。新版本完全未验，接入前请跑 `probe.ts all --agent codex` |

已知已翻转的结论：**usage/token 数据**旧版零命中、新版有完整计量与美元成本。
这说明"某能力不支持"的结论会过期——把 [reference/probe.ts](reference/probe.ts)
留在项目里，升级后复跑一遍再下判断。

另外，SDK 1.x 把 `ClientSideConnection` 及其构造函数标记为 `@deprecated`，
推荐新的 `client({name}).connectWith(stream, ctx => ...)` 流式 API。参考实现
仍用 `ClientSideConnection`（1.3.0 中依然导出可用），因为它是被实跑验证过的路径；
迁移建议见 [01-protocol-lifecycle.md](01-protocol-lifecycle.md) 末节。

## 30 秒上手

```bash
npm i @agentclientprotocol/sdk @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
```

```ts
import { AcpAdapter, ACP_RUNTIME_REGISTRY, allowPolicy } from "./reference/index.js";

const adapter = new AcpAdapter(ACP_RUNTIME_REGISTRY["claude-code"], allowPolicy);
const { sessionId } = await adapter.createSession({ cwd: "/abs/path/to/workdir" });

for await (const ev of adapter.runTurn(sessionId, { prompt: "总结这个目录的代码结构" })) {
  if (ev.kind === "message-chunk") process.stdout.write(ev.text);
  if (ev.kind === "tool-call") console.log(`\n[工具] ${ev.title} ${ev.status}`);
}
await adapter.close(sessionId);
```

前置条件：本机已登录 Claude Code（`claude /login`）或 Codex（`codex login`
或设 `CODEX_API_KEY`）。ACP 直接复用本机登录态，无需额外配置 key。

## 一句话总结每个大坑

1. 从 agent 终端里启动你的程序时，**必须清除 `CLAUDECODE` 等嵌套标记**，否则
   runtime 拒绝服务（[03-pitfalls #1](03-pitfalls.md)）。
2. 真实任务里权限策略给 `rejectPolicy` 会让 Claude 工具被拒后**不产出结构化输出**，
   实际要用 `allowPolicy` + 沙箱兜底（[03-pitfalls #2](03-pitfalls.md)）。
3. token/usage 数据**旧版没有、新版有了**（`PromptResponse.usage` +
   通知流里的 `cost`）——旧结论已实测翻转，别照抄过时的"ACP 无法做预算"
   （[02-runtime-findings #5](02-runtime-findings.md)）。
4. codex **不走** client fs 代理（用自带 shell 写文件），文件隔离只能靠它的
   sandbox 档位（[02-runtime-findings #3](02-runtime-findings.md)）。
5. 临时 cwd 的目录名会进 `~/.claude/projects` 成为历史，**下一次新会话会串味**
   （[03-pitfalls #5](03-pitfalls.md)）。
6. 天真的 `runTurn` 实现是"等 prompt 返回后再补发全部事件"，**不是流式**；
   要真流式必须用 onUpdate 回调 + 异步队列（[03-pitfalls #7](03-pitfalls.md)）。
