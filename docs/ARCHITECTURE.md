# 架构

## 分层

```
UI（React）              Studio · Canvas · Inspector · Conversation · Run Detail · Settings
  │ 只读 RunEvent 投影 / 发命令，不直接碰文件与进程
Client Core（TS）        EventStore 订阅 · 乐观草稿 · Schema 校验 · 权限提示
  │ 桌面：Tauri IPC        Web：tRPC over HTTP + SSE
Engine（Rust）           Scheduler · Checkpoint · Env 快照 · PathGuard · Redactor
  ├ Script Runner（zsh / python，非交互，超时与输出上限）
  ├ Git Service（worktree 创建、登记、清理策略）
  └ ACP Sidecar（Node）→ Claude Code / Codex
Storage                  SQLite(WAL) + FTS5 · Artifacts · Keychain 引用
```

**依赖是单向的。** 上层可以依赖下层，反过来不行。UI 不允许直连数据库或起进程；
MCP Server 不允许绕过 Core API。这两条在 CI 里有门禁。

## 目录职责

| 目录                   | 职责                                                                    | 不该出现在这里的东西                         |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `packages/contracts`   | **单一真源**：Core API、RunEvent、节点定义 Schema、状态机、结构化 Patch | 任何 IO、任何框架依赖                        |
| `packages/ui`          | 设计令牌与基础组件（语义与状态）                                        | 业务逻辑、数据获取                           |
| `packages/client-core` | 事件投影、草稿 store、传输适配、更新状态机                              | React 组件、DOM 操作                         |
| `apps/web`             | Web 形态的界面与路由                                                    | 业务规则（应下沉到 client-core / contracts） |
| `apps/desktop`         | Tauri 壳、IPC 命令、打包签名更新                                        | 业务逻辑（应在 engine）                      |
| `crates/engine`        | 调度、检查点、环境快照、PathGuard、Redactor                             | SQL                                          |
| `crates/store`         | SQLite 访问与迁移                                                       | 业务规则                                     |
| `services/acp-sidecar` | ACP runtime 拉起与会话                                                  | 调度决策                                     |
| `crates/mcp`           | 系统级 MCP：Streamable HTTP、工具清单、系统知识资源                     | 直接读写数据库                               |

## 三件冻结物

有三件事必须先冻结，之后 UI 与引擎才能并行开发：

1. **Core API 契约** —— `packages/contracts/src/api.ts`，含方法表、Scope 映射、统一错误码
2. **RunEvent 类型清单** —— `packages/contracts/src/events.ts`，九类事件与流不变量
3. **节点定义 Schema** —— `packages/contracts/src/nodes/`，16 种类型（节点库展示 15 条）

三者由 `pnpm contracts:gen` 导出成 JSON Schema 供 Rust 与 MCP 使用；
CI 校验生成物不漂移，Rust 侧另有 `contract_sync_test.rs` 校验镜像不脱节。

## 关键设计决策

细节见 [adr/](adr/)，这里只列结论：

- **桌面壳用 Tauri 2 而不是 Electron**：包体与常驻内存差一个量级，且路径守卫与子进程隔离能直接用 Rust 写（[ADR-0001](adr/0001-tauri-over-electron.md)）
- **编排引擎用 Rust**：调度、检查点、路径 canonicalize、沙箱在同一进程内完成，不经过 JS（[ADR-0002](adr/0002-rust-engine.md)）
- **Core API 在下、MCP 在上**：唯一写入口负责版本守卫、结构化 Patch、Scope 校验、Diff 与审计（[ADR-0003](adr/0003-core-api-under-mcp.md)）
- **契约用 TypeScript + Zod 作单一真源，Rust 侧是镜像**：类型表达力与生成能力更好，跨语言一致性靠门禁而不是靠自觉（[ADR-0004](adr/0004-contracts-single-source.md)）
- **事件流是唯一事实来源**：三种视图都是同一条流的投影，禁止各自查库（[ADR-0005](adr/0005-event-sourced-runs.md)）

## 数据流：一次运行

```
用户点运行
  → run.start（preflight：依赖、权限、目录、网络白名单）
  → 引擎按拓扑推进：1→N 并行分发、N→1 按汇聚策略阻塞
  → 每一步写 RunEvent（seq 由存储分配，(run_id, seq) 唯一）
  → 审批节点写 approval.requested 并落检查点，然后挂起
  → 用户决定 → approval.decide → 继续
  → 界面全程只订阅事件流，按 seq 归并后投影成三种视图
```

杀掉应用再打开：读最新检查点 → Run 显示 `interrupted` 且可恢复 →
`run.resume` 从检查点续跑。Agent Session 若已失效，明确告知「已用结构化状态重建」，
不伪装连续。
