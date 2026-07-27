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

首版 16 个工具，全部从 `MCP_FIRST_RELEASE_TOOLS` 派生：

| 类别 | 工具 |
| --- | --- |
| 工作流 | `workflow.list` / `get` / `create` / `patch` / `validate` / `diff` |
| 运行（只读） | `run.list` / `get` / `events` / `artifacts` |
| 记忆 | `memory.list` / `create` / `update` / `delete` |
| 参考 | `prompt.list` / `model.list` / `agent.list` |

**不开放**发布与运行（`workflow.publish`、`run.start`、`run.cancel`…）。
那些能直接产生副作用 —— 起一个真实进程、动真实的仓库。首版让 AI 提议，
人来按那个按钮。

清单之外的工具调用一律被拒，没有旁路。

## 写操作的确认

`McpToolRegistry` 支持 `confirmWrite` 回调：写类工具在真正调用前先问一次。
桌面壳接上它之后，AI 的每次写入都会先在应用里显示 Diff。

只读工具**不问** —— 每次 `list` 都弹一次确认，用户会直接把确认关掉。

## 排查

- **客户端一言不发地断开**：多半是有人往 stdout 写了非协议内容。
  日志一律走 stderr，这条没有例外。
- **「返回值不合契约」**：桥接返回的形状与契约对不上。
  转换在 `packages/client-core/src/ipc-mapping.ts`，三个消费者共用同一份 ——
  桌面壳、Web、MCP。各写一份的话，第二个接上的才会发现问题。
- **连不上**：确认 `AIWF_API` 指向的桥接在跑（`curl 127.0.0.1:5177/ipc/workflow_list -d '{}'`）。
