# ADR-0009：引擎自己应用结构化 Patch

- 状态：已采纳
- 日期：2026-07-29
- 取代：[ADR-0008](0008-patch-carries-resulting-graph.md) 的决策部分

## 背景

ADR-0008 决定「客户端应用 Patch，把结果图随 `graphJson` 一并提交」，
理由是 `applyPatch` 只有 TypeScript 一份实现，写第二份必然漂移。
那条 ADR 也写明了退出条件：

> 一旦引擎侧要独立应用 Patch（例如 M4 让 MCP 直连引擎而不经过客户端），
> 就该在 Rust 侧实现 applyPatch，并把 `graphJson` 降级为可选校验用途。

系统级 MCP 就是那个场景。Claude Code / Codex 通过 HTTP 连进来时，
**中间没有任何客户端**，没人替 Agent 算那张图。当时的实际形态是：

- `workflow.patch` 映射到 `workflow_save_draft`（整份回写），
  返回值只有一个 rev
- 于是 `ipc-mapping.ts` 在映射层**编了一个空 Diff 和一句 `ok: true`**
- 任何不经过 `DraftStore` 的调用方都会收到「校验通过、什么都没改」，
  而图可能已经坏了

也就是说，ADR-0008 的方案不只是「MCP 用不了」，它已经让契约上
承诺的两个返回字段变成了假的。

## 决策

在 Rust 侧实现三件事，与 TypeScript 那份**逐字等价**：

| 模块                          | 对应的 TypeScript          |
| ----------------------------- | -------------------------- |
| `crates/engine/src/patch.rs`  | `contracts/src/patch.ts`   |
| `crates/engine/src/validate.rs` | `contracts/src/graph.ts` |
| `crates/engine/src/diff.rs`   | `contracts/src/diff.ts`    |

`workflow.patch` 由引擎应用操作、算 Diff、跑校验、做 baseRevision 守卫。
`graphJson` 保留但降级为**交叉校验**：两边算出的图不一致时留一行日志，
落库以引擎算的为准 —— 它是唯一能保证「操作列表与落库的图对得上」的一方。

## 漂移怎么防

三份实现要跨语言对齐，靠的不是自觉：

1. **端口与配置 Schema 进生成物**。`node-catalog.json`（端口、能力、seed、
   动态端口规则）与 `node-configs.schema.json` 由 `pnpm contracts:gen` 产出，
   `contracts:check` 守着不漂移。Rust 用 `include_str!` 编译期读进来。
2. **动态端口从闭包改成声明**。`resolveOutputs: (config) => Port[]`
   过不了语言边界，改成 `dynamicOutputs: DynamicOutputRule`，两边解释同一份规则。
3. **一致性夹具**。`contracts/src/conformance.ts` 定义输入，生成器用
   TypeScript 那份算出期望输出写进 `generated/conformance.json`，
   `crates/engine/tests/conformance_test.rs` 逐条比对 ——
   **连错误文案都比**。43 组用例覆盖 13 个 ValidationCode、12 种 Patch 操作、
   8 组图对比，外加内置模板从空图完整搭起来那一条。

第 3 条是关键：改任何一侧的行为都会让它红一次，而不是等到用户
对着「界面说行、MCP 说不行」不知道信谁。

## 顺带修掉的一件事

`validateGraph` 的 `INVALID_CONFIG` 原先直接漏 Zod 的英文
（`Invalid input: expected string, received undefined`），
而同一个问题在配置弹层里显示的是中文 —— 因为那边走 `describeIssue`。
现在两处都走 `describeIssue`，Rust 侧从 JSON Schema 产出同一句话。

这既是体验修复，也是可移植性的前提：把「用户看到什么」交给一个
第三方库的版本号，Rust 侧就永远追不上。

## 代价

- 多了约 900 行 Rust。换来的是 MCP 能真的改工作流，以及两个返回字段不再是假的。
- 夹具没覆盖到的形态仍可能分叉。缓解：`workflow.patch` 的交叉校验会
  在日志里说出来，那正是「夹具漏了一种形态」的信号。
- `serde_json` 开了 `preserve_order`：Zod 按 shape 声明顺序报问题，
  默认的 BTreeMap 会按字母重排，两边的 issue 次序就对不上。
