# ADR-0003：Core API 在下、MCP 在上

- 状态：已采纳
- 日期：2026-07-27

## 背景

主管 AI 需要深度读写这个软件：改工作流、写记忆、查运行记录。
问题是「AI 通过什么途径写」。

## 决策

**唯一执行写操作的是内部 Workflow Core API。** 它负责：

- `baseRevision` 版本守卫
- 结构化 Patch（`addNode` / `connect` / `setConfig`，而不是回写整份 JSON）
- Scope 校验
- Diff 生成与审计事件

UI、MCP Server、本地 HTTP 都只是它的调用方。

## 出口分层

| 出口              | 给谁                                          | 状态                                               |
| ----------------- | --------------------------------------------- | -------------------------------------------------- |
| MCP Server        | Claude Code / Codex / Claude Desktop 等 Agent | 首版：只读 + create + patch + validate + 记忆 CRUD |
| 本地 HTTP / tRPC  | 脚本、CI、快捷指令、Web 形态                  | M6                                                 |
| 直连数据库 / 文件 | ——                                            | **不开放**                                         |

## 理由

直连数据库会绕过版本守卫与审计。AI 一旦写坏，既解释不了也回滚不了——
而「可解释」是这个产品的立身之本。

结构化 Patch 而不是整份回写，是同一个道理：整份回写无法生成有意义的 Diff，
用户没法在确认前看懂 AI 到底改了什么。

## 落地

`packages/contracts/src/api.ts` 是方法表与 Scope 映射的真源；
`services/mcp-server` 的工具清单由它派生，没有手写的第二份。
CI 门禁：MCP 工具不得绕过 Core（`services/mcp-server/tests/tools.test.ts`）。
