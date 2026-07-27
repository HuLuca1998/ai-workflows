# AI Workflows

本地优先的 AI Workflow 客户端：把 AI 能力、脚本、人工审批、Git 隔离、通知与外部服务连成可复用的工作流，并让一个了解全软件能力的「主管 AI」协助设计、解释、优化与排障。

形态：**macOS App（Tauri 2）+ Web（同一引擎的远程界面）**。

## 产品原则

| 原则             | 含义                                                               |
| ---------------- | ------------------------------------------------------------------ |
| 可解释优先       | 任何时刻都能回答「现在跑到哪、为什么停、接下来做什么」             |
| 显式权限         | 文件、命令、网络、Secret 由策略控制，**引擎强制，Prompt 无法越权** |
| 草稿与执行分离   | 编辑草稿不影响运行中的版本；运行记录永远引用不可变版本快照         |
| 结构化数据优先   | 节点之间按字段传递，文本拼接只是兼容方式                           |
| AI 建议 ≠ 执行   | AI 的修改一律先出 Diff，用户确认后才写入                           |
| 本地优先与可恢复 | 工作流、记录、记忆、凭据留在本机；审批等待、重启、断网不丢 Run     |

## 仓库结构

```
apps/
  desktop/            Tauri 2 壳（Rust）+ 打包、签名、自动更新
  web/                Web 形态入口（同一套 UI 包）
packages/
  contracts/          冻结的契约：Core API / RunEvent / 节点定义 Schema  ← 单一真源
  ui/                 React 组件与 Nocturne 设计令牌
  client-core/        事件订阅、草稿 store、Schema 表单渲染、传输适配
crates/
  engine/             调度、检查点、env 快照、PathGuard、Redactor
  store/              SQLite(WAL)+FTS5 访问层与迁移
services/
  acp-sidecar/        Node：ACP Adapter（Claude Code / Codex）
  mcp-server/         Node：对外 MCP 工具，只调用 Core API
docs/                 项目管理文档、ADR、设计图纸与参考资料
```

分层依赖是单向的：`UI → Client Core → Core API → Engine → Store`。UI 只做 RunEvent 的只读投影与发命令，不直接碰文件与进程。

## 快速开始

```bash
pnpm install          # Node 侧依赖（需要 pnpm 11+、Node 22+）
pnpm env:check        # 环境检查：缺什么、怎么装
pnpm verify           # 提交前跑一遍完整门禁
```

装应用、跑开发环境、自动更新怎么用 → [docs/INSTALL.md](docs/INSTALL.md)

常用命令：

| 命令                        | 作用                         |
| --------------------------- | ---------------------------- |
| `pnpm dev`                  | 启动 Web 形态开发服务器      |
| `pnpm contracts:gen`        | 由契约源重新生成 JSON Schema |
| `pnpm contracts:check`      | 校验生成物未漂移（CI 门禁）  |
| `pnpm lint` / `pnpm format` | oxlint / Prettier            |
| `pnpm rs:lint`              | clippy（warnings 视为错误）  |

## 开发方式

**功能以测试先行为基准。** 契约与安全基元尤其如此：先写下期望行为的测试，再写实现。详见 [docs/TESTING.md](docs/TESTING.md)。

**以图纸施工。** 设计图纸在 [docs/design/client/](docs/design/client/)（可交互原型 + 功能文档与里程碑 + 技术选型 + Nocturne 设计系统）。实现与图纸不一致时，先改文档或记 ADR，不要静默偏离。

## 文档

| 文档                                         | 内容                           |
| -------------------------------------------- | ------------------------------ |
| [docs/README.md](docs/README.md)             | 文档索引                       |
| [docs/PROJECT.md](docs/PROJECT.md)           | 产品定位、范围与非目标         |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层架构与目录职责             |
| [docs/ROADMAP.md](docs/ROADMAP.md)           | M0–M6 里程碑与出口标准         |
| [docs/TESTING.md](docs/TESTING.md)           | 测试先行规约与质量门禁         |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 分支、提交、评审与契约变更流程 |
| [docs/RELEASE.md](docs/RELEASE.md)           | 自动发布与应用内一键更新       |
| [docs/adr/](docs/adr/)                       | 架构决策记录                   |

## 许可

MIT
