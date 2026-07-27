# ADR-0004：契约以 TypeScript + Zod 为单一真源

- 状态：已采纳
- 日期：2026-07-27

## 背景

契约要同时服务四方：React 界面、Rust 引擎、Node sidecar、MCP Server。
真源放哪一侧？

## 决策

**TypeScript + Zod 是真源**，位于 `packages/contracts`。
其他语言从它生成或镜像：

- JSON Schema：`pnpm contracts:gen` 导出到 `generated/`，供 Rust 校验与 MCP 工具声明使用
- Rust 镜像：状态机、事件类型在 `crates/engine/src/status.rs` 手写一份，
  由 `contract_sync_test.rs` 对着生成物校验不漂移

## 理由

- 契约的主要消费者是界面与 AI 工具层，两者都在 TS 侧
- Zod 一份定义同时得到运行时校验、静态类型、JSON Schema 三样东西
- 节点配置 Schema 需要驱动表单渲染，这天然是 TS 侧的需求

## 为什么不用 Rust 作真源

Rust 侧生成 TS 类型可行（如 `ts-rs`），但拿不到运行时校验与表单渲染需要的
JSON Schema，还要额外一层生成。而且节点定义的默认值、动态端口这类逻辑
在 Zod 里表达更直接。

## 防漂移

三道门禁：

1. `pnpm contracts:check` —— 生成物与源一致，手改 `generated/` 会被打回
2. `cargo test -p aiwf-engine contract_sync` —— Rust 镜像的状态名、事件分类、节点数量与契约一致
3. `packages/contracts/tests/` —— 契约自身的行为测试（94 项）

## 代价

Rust 侧的镜像需要人工同步。接受这个代价，因为镜像的量很小（状态机 + 常量），
而门禁会立刻发现脱节。
