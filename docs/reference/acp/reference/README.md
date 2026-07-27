# 参考实现

可直接拷进新项目的 ACP 客户端实现。**在 SDK 1.3.0 + claude-agent-acp 0.62.0 上
编译通过并端到端跑通真实对话**（2026-07-27）。

## 跑起来

```bash
cp -r reference/ your-project/src/acp/
cd your-project/src/acp
npm i
npm i @agentclientprotocol/claude-agent-acp    # 或 @agentclientprotocol/codex-acp

npm run typecheck
npm run example -- claude "用一句话介绍你自己，不要使用任何工具。"
npm run probe -- handshake --agent claude
```

前置：本机已登录 Claude Code（`claude /login`）或 Codex（`codex login`
或设 `CODEX_API_KEY`）。

## 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | 归一化事件类型 `AgentEvent`、`TokenUsage`、`Cost`、adapter 接口 |
| `registry.ts` | runtime 注册表（命令、args、**必须清除的环境变量**）+ 命令解析 |
| `handle.ts` | 单个 agent 子进程的受控句柄：spawn / 握手 / 会话 / prompt / 权限 / fs / stderr |
| `normalize.ts` | `session/update` → `AgentEvent`；`extractJson` / `extractBlock` |
| `adapter.ts` | 高层封装：会话管理 + **真流式 runTurn** + 超时取消 + usage/cost |
| `example.ts` | 最小可跑示例 |
| `probe.ts` | 6 组能力探针，换版本/换环境后先跑这个 |

依赖方向：`types` ← `registry` / `normalize` ← `handle` ← `adapter`。
没有循环依赖，可以只拿其中几个文件。

## 与 PolyCrew 原版的差异

这份实现修掉了原版的问题，不是原样搬运：

1. **真流式 `runTurn`**。原版先 `await prompt`（要等整个 turn 结束）再补发全部
   事件，`AsyncIterable` 的外壳骗了自己，UI 会白屏几十秒。这里用 `onUpdate`
   回调 + `AsyncQueue`，事件产生即消费。
2. **超时会真正取消**。原版只有探针里有超时；这里 adapter 内置 turn 超时，
   且超时后会调 `session/cancel`，不让 agent 在后台继续跑继续烧钱。
3. **暴露 usage / cost**。新版 runtime 提供了 token 计量与美元成本，
   挂在 `done` 事件上（旧版为 `undefined`，代码容忍缺失）。
4. **新包名**（`@agentclientprotocol/*`），旧的 `@zed-industries/*` 已 deprecated。
5. **`setCallbacks` 支持 per-turn 回调切换**，原版回调只能构造时固定。
6. **握手失败时带出 stderr**。认证失败/嵌套变量/版本错配的真正原因只在 stderr 里。
7. **`createSession` 自动 `mkdirSync(cwd)`**，避免 cwd 不存在导致的迷惑报错。

## 用之前必读

- [03-pitfalls.md](../03-pitfalls.md) —— 12 个真实踩过的坑
- [02-runtime-findings.md](../02-runtime-findings.md) —— claude 与 codex 的行为差异

最容易忘的两条：**真实任务要用 `allowPolicy`**（用 `rejectPolicy` 会让 agent
拿不到素材、不产出结果），**session 用完必须 `close`**（否则子进程泄漏）。
