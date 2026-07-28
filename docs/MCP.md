# 把 AI Workflows 接给你的 Agent

MCP Server 把这个应用的能力暴露给 Claude Desktop / Claude Code 之类的
MCP 客户端。它**只是 Core API 面向 Agent 的适配层** —— 工具清单由契约派生，
调用一律经 CoreApiClient，没有直连数据库或文件的路径。

绕过 Core API 就等于绕过版本守卫与审计：AI 一旦写坏，既解释不清也回滚不了。

## 先决条件

引擎的 HTTP 桥接要在跑：

```bash
pnpm dev:api          # 或 scripts/local-test-env.sh start
```

默认监听 `127.0.0.1:5177`，只绑回环地址。

## 配置

在 MCP 客户端的配置里加一项（Claude Code 是 `~/.claude/mcp.json`）：

```json
{
  "mcpServers": {
    "ai-workflows": {
      "command": "npx",
      "args": ["tsx", "<仓库路径>/services/mcp-server/src/bin.ts"],
      "env": { "AIWF_API": "http://127.0.0.1:5177" }
    }
  }
}
```

## 暴露了什么

首版 16 个工具，全部从 `MCP_FIRST_RELEASE_TOOLS` 派生
（默认只给其中 11 个只读的，见下）：

| 类别         | 工具                                                               |
| ------------ | ------------------------------------------------------------------ |
| 工作流       | `workflow.list` / `get` / `create` / `patch` / `validate` / `diff` |
| 运行（只读） | `run.list` / `get` / `events` / `artifacts`                        |
| 记忆         | `memory.list` / `create` / `update` / `delete`                     |
| 参考         | `prompt.list` / `model.list` / `agent.list`                        |

**不开放**发布与运行（`workflow.publish`、`run.start`、`run.cancel`…）。
那些能直接产生副作用 —— 起一个真实进程、动真实的仓库。首版让 AI 提议，
人来按那个按钮。

清单之外的工具调用一律被拒，没有旁路。

## 写操作：开放，但每次都要人点头

写工具（`workflow.create` / `patch`、`memory.create` / `update` / `delete` 等）
现在**在清单里**，但每一次调用都会先在应用里弹一张确认卡：
工具名、入参原文、批准/拒绝两个按钮。用户不点，那次写入就不发生。

「AI 的改动一律先出 Diff，用户确认才落草稿」是这个产品的核心规则。
主管 AI 一直遵守（提议 → Diff → 确认），MCP 之前不能 ——
那个进程弹不出应用里的对话框，于是写工具只能整体关掉。
现在走一条跨进程的信箱：

```
MCP 进程                    应用
   │ mcp.requestConfirm ──────▶ 待确认队列
   │                            │ 轮询到 → 弹确认卡
   │ mcp.confirmStatus ◀────────┤ 用户点批准/拒绝
   │ （每 800ms 查一次）         │ mcp.decideConfirm
   ▼
 放行 / 不放行
```

三条安全默认：

| 情况                   | 结果         | 为什么                                                    |
| ---------------------- | ------------ | --------------------------------------------------------- |
| 连不上应用、查不到状态 | **不放行**   | 这次写入的去向已经不明确了，默默写进去比拒绝糟得多        |
| 180 秒没人理           | **自动拒绝** | 用户多半不在电脑前，而一条写操作几小时后突然生效更糟      |
| 已经决定过             | 不能再改     | 否则同一条写操作可能被批准两次，而 MCP 那边可能已经动手了 |

`mcp.pendingConfirms` 与 `mcp.decideConfirm` 的 Scope 是 `null` ——
**不给远端**。给了就等于让 MCP 自己看见队列、自己批准自己。

自动化（e2e 之类）可以跳过确认：

```json
"env": { "AIWF_API": "http://127.0.0.1:5177", "AIWF_MCP_SKIP_CONFIRM": "1" }
```

它不是「方便一点」的开关 —— 开了之后 AI 就能不经过任何人写你的草稿。

只读工具**不问**：每次 `list` 都弹一次确认，用户会直接把确认关掉。

## 排查

- **客户端一言不发地断开**：多半是有人往 stdout 写了非协议内容。
  日志一律走 stderr，这条没有例外。
- **「返回值不合契约」**：桥接返回的形状与契约对不上。
  转换在 `packages/client-core/src/ipc-mapping.ts`，三个消费者共用同一份 ——
  桌面壳、Web、MCP。各写一份的话，第二个接上的才会发现问题。
- **连不上**：确认 `AIWF_API` 指向的桥接在跑（`curl 127.0.0.1:5177/ipc/workflow_list -d '{}'`）。
