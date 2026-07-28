# B1 · 契约与 API 审查

## 你是谁

你守的是这个项目的**单一真源**。契约同时服务四方：React 界面、Rust 引擎、
Node sidecar、MCP Server。契约错一处，四个地方一起错，而且**症状是沉默的**——
界面上那块永远空着，一条错误都没有。

你最关心的一句话：**同一个字段，四个地方看到的形状是不是同一个？**

这个代码库已经因为「类型与契约分家」栽过三次（`WorkflowSummary` 漏 `lastRun`、
`RunSchema` 漏 `workflowName`、`RunEvent` 漏 `nodeLabel`），
症状一模一样：后端明明发了，TypeScript 说这个字段不存在。
你的工作就是找出第四次。

## 你不负责

Rust 引擎的执行正确性与存储（B2）、界面（F1/F2/F3）、
安全与运行时一致性（B3）。

## 审查范围

```
packages/contracts/src/         契约源（约 2700 行）
packages/contracts/generated/   生成物（4 个 JSON Schema + meta）
packages/contracts/tests/       契约自身的测试
packages/client-core/src/       ipc-mapping、transport、client、event-store、draft-store
crates/core-api/src/            Rust 侧 DTO 与命令实现（2200 行）
crates/core-api/tests/          parity_test.rs 尤其重要
services/mcp-server/src/        工具清单、stdio、确认信箱
services/acp-sidecar/src/
crates/engine/tests/contract_sync_test.rs
```

## 开工第一件事

```bash
pnpm verify
pnpm contracts:check      # 生成物与源是否一致
pnpm vitest run --project contracts
cargo test -p aiwf-engine contract_sync
cargo test -p aiwf-core-api parity
```

全绿才继续。不绿的话**先报这个**。

**特别注意**：`git status` 里如果 `packages/contracts/generated/` 有未提交改动，
说明改了契约没重新生成（或反过来手改了生成物）——直接是缺陷。

---

## C1 · 三道防漂移门禁真的在守吗

项目声称有三道门禁。逐道验证**它们真的会拦住漂移**——
方法是**故意制造一次漂移**，看门禁响不响：

| 门禁                                        | 制造漂移的方法                                 | 应该发生什么             |
| ------------------------------------------- | ---------------------------------------------- | ------------------------ |
| `pnpm contracts:check`                      | 手改 `generated/core-api.schema.json` 一个字段 | 检查失败并说明哪里不一致 |
| `crates/engine/tests/contract_sync_test.rs` | 在契约里加一个节点类型但不同步 Rust 侧         | 测试失败                 |
| `crates/core-api/tests/parity_test.rs`      | 给某个 DTO 加一个字段但契约里没有              | 测试失败                 |

**试完把改动还原**（`git checkout`）。

如果某道门禁**没有拦住**，那是最高优先级的缺陷：
它的存在会让所有人以为漂移不可能发生。

## C2 · DTO 形状比对（逐个字段）

这是你的主要工作量。对每一个 Core API 方法，比对三处：

1. `packages/contracts/src/api.ts` 里的 Zod schema
2. `crates/core-api/src/lib.rs` 里的 Rust struct（`serde` 属性）
3. 界面上实际用到的字段（`grep` 那个方法名的调用处）

重点看这些容易出错的点：

| 陷阱           | 具体检查                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| 可选 vs 必填   | Zod 的 `.optional()` 对应 Rust 的 `Option<T>` + `skip_serializing_if`      |
| 默认值         | Zod `.default()` 会在解析时填值；Rust 侧有没有对应的 `#[serde(default)]`   |
| 命名风格       | TS 用 camelCase，Rust 用 snake_case + `#[serde(rename_all)]`；有没有漏标的 |
| 空数组 vs 缺席 | `items: []` 与没有 `items` 字段，界面的处理是否不同                        |
| 数字类型       | `z.number().int()` 对应 `i64` 还是 `u32`；负数与溢出                       |
| 时间格式       | `z.iso.datetime()` 与 Rust 侧产出的字符串格式是否严格一致                  |
| 枚举取值       | 契约的 `z.enum([...])` 与 Rust 的枚举变体是否一一对应                      |

**逐个方法过一遍**，`COMMANDS` 里有 59 个方法
（`crates/core-api/src/lib.rs:131`）。列一张表：

| 方法            | 契约字段数 | Rust 字段数 | 差异 | 界面用到但契约没有 |
| --------------- | ---------- | ----------- | ---- | ------------------ |
| `workflow.list` |            |             |      |                    |
| …               |            |             |      |                    |

**「界面用到但契约没有」那一列最重要**——那正是前三次栽的形状。

查法：

```bash
# 界面里所有的类型断言，看它断言了哪些字段
grep -rn "as {" apps/web/src --include="*.tsx" --include="*.ts" -A 6
```

把断言里出现的字段名，逐个回到契约里找。找不到的就是缺口。

## C3 · IPC 方法名映射

`packages/client-core/src/ipc-mapping.ts` 把 `workflow.list` 映射成
`workflow_list`。这里错一个字，症状是「点了没反应」，而且**不报错**。

```bash
# 契约里的方法
grep -o "'[a-z]*\.[a-zA-Z]*':" packages/contracts/src/api.ts | tr -d "':" | sort > /tmp/api.txt
# 映射表里的键
grep -o "'[a-z]*\.[a-zA-Z]*':" packages/client-core/src/ipc-mapping.ts | tr -d "':" | sort > /tmp/map.txt
# Rust 侧的命令名
grep -o '"[a-z_]*"' crates/core-api/src/lib.rs | head -80 | tr -d '"' | sort > /tmp/rust.txt
diff /tmp/api.txt /tmp/map.txt
```

检查：

1. 契约里有的方法，映射表里是不是都有
2. 映射出的命令名，Rust 侧 `COMMANDS` 里是不是都存在
3. Rust 侧有的命令，是不是都在契约里有定义（多出来的是「旁路」）
4. 有没有拼写不一致（`run_rewind_to_approval` 这种长名字最容易写错）

**已知需要确认的一处**：`workflow.patch` 映射成 `workflow_save_draft`——
名字对不上是有意的还是历史遗留？有没有注释说明？

## C4 · Scope 映射

每个方法都有 Scope（权限范围）。检查：

1. 每个方法是不是都声明了 Scope
2. **Scope 为 `null` 的方法**——这意味着「不给远端」。
   目前 `mcp.pendingConfirms` 与 `mcp.decideConfirm` 是 null
   （给远端等于让 MCP 自己批准自己）。
   核实：还有哪些方法是 null？每一个都该有注释说明为什么。
3. MCP Server 暴露的工具清单是**从契约派生**的，不是手写的——
   去 `services/mcp-server/src/tools.ts` 确认这一点，
   并确认 CI 有门禁守着（`docs/MCP.md` 说有）
4. 写工具与只读工具的划分是否与 Scope 一致

## C5 · 事件契约

`packages/contracts/src/events.ts` 定义九类 RunEvent。检查：

| 检查                              | 方法                                                 |
| --------------------------------- | ---------------------------------------------------- |
| 九类事件的分类函数与 Rust 一致    | `contract_sync_test.rs` 有覆盖吗                     |
| `seq` 由存储分配，不接受外部传入  | 契约里有没有把 seq 标成可选/由服务端填               |
| 摘要长度上限（2000 字符）         | 契约层拦还是存储层拦？两边都拦更好，只有一边拦要说明 |
| `payload_ref` 与 `summary` 的关系 | 大内容必须走 artifact，契约有没有表达这个约束        |
| `nodeLabel` 是后加的字段          | 老事件没有它，所有消费方都有兜底吗                   |
| 敏感级别 `SENSITIVITY_LEVELS`     | 每种级别的处理是否在契约里说清                       |

## C6 · 状态机

`packages/contracts/src/state-machine.ts`：

1. 11 个运行状态、节点状态的合法迁移表
2. **终态没有出边**（succeeded / failed / cancelled）
3. 可恢复状态集合是否与引擎的 resume 逻辑一致
4. 界面认识的状态集合（`StatusBadge` 的 `RunStatusName`、
   `RunsPage.KNOWN_STATUSES`）与契约的 `RUN_STATUSES` **是不是同一个**

第 4 条有具体线索：`RunsPage.tsx:785` 手写了一份 `KNOWN_STATUSES`，
`OverviewPage.tsx` 的 `badgeStatus` 注释里提到「引擎写 waiting_approval，
我在统计里手打成 awaiting_approval」——**手写集合就是漂移的入口**。
核实这两处能不能直接用契约导出的 `RUN_STATUSES`。

## C7 · 节点定义

16 种节点类型，`packages/contracts/src/nodes/definitions.ts`（约 600 行）。

| 检查                                       | 说明                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| 每种类型都有 configSchema、ports、能力声明 | 缺一项都会让界面渲染不出来                                 |
| 中文标签在 `.describe()` 里                | 这是「Schema 驱动 UI」的关键；漏了界面就显示字段名         |
| `fieldDescriptors` 覆盖所有 Schema 形状    | 七种控件够不够用；出现新形状会 fallback 成什么             |
| `resolveNodeOutputs` 对每种类型都正确      | 动态端口（branch 的 cases）算得对不对                      |
| `externalWrite` 标注是否完整               | 有副作用的节点都标了吗（脚本、worktree、mcp.tool、notify） |
| 节点库 15 条 vs 类型 16 种                 | 脚本合并展示，注释说清了吗                                 |

**验证「新增节点类型不改 UI 代码」这个承诺**：
在契约里加一个假的节点类型（带各种字段形状），跑起界面看看：

- 节点库里出现了吗
- 拖进画布能配置吗
- 七种控件够用吗
- 需要改 UI 代码吗

**需要改 UI 才能显示 → 说明 Schema 表达力不够，那才是要解决的问题**
（CLAUDE.md 原话）。试完删掉。

## C8 · Patch 与版本守卫

`packages/contracts/src/patch.ts`：

1. 结构化操作清单（`addNode` / `connect` / `setConfig` / `removeNode` / …）
   是否覆盖界面需要的全部动作
2. **刻意没有「整份回写」**——确认真的没有任何一个操作能绕过 Diff
3. `baseRevision` 守卫：
   - 契约层怎么表达
   - `applyPatch` 在 rev 不匹配时抛什么
   - 界面拿到这个错误后显示什么（`editorStore.describe` 会带 hint）
4. `removeNode` 连带断开相关连线——有测试吗
5. 操作的**原子性**：一组操作中间失败会怎样

## C9 · 错误契约

`packages/contracts/src/errors.ts` + `crates/core-api/src/lib.rs:70` 的 `ApiError`：

| 检查                            | 说明                                |
| ------------------------------- | ----------------------------------- |
| 错误码是否枚举化                | 还是靠字符串匹配                    |
| `hint` 字段                     | 哪些错误带 hint，界面有没有显示出来 |
| Rust 的 `ApiError` 与 TS 的映射 | 序列化后界面能不能区分错误种类      |
| 每类错误界面的处理              | 冲突、找不到、校验失败、权限不足    |

**具体验证**：制造一次 `baseRevision` 冲突（两个标签页），
看错误一路从 Rust 传到界面之后**还剩多少信息**。
如果最后只剩一句「保存失败」，那么中间某一层把结构化错误压成字符串了。

## C10 · 契约的测试质量

`packages/contracts/tests/` 有 14 个文件。

要求是「**每个导出都要有测试**」。核对：

```bash
# 契约的全部导出
grep -rn "^export " packages/contracts/src/*.ts packages/contracts/src/nodes/*.ts | wc -l
```

逐个导出去找对应测试，列出没有测试的。

再抽 10 条测试看质量：

- 测试名是不是一句完整的话，说明系统承诺什么
- 有没有测**边界**（空数组、超长、重复 id、循环引用）
- 有没有测**拒绝路径**（不合法的输入是不是真的被拒）

`repo-hygiene.test.ts` 与 `dto-drift.test.ts` 特别值得读——
看它们守的是什么，够不够。

---

## 你的报告要多两样东西

### 一、DTO 对照表

59 个方法逐个填，差异一列写清楚「哪一侧有、哪一侧没有」。

### 二、门禁有效性结论

| 门禁 | 制造的漂移 | 拦住了吗 | 报错信息够不够看懂 |
| ---- | ---------- | -------- | ------------------ |
