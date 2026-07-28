# F3 前端代码审查 · 第 5 轮

- 日期：2026-07-28
- 提交 hash：审查开始时 `06e56bd` + 未提交改动；**审查中途开发方提交，HEAD 变为 `04ec7a1`**
  （`fix(ui): 工具白名单点了要有反应；界面不再露内部里程碑代号`）。
  下文所有缺陷已在 `04ec7a1` 上逐条复验仍然成立，行号以 `04ec7a1` 为准。
- 形态：静态审查，不起环境
- 门禁结果：由团队提供 —— `pnpm verify` 退出码 0，TS 979 项 / 71 文件全过，Rust 161 项全过。
  本轮未重跑 verify（按分派要求）。单独跑过：
  - `npx vitest run --project web apps/web/tests/no-internal-jargon.test.ts` → 1 passed
  - `pnpm lint` → 仅 `tests/e2e/acp-real.mjs` 的 5 条 `no-console` warning，无 error
- 覆盖：`apps/web/src` 全部 51 个文件、`apps/web/tests` 48 个文件清单 + 抽读、
  `packages/ui/src`、`packages/client-core/src`（错误类型、更新器）、`.oxlintrc.json`、
  `packages/contracts/src/api.ts`（只为核实 `LIST_PAGE_SIZE` 是否导出）、
  `packages/contracts/tests/dto-drift.test.ts`（只为核实前端坑位有没有被守住）。
  **没看**：`crates/`（B2）、`services/`（B1）、契约自身行为（B1）。

## 结论

| 指标   | 数                   |
| ------ | -------------------- |
| 检查项 | 6 组（R1–R6），38 条 |
| 缺陷   | 12                   |
| 建议   | 9                    |

剧本点名的四组重复**全部仍然存在**，其中 `formatBytes` 与 `describe(error)` 两组
已确认是**用户能看见的不一致**。本轮最值钱的三条不在重复清单里，而是
**三个「看起来有人守、实际上守不住」的门禁**（缺陷 1、5、9）。

---

## 缺陷（按严重度排序）

### 缺陷 1 · `no-internal-jargon` 测试守不住它要守的东西，而界面上三处代号仍在

**位置**：`apps/web/tests/no-internal-jargon.test.ts:26`

**现象**：正则只认三种写法：

```js
const 代号 = /（M[0-9]）|\(M[0-9]\)|M[0-9] · /u;
```

即「全角括号包起来」「半角括号包起来」「`M3 · `」。而里程碑代号在中文里最自然的
写法是直接跟名词——`M2 阶段接入`、`在 M3 随 Agent 角色一起做`——一条都不匹配。

**复现**：`04ec7a1` 上跑该测试通过（已实测），同时以下三处用户可见文本仍带代号：

| 位置                                           | 文本                                                                   | 用户在哪看到                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/web/src/editor/NodeConfigDialog.tsx:139` | `title="单节点试运行需要执行引擎，M2 阶段接入"`                        | 节点配置弹层 →「测试运行此节点」按钮的悬停提示 |
| `apps/web/src/editor/NodeConfigDialog.tsx:226` | `能力的可视化编辑在 M3 随 Agent 角色一起做`                            | 节点配置弹层 →「权限与能力」tab 正文段落       |
| `apps/web/src/pages/PlaceholderPage.tsx:25`    | `这一屏在 <strong>{milestone}</strong> 落地。当前是 M0 应用外壳阶段。` | 骨架页正文（该组件现已无人引用，见缺陷 12）    |

用 node 直接喂给该测试的正则与去注释逻辑，实测结果：

```
漏过  NodeConfigDialog.tsx:139 title 属性
漏过  NodeConfigDialog.tsx:226 正文
漏过  PlaceholderPage.tsx:25 正文
漏过  假想:JSX 换行把「（M3」和「）」拆到两行
命中  对照组：原本被修掉的写法「ACP（M3）。」
命中  行尾注释「const x = 1; // 见 (M2) 的说明」  ← 误报
```

**另外两个问题**：

1. **JSX 换行即绕过**。测试逐行匹配，而 prettier 会把长 JSX 文本折行。
   `NodeConfigDialog.tsx:226-227` 正是被折成两行的真实例子。今天哪怕写成
   `……接上 ACP（M3` / `）。` 两行，也照样漏过。
2. **去注释逻辑反了向**。`line.replace(/^\s*(\/\/|\*|\/\*).*/u, '')`（`:33`）
   只剥「整行以注释符开头」的行。行尾注释剥不掉，于是注释里合法提到 `(M2)`
   会被判成违规——而测试自己的文档注释（`:11`）写着「注释里提它是可以的」。

**影响**：这条测试是在 `04ec7a1` 这个标题为「界面不再露内部里程碑代号」的提交里
加上的。它绿着，给人「这类问题以后不会再有了」的保障，但保障的范围只覆盖了
**恰好已经修掉的那三处的写法**。下一处代号只要不带括号就照样上线。
比没有测试更糟：没有测试至少不会有人以为它被守住了。

**严重度**：高（假保障 + 三处 live 文案；违反 TESTING.md「每一个修过的坑都要有测试压着」的实质）

**建议方向**（需确认）：匹配 `M[0-9]` 后跟中文/空白/行尾的一般形态，先剥
JSX 注释与整行注释，再把整个文件的 JSX 文本节点拼起来判断而不是逐行判断。

---

### 缺陷 2 · `dto-drift` 兜底扫描漏掉它自己点名的那个坑

**位置**：`packages/contracts/tests/dto-drift.test.ts:124` 与 `:129`

**现象**：该测试的文档注释第 15 行白纸黑字写着要防的是——

```
* - `WorkflowSummary` 少 `lastRun` → 每条工作流都显示成「草稿」
```

而「有没有漏登记的结构体」那道兜底扫描是：

```js
const 源码里的 = [...源码.matchAll(/pub struct (\w+Dto) \{/g)].map((m) => m[1]!);
```

只匹配 **以 `Dto` 结尾** 的结构体名。而 Rust 那边真正的结构体叫 `WorkflowSummary`
（`crates/core-api/src/lib.rs:415`，已核实，无 `Dto` 后缀）→ **永远不进扫描集合**。
它内含的 `last_run: Option<LastRunDto>`（`lib.rs:426`）指向的 `LastRunDto`，
又被 `:129` 明确放进了豁免集：

```js
const 豁免 = new Set([ … 'LastRunDto', … ]);
```

**复现**：在 `crates/core-api/src/lib.rs:426` 删掉 `last_run` 字段，
`pnpm test` 不会失败（`dto-drift` 扫不到 `WorkflowSummary`，
`apps/web/tests/transport.test.ts:55-69` 的断言只覆盖
`id/name/updatedAt/archived/total`，不含 `lastRun`）。

**影响**：`lastRun` 一旦掉队，概览页每条工作流的状态徽章都退回「已创建」
（`apps/web/src/pages/OverviewPage.tsx:419-420` 的 `workflow.lastRun?.status ?? 'created'`），
即「所有工作流都显示成草稿」——正是该测试声称要防的症状。整条防线是空的。

**严重度**：高（假保障；这条坑在 CLAUDE.md 的「已经踩过的坑」表里）

> 注：`dto-drift.test.ts` 本体归 B1，但**它守的是前端 DTO 形状、症状发生在概览页**，
> 且是我核实「前端坑位有没有被测试盯住」时发现的。按分工表这属于
> 「前端代码……测试覆盖」，故记在这里；建议抄送 B1 复核 Rust 侧命名。

---

### 缺陷 3 · 记忆页拿不到第 51 条记忆，且条数显示永远封顶

**位置**：`apps/web/src/memory/MemoryPage.tsx:57-67`

**现象**：

```js
const result = (await coreClient.call('memory.list', {
  ...(nextScope ? { scope: nextScope } : {}),
  ...(nextQuery ? { query: nextQuery } : {}),
})) as { items: Memory[] };
setItems(result.items);
```

不传 `limit` / `offset`。而契约 `packages/contracts/src/api.ts:83` 的 `PAGING.limit`
带 `.default(LIST_PAGE_SIZE)`，`LIST_PAGE_SIZE = 50`（`api.ts:68`，已核实）。
**不传 ≠ 全量，而是被后端按 50 静默截断。** 页面又没有 `Pager`
（六个列表页里唯一一个，其余五个都有），所以没有任何翻页入口。

第二处：返回类型在契约里是 `paged(MemorySchema)`（含 `total`），
但 `:62` 的断言把它写成 `{ items: Memory[] }`，`total` 被丢掉。于是
`MemoryPage.tsx:154` 的 `{items?.length ?? 0} 条` 在记忆超过 50 条后**永远显示「50 条」**。

**复现**：造 60 条记忆 → 列表只出现 50 条，页面显示「50 条」，界面上没有任何
翻页控件，第 51–60 条无法通过 UI 触达。

**影响**：数据不可达 + 计数说谎。记忆是长期累积型数据，触顶只是时间问题。

**是不是有意为之**：代码里**没有任何注释说明**。`MemoryPage.tsx:4-15` 的顶部
文档注释列了三条产品规则（AI 提议要确认 / 停用比删除轻 / 密钥禁止写入），
只字未提分页。按剧本 §R2 的判定标准「没有说明就是缺陷」。

**严重度**：高

---

### 缺陷 4 · 同一个错误在不同屏显示的信息不一样，`hint` 在 7 个屏被丢掉

**位置**：`apps/web/src/editor/editorStore.ts:244-249` vs 其余 7 份 `describe`

`CoreApiError` 带 `hint` 字段（`packages/contracts/src/errors.ts:40,48`），
由所有页面共用的 `coreClient.call()` 抛出（`packages/client-core/src/client.ts:44,54,71,103,113`）。

只有 editorStore 那份渲染它：

```js
function describe(error: unknown): string {
  if (error instanceof CoreApiError) {
    return error.hint ? `${error.message}（${error.hint}）` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
```

另外 7 份一律是 `error instanceof Error ? error.message : String(error)`：

`runs/runsStore.ts:328`、`runs/LaunchDialog.tsx:419`、`supervisor/SupervisorDrawer.tsx:531`、
`agents/AgentsPage.tsx:762`、`prompts/PromptsPage.tsx:716`、`memory/MemoryPage.tsx:275`、
`onboarding/OnboardingPage.tsx:291`

**复现**：让 Core API 返回一个带 `hint` 的错误（`hint` 正是「该怎么办」那句）。
在编辑器里触发 → 看到「消息（提示）」；在 Agent 页 / 记忆页 / 启动表单触发
→ 只看到「消息」，**可操作的那半句消失了**。

**影响**：用户能看见的不一致。`hint` 是错误里唯一告诉人下一步做什么的部分，
在 8 个屏里有 7 个把它扔了。

**严重度**：中高

---

### 缺陷 5 · `formatBytes` 两份输出格式不同，且 RunsPage 那份超过 1GB 会显示成「2048.0 MB」

**位置**：`apps/web/src/pages/OverviewPage.tsx:395-400` 与 `apps/web/src/runs/RunsPage.tsx:599-603`

```js
// OverviewPage：1024 进制，KB/MB 用 Math.round，有 GB 档
if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;

// RunsPage：KB/MB 用 toFixed(1)，没有 GB 档
if (bytes < 1024) return `${bytes} B`;
if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
```

**复现（输入 → 两屏各自的输出）**：

| 输入            | 概览页   | 执行记录页      | 应该是   |
| --------------- | -------- | --------------- | -------- |
| 12 698 B        | `12 KB`  | `12.4 KB`       | 同一个   |
| 432 013 312 B   | `412 MB` | `412.0 MB`      | 同一个   |
| 2 147 483 648 B | `2.0 GB` | **`2048.0 MB`** | `2.0 GB` |

**影响**：同一个产物文件在概览与执行记录两屏显示成不同字符串；
超过 1GB 的产物在执行记录页显示成四位数 MB。

**严重度**：中（用户可见）

---

### 缺陷 6 · 模型页的启用/停用与删除没有错误处理，失败时界面一声不吭

**位置**：`apps/web/src/models/ModelsPage.tsx:102-114`

```js
const onToggle = async () => {
  if (!selected) return;
  await coreClient.call('model.update', { id: selected.id, enabled: !selected.enabled });
  await load();
};

const onDelete = async () => {
  if (!selected) return;
  await coreClient.call('model.delete', { id: selected.id });
  setSelectedId(null);
  setConfirmDelete(false);
  await load();
};
```

没有 try/catch。同一个代码库里其余同类写操作都有：
`MemoryPage.tsx:104-111`、`AgentsPage.tsx:168-175`、`PromptsPage.tsx:166-176`
都是 `try { … } catch (err) { setError(describe(err)) }`。

**复现**：后端拒绝 `model.delete`（例如该模型被 Agent 引用）→ `await` 抛出
→ `:111-113` 的 `setSelectedId(null)` / `setConfirmDelete(false)` / `load()` 全都不执行
→ 界面停在「确认删除」状态，**没有任何错误提示，模型还在列表里**。
用户看到的是「我点了确认删除，什么都没发生」。同时控制台留下一条
unhandled promise rejection。

**影响**：写操作失败静默。模型页顶部本来就有错误位（`ModelsPage.tsx:190-194`），
只是这两个函数没往里写。

**严重度**：中

---

### 缺陷 7 · 「已经这么栽过一次」的状态穷尽性没有测试压着

**位置**：`apps/web/src/pages/OverviewPage.tsx:411-421`

注释写得很清楚：

```
* 返回类型写成 RunStatusName 而不是 string：契约的 RUN_STATUSES 与
* StatusBadge 认识的集合必须是同一个，写 string 的话新增一个状态时
* 徽章会在运行时读 undefined.shape 崩掉整页 —— 已经这么栽过一次
*（引擎写 waiting_approval，我在统计里手打成 awaiting_approval）。
```

**现象**：全仓没有任何测试断言「`RUN_STATUSES` 的每个取值 `StatusBadge` 都认识」。
`overview-stats.test.tsx:168,188,204` 只喂了合法状态的 fixture；
`packages/ui/tests/components.test.tsx` 没有对 `StatusBadge` 的穷尽用例。

**复现**：往契约的 `RUN_STATUSES` 加一个新状态而不同步 `StatusBadge` 的映射表
→ `pnpm test` 全绿 → 运行时该状态出现时整页白屏。类型标注挡不住这个：
`RunStatusName` 会随契约自动变宽，`StatusBadge` 的映射表不会。

**影响**：CLAUDE.md「已经踩过的坑」表里的一条，TESTING.md 要求
「每一个修过的坑」都要有测试。这条只有注释，没有测试。

**严重度**：中（白屏级后果，但触发需要改契约）

**同类**：`RunsPage.tsx:785-801` 的 `KNOWN_STATUSES` 是**第二份**手写状态集合
（11 个字符串），同样无穷尽性测试，且与 `StatusBadge` 的集合分别维护。

---

### 缺陷 8 · 生产代码里有中文标识符，违反「标识符用英文」

**位置**：

- `apps/web/src/editor/ApprovalBanner.tsx:81-83` — `const 节点` / `const 摘要` / `const 等待`
- `apps/web/src/data/useWorkspaceSettings.ts:72` — `const 时间`

**现象**：CLAUDE.md §风格第一条是「注释与文档用中文，标识符用英文」，
README「代码审查的共同纪律」把它列为**违反即缺陷**的硬规矩。
这四处**没有任何豁免说明**（已逐处核实上下文注释）。

**影响**：规矩层面的违反。另有实际代价：中文标识符在 grep / 重命名 /
栈帧里都比英文难处理。

**严重度**：中（硬规矩）

> 测试文件里也大量使用中文标识符（`dropdown-completeness.test.tsx:19-35`、
> `onboarding.test.tsx:221-304`、`prompts-page.test.tsx:220-411`、
> `no-internal-jargon.test.ts:15-34` 等）。**测试是不是同样受这条约束，
> 规矩里没写清楚**——见「我没能验证的」。上面只统计生产代码。

---

### 缺陷 9 · 两处 `eslint-disable` 关的是从未启用的规则；31 个 `useEffect` 没有任何依赖检查

**位置**：`.oxlintrc.json:3`、`apps/web/src/runs/LaunchDialog.tsx:101`、`apps/web/src/agents/AgentsPage.tsx:575`

**现象**：lint 配置启用的插件是

```json
"plugins": ["typescript", "unicorn", "react", "import"]
```

`jsx-a11y` 不在其中（oxlint 的合法插件名里有它，已从
`node_modules/oxlint/configuration_schema.json` 的 enum 核实）。于是：

- `AgentsPage.tsx:575` 的 `// eslint-disable-next-line jsx-a11y/no-autofocus`
  抑制的是一条**没有启用**的规则。
- `LaunchDialog.tsx:101` 的 `// eslint-disable-next-line react-hooks/exhaustive-deps`
  同理——oxlint 未实现 `exhaustive-deps`（实测：带 `--react-plugin` 跑
  `MemoryPage.tsx` / `ModelsPage.tsx` / `AgentsPage.tsx` 零条 hooks 告警，
  而这几个文件的 `useEffect` 依赖数组明显不完整）。

**这条 disable 还违反了剧本明写的判定**：`LaunchDialog.tsx:98-102` 的 disable
**没有任何注释说明为什么要关**。剧本 §R3.1 第 1 条：「去看它为什么要关，
注释有没有说明，不说明就是缺陷」。

**实际后果（不只是形式问题）**：整个前端 31 个 `useEffect` 没有任何依赖检查。
已经能看到结果：

- `apps/web/src/memory/MemoryPage.tsx:69-71` — `useEffect(() => { void load(); }, [])`，
  `load` 未 memo 化且捕获了 `scope` / `query`
- `apps/web/src/models/ModelsPage.tsx:96-97` — 同一写法
- `apps/web/src/runs/LaunchDialog.tsx:88-102` — 依赖数组是
  `[workflowId, versionId, workdir]`，但 effect 体内用的是 `target`
  （`:86` 的 `versionId ? { versionId } : { draftRev: rev }`）。
  **`rev` 不在依赖里**：草稿版本在弹层开着时变化的话，Dry Run 报告不会重算，
  而 `:117-122` 的 `run.start` 用的是重新渲染后的新 `target`
  ——即「预检查看到的」与「实际启动的」可能不是同一版。
  （这个时序能否在真实交互中发生，我没能验证——见文末。）

**另外**：实测把 `jsx-a11y` 打开会立刻报出真实问题，例如
`MemoryPage.tsx:124` 与 `AgentsPage.tsx:271` 的
`label-has-associated-control`（两个搜索框的 label 没有可访问文本）、
`AgentsPage.tsx:293` 的 `control-has-associated-label`。
这些无障碍问题本身的严重度归 F1/F2 判，我只报「门禁没开」这个事实。

**严重度**：中（门禁形同虚设 + 一处具体的依赖缺失）

---

### 缺陷 10 · `LIST_PAGE_SIZE = 50` 抄了 5 份，而契约已经导出了它

**位置**：`apps/web/src/agents/AgentsPage.tsx:82-83`、`models/ModelsPage.tsx:38-39`、
`prompts/PromptsPage.tsx:61-62`、`data/workspace.ts:3-4`、`runs/runsStore.ts:33-34`

五处的注释一模一样：`/** 列表一页多少条。与契约的 LIST_PAGE_SIZE 一致。 */`

**现象**：注释自己承认要跟契约保持一致，却不 import。而契约**确实导出了它**
（`packages/contracts/src/api.ts:68` `export const LIST_PAGE_SIZE = 50;`，
经 `packages/contracts/src/index.ts:8` 的 `export * from './api.js'` 出桶）。
`AgentsPage.tsx:3` 甚至已经 `import { LIST_PAGE_LIMIT_MAX } from '@aiwf/contracts'`
——**同一个文件、同一个桶、上下相邻的两个常量，一个 import 一个手抄**。

**复现**：把契约的 `LIST_PAGE_SIZE` 改成 25 → 五个前端文件仍按 50 发 `limit`
→ 后端 `PAGING.limit.max` 是 200（`api.ts:71,83`）所以不报错，
但 `Pager` 的 `pageSize` 与后端实际返回的页大小对不上，翻页页码错位。
`pnpm contracts:check` 管的是生成物一致性，管不到手抄的常量。

**顺带**：`Pager` 的 `pageSize` 还有两种写法——三页传常量，
`OverviewPage.tsx:380` 与 `RunsPage.tsx:173` 直接写字面量 `50`。

**严重度**：中

---

### 缺陷 11 · 记忆页删除没有二次确认，与其余三个同类页不一致

**位置**：`apps/web/src/memory/MemoryPage.tsx:242-248` → `:104-111`

**现象**：垃圾桶按钮直接调 `memory.delete`，无任何确认。
而 Agent（`AgentsPage.tsx:365-377`）、提示词（`PromptsPage.tsx:292-304`）、
模型（`ModelsPage.tsx:231-243`）都是「删除 → 确认删除」两段式，
其中 Agent 与模型还额外给了后果说明段（`models__warn`）。

**加重情节**：`MemoryPage.tsx:4-15` 的顶部注释特意强调「停用是比删除更轻的一档」
——说明作者想过删除的破坏性，却把三个页面里唯一一个**零确认**的删除留在了这一屏。

**复现**：记忆页任一条目 → 点垃圾桶 → 立即删除，无确认、无撤销。

**影响**：误点即数据丢失，且是六个列表页里唯一如此的。

**严重度**：中

---

### 缺陷 12 · `PlaceholderPage` 已成死代码，还带着「当前是 M0 应用外壳阶段」

**位置**：`apps/web/src/pages/PlaceholderPage.tsx`（整个文件）

**现象**：全仓引用它的只有一句注释（`apps/web/src/pages/index.tsx:27`
「整屏自绘（不套 PlaceholderPage 的标题结构）」）。
`apps/web/src`、`apps/web/tests`、`tests/` 三处 grep 均无实际 import。

**影响**：31 行死代码，内含两处过期文案（`:12` 注释、`:25` 页面正文
「当前是 M0 应用外壳阶段」），而项目已经在 M2。缺陷 1 的第三处 live 文案就在这里。
留着它会让人以为还有屏在用骨架页。

**严重度**：低

---

## 表一 · 重复清单

| 重复的东西                       | 份数    | 位置                                                                                                                                                                                                                                                   | 行为一致吗                                                                                                                                                          | 用户能看见吗              | 建议                                                                         |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `formatBytes`                    | 2       | `pages/OverviewPage.tsx:395`、`runs/RunsPage.tsx:599`                                                                                                                                                                                                  | **否**（进位档位与小数位都不同，RunsPage 无 GB 档）                                                                                                                 | **是**（缺陷 5）          | 提到 `lib/format.ts`，以概览页那份为准                                       |
| `describe(error)`                | 8       | `editor/editorStore.ts:244`、`runs/runsStore.ts:328`、`runs/LaunchDialog.tsx:419`、`supervisor/SupervisorDrawer.tsx:531`、`agents/AgentsPage.tsx:762`、`prompts/PromptsPage.tsx:716`、`memory/MemoryPage.tsx:275`、`onboarding/OnboardingPage.tsx:291` | **否**（只有 editorStore 渲染 `CoreApiError.hint`）                                                                                                                 | **是**（缺陷 4）          | 提到 `client-core`，统一带 hint                                              |
| `LIST_PAGE_SIZE = 50`            | 5       | `agents/AgentsPage.tsx:83`、`models/ModelsPage.tsx:39`、`prompts/PromptsPage.tsx:62`、`data/workspace.ts:4`、`runs/runsStore.ts:34`                                                                                                                    | 一致（都是 50）                                                                                                                                                     | 改契约后会看见（缺陷 10） | `import { LIST_PAGE_SIZE } from '@aiwf/contracts'`，已导出                   |
| `formatTime`                     | 5       | `pages/OverviewPage.tsx:453`、`runs/RunsPage.tsx:811`、`editor/VersionDrawer.tsx:178`、`memory/MemoryPage.tsx:270`、`prompts/PromptsPage.tsx:711`                                                                                                      | 一致（合法输入输出相同；RunsPage 那份多接受 `undefined` → `''`）                                                                                                    | 否                        | 提到 `lib/format.ts`，签名取 `string \| undefined` 这个超集                  |
| `formatDuration`                 | 2       | `pages/OverviewPage.tsx:403(ms)`、`runs/RunsPage.tsx:732(started,ended)`                                                                                                                                                                               | 输出格式一致（`48s` / `4m18s`）；**签名不同**，RunsPage 那份多了 NaN/负数 → `''` 的兜底                                                                             | 否                        | 合成一份 `formatDuration(ms)` + 调用处相减；同名不同参在移动代码时最容易用错 |
| `POLL_MS = 1200`                 | 2       | `runs/RunsPage.tsx:35`、`mcp/McpConfirmCard.tsx:26`                                                                                                                                                                                                    | 一致                                                                                                                                                                | 否                        | 建议：轮询间隔集中一处                                                       |
| `RUNTIME_LABELS`                 | 2       | `agents/AgentsPage.tsx:46`、`models/ModelsPage.tsx:26`                                                                                                                                                                                                 | **值完全一致**，但取值写法不同：ModelsPage 有 `runtimeLabel()` 安全窄化（`:34-36`）且带「踩过一次」注释（`:22-24`），AgentsPage 用 `as never`（`:314,357`）且无注释 | 否（今天）                | 提到一处；ModelsPage 的写法是对的，AgentsPage 没学到                         |
| 状态字符串集合                   | 2       | `pages/OverviewPage.tsx:419`（靠类型）、`runs/RunsPage.tsx:785-797`（手写 11 条 `KNOWN_STATUSES`）                                                                                                                                                     | 一致（今天）                                                                                                                                                        | 契约新增状态时会看见      | 从契约的 `RUN_STATUSES` 派生，配穷尽性测试（缺陷 7）                         |
| `runs__action` 按钮类            | 11 文件 | `RunsPage`/`ModelsPage`/`AgentsPage`/`PromptsPage`/`MemoryPage`/`OnboardingPage`/`SupervisorDrawer`/`McpConfirmCard`/`LaunchDialog`/`ApprovalBanner`/`EnvHealth`                                                                                       | 一致                                                                                                                                                                | 否                        | 见建议 6                                                                     |
| `formatWhen`（SupervisorDrawer） | —       | —                                                                                                                                                                                                                                                      | **故意不同**（只给时分）                                                                                                                                            | —                         | 不是问题；但按剧本建议改名以示区分                                           |

---

## 表二 · 三个同构页对照（R2）

| 项                      | Agent                                                                                                        | 提示词                                               | 模型                                                   | 一致？            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| 分页控件                | ✅ `Pager` `:321-326`，list 传 limit/offset `:116-117`                                                       | ✅ `:253-258` / `:89-90`                             | ✅ `:177-182` / `:59-60`                               | ✅                |
| 搜索框                  | ✅ `useDebouncedSearch` `:97`（输入即搜 + 回车）                                                             | ⚠️ 手写 `onKeyDown` `:205-208`（**仅回车**）         | ❌ **没有搜索框**                                      | ❌                |
| 新建入口                | 图标按钮，`aria-label="新建角色"` `:258`；提交按钮「创建」`:754`                                             | `aria-label="新建提示词"` `:187`；提交「创建」`:541` | `aria-label="登记模型"` `:125`；提交**「保存」**`:452` | ⚠️ 措辞不统一     |
| 删除二次确认            | ✅ 内联 toggle `:365-377` + 后果说明 `:392-396`                                                              | ✅ 内联 toggle `:292-304`，**无后果说明**            | ✅ 内联 toggle `:231-243` + 后果说明 `:246-250`        | ⚠️ 提示词缺说明段 |
| 内置条目保护            | ⚠️ 删除按钮隐藏 `:365`，但 `onSave` `:139-176` **无 builtin 判断**，名称/目标/性格仍可编辑（`:349,405,421`） | ✅ `onSave` 显式拦截 `:108-111` + 模板只读 `:341`    | ➖ 契约无 `builtin` 字段，改用启用/停用                | ❌ 见下           |
| 保存按钮文案            | 「保存新版本」`:378-384`，从不 disabled                                                                      | 「保存新版本」`:305-311`，从不 disabled              | 详情区**无保存按钮**（字段只读）                       | ⚠️                |
| 错误显示位置            | 详情区顶 `:334-338` `runs__error`                                                                            | 详情区顶 `:266-270` + VersionsTab 内一处 `:661-665`  | 详情区顶 `:190-194` **+ 表单内** `:442-446`            | ⚠️                |
| 空态文案语气            | 解释性长句 `:286-289`                                                                                        | 解释性长句 `:214-216`                                | 解释性长句 `:137-140`                                  | ✅                |
| `LIST_PAGE_SIZE` 定义处 | 本地 `:83`                                                                                                   | 本地 `:62`                                           | 本地 `:39`                                             | ❌ 见缺陷 10      |

**内置角色可就地改写（补充缺陷）**：`AgentsPage.tsx:349-354` 的名称输入框对
`selected.builtin` 无判断，`:378-384` 的「保存新版本」按钮同样无条件渲染，
`onSave`（`:139-176`）也没有 builtin 分支。而同一屏 `:387-391` 明写着
**「内置角色不能删除。要改的话先复制一份 —— 副本是可编辑的。」**
——界面说「要改先复制」，却又让你直接改。提示词页在 `onSave` 里拦住了
（`PromptsPage.tsx:108-111`：「内置提示词不能直接改 —— 先「复制」一份」），
Agent 页没有。
**后端是否兜住这次写入，属于 B1/B2 的范围，我没验证**；但前端自相矛盾这一点成立。
（并入缺陷 8 之外单列会超出 12 条，故记在此处，严重度中。）

### 搜索交互对照（核实剧本那张表）

| 页面     | 搜索实现                     | 行为            | 位置                                          |
| -------- | ---------------------------- | --------------- | --------------------------------------------- |
| 概览     | `useDebouncedSearch`         | 输入即搜 + 回车 | `pages/OverviewPage.tsx:71`，input `:136-145` |
| 执行记录 | `useDebouncedSearch`         | 输入即搜 + 回车 | `runs/RunsPage.tsx:39-42`，input `:105-113`   |
| Agent    | `useDebouncedSearch`         | 输入即搜 + 回车 | `agents/AgentsPage.tsx:97`，input `:273-281`  |
| 提示词   | **自己写的 onKeyDown**       | **只有回车**    | `prompts/PromptsPage.tsx:200-209`             |
| 记忆     | **自己写的 onKeyDown**       | **只有回车**    | `memory/MemoryPage.tsx:126-134`               |
| 模型     | **没有搜索框**               | —               | 全文件无 search input                         |
| 节点库   | 本地过滤（数据在前端，合理） | 输入即过滤      | `editor/NodeLibrary.tsx:51`                   |

**剧本那张表核实无误。** 从代码侧给 F1 的证据：`hooks/useDebouncedSearch.ts:6-16`
的文档注释本身就写着这个 hook 是**为了统一「输入即搜」而建**的，
但只落地了 3/5——统一的意图有，执行到一半停了。用户在概览页学会「打字就搜」，
到提示词页打字没反应，会以为搜索坏了。

---

## 表三 · 测试缺口表（R6）

### 无专属测试文件的组件

| 组件                 | 源文件                          | 间接覆盖                                                                       | 风险                                                       |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **WorkflowNode**     | `editor/WorkflowNode.tsx`       | **无**                                                                         | 画布节点是编辑器的主体，零测试                             |
| **PermissionPolicy** | `settings/PermissionPolicy.tsx` | `settings-page.test.tsx:99-172` 6 条                                           | 尚可                                                       |
| **SchemaField**      | `editor/SchemaField.tsx`        | `node-config-dialog.test.tsx` 16× `getByLabelText`                             | 数组/字典编辑器与 `role="alert"` 分支（`:44,307`）未验证   |
| **NodeLibrary**      | `editor/NodeLibrary.tsx`        | `editor-page.test.tsx:148-163`                                                 | 搜索框、拖拽无单测（e2e 有）                               |
| **EditorToolbar**    | `editor/EditorToolbar.tsx`      | `editor-page.test.tsx:98-144,259`                                              | 改名输入框用 `defaultValue`（非受控）未测                  |
| **DiffLines**        | `editor/DiffLines.tsx`          | 仅经 VersionDrawer                                                             | `empty` prop 分支（`SupervisorDrawer.tsx:430` 传入）无断言 |
| **SideNav**          | `layout/SideNav.tsx`            | `shell.test.tsx:41,58,67`                                                      | `:43` 的 `aria-label={n 项待处理}` 未断言                  |
| **TitleBar**         | `layout/TitleBar.tsx`           | `shell.test.tsx:77`                                                            | 拖拽区（踩过的坑）无测试                                   |
| **ContextMenu.tsx**  | `editor/ContextMenu.tsx`        | `context-menu.test.ts` 是 **node 环境**，测的是 `menuActions.ts`，**不碰组件** | 组件本身零 DOM 测试                                        |
| **GroupFrame.tsx**   | `editor/GroupFrame.tsx`         | `group-frame.test.ts` 同上，只测 `groupBoxes()`                                | 组件本身零 DOM 测试                                        |
| **useAppVersion**    | `updater/useAppVersion.ts`      | **无**                                                                         | 见下                                                       |
| **PlaceholderPage**  | `pages/PlaceholderPage.tsx`     | 无（已是死代码）                                                               | —                                                          |

### 组件测试覆盖表（有测试文件的）

✅ 有 · 🟡 部分/间接 · ❌ 无

| 组件             | 测试文件                                     | 空态                             | 禁用态                | aria                                  | 键盘                                                           |
| ---------------- | -------------------------------------------- | -------------------------------- | --------------------- | ------------------------------------- | -------------------------------------------------------------- |
| OverviewPage     | `overview` + `overview-stats`                | ✅ `:62-65`                      | ❌                    | ✅ `getByLabelText`，无 `aria-*` 断言 | 🟡 只有搜索 Enter                                              |
| EditorPage       | `editor-page`                                | ✅ `:187,209`                    | ✅ `:111-144`         | 🟡 30 `getByRole`，0 `aria-*`         | 🟡 只有 Escape `:244`                                          |
| NodeConfigDialog | `node-config-dialog`                         | 🟡 只有必填校验                  | ✅ `:57`              | ✅ `:40` `aria-modal`                 | ❌ **0 键盘事件**                                              |
| RunsPage         | `runs-page`+`run-failure`+`artifact-preview` | ✅ `:95,319`                     | ❌                    | ✅ `:231` `aria-selected`             | ❌                                                             |
| LaunchDialog     | `launch-dialog`                              | 🟡                               | ✅ `:137`             | ✅ `:292` `aria-invalid`              | ❌                                                             |
| VersionDrawer    | `version-drawer`                             | ✅ `:102,130`                    | ✅ `:154`             | 🟡                                    | ❌                                                             |
| SupervisorDrawer | `supervisor-drawer`+`-history`+`-proposal`   | ✅ `history:104`                 | 🟡 只有 `toBeEnabled` | ✅ `:95-170`                          | ✅ `:115,133,144`                                              |
| McpConfirmCard   | `mcp-confirm`                                | ✅ `:112-113`                    | ❌                    | 🟡                                    | ❌                                                             |
| MemoryPage       | `memory-page`                                | ✅ `:103,143`                    | ❌                    | 🟡 **0 `getByLabelText`**             | 🟡 搜索 Enter                                                  |
| AgentsPage       | `agents-page`+`agents-editing`               | ✅ `:83-86`                      | ✅ `editing:157-231`  | ✅                                    | ✅ `:276,298`                                                  |
| PromptsPage      | `prompts-page`+`prompts-editing`             | ✅ `:95,287`                     | ❌ **0**              | 🟡                                    | 🟡 只有 Enter                                                  |
| ModelsPage       | `models-page`                                | ✅ `:76-79`                      | ✅ `:239,276`         | ✅ `:218-226` `aria-pressed`          | ❌                                                             |
| EnvHealth        | `env-health`                                 | 🟡 只测探测失败，**无 0 项空态** | ❌                    | 🟡                                    | ❌                                                             |
| OnboardingPage   | `onboarding`                                 | ❌                               | ❌                    | 🟡 27 `getByRole`，0 label            | ❌                                                             |
| SplitPane        | `split-pane`                                 | ➖                               | ❌                    | ✅ `:109-110`                         | ✅ `:117,120`                                                  |
| Pager            | `pager`                                      | ✅ `:42`                         | ✅ `:65,70`           | 🟡                                    | ❌                                                             |
| ApprovalBanner   | `editor-approval-banner`                     | ✅ `:120-121`                    | ❌                    | 🟡                                    | ❌                                                             |
| UpdateCard       | `update-card`                                | ✅ `:22,91-104`                  | 🟡 只有 `toBeEnabled` | 🟡                                    | ❌                                                             |
| ChatInput        | `chat-input`                                 | ✅ `:71`                         | ✅ `:82-85`           | 🟡                                    | ✅ **全仓最好** `:30-85`，且 `:100-114` 有源码扫描防止别处重抄 |
| SettingsPage     | `settings-page`                              | ✅ `:89-95`                      | ❌                    | ✅ `:62,84,102,119,169`               | ❌                                                             |

**横向结论**：

- **禁用态**是最大的空白——20 个有测试的组件里 12 个零 `toBeDisabled` 断言，
  而 `docs/TESTING.md` 明确要求测禁用态。
- **键盘**其次——11 个组件零键盘事件，其中 `NodeConfigDialog` 是弹层
  （Escape 关闭只在 `packages/ui/tests/components.test.tsx:115` 泛化测过，
  没测这个弹层自己）。
- **`aria-*` 属性断言**几乎不存在，绝大多数只用 `getByRole` / `getByLabelText`
  间接触及。

### 踩过的坑 → 有没有测试盯住

| 坑（CLAUDE.md / 源码注释）                            | 有测试？          | 证据                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快速连点新建会建出多条                                | ✅                | `overview-stats.test.tsx:222` `it('连点五次只建一条 —— state 更新是异步的，挡不住同一批事件')`，`:244` 并发 5 次点击。**但只覆盖概览页**——Agent/提示词/模型的新建按钮都没有 `creatingRef` 保护，也没有对应测试                                                                     |
| 手写 DTO 漏字段（`lastRun`/`nodeLabel`）              | 🟡 **有洞**       | `nodeLabel` ✅ `contracts/tests/events.test.ts:174,187-188`；`lastRun` 只有 schema 层 `api.test.ts:238-290`，**传输层 `transport.test.ts:55-69` 不含 `lastRun`**，兜底扫描漏掉（**缺陷 2**）                                                                                       |
| 模型 runtime 字符串写错被 Zod 挡下                    | 🟡 间接           | `_contractClient.ts:1-46` 对所有出站 payload `safeParse`，坏值会让 `models-page.test.tsx:201-210` 失败。但**无负向测试**断言 `z.enum(AGENT_RUNTIMES)` 拒绝坏串，也**无测试断言 `RUNTIME_LABELS` 的键 ⊆ `AGENT_RUNTIMES`**                                                          |
| 版本号必须走 `useAppVersion()`                        | ❌ **无**         | 规则只存在于注释（`SettingsPage.tsx:12-13`、`useAppVersion.ts:7-10`）。`useAppVersion.ts` 无测试文件；`update-card.test.tsx:5` 只 import 类型、手搓 fixture。**把 `useAppVersion()` 换成 `import.meta.env` 不会有任何测试失败**——而这正是 CLAUDE.md 说会导致「跳过更新检查」的那条 |
| `badgeStatus` 状态集穷尽                              | ❌ **无**         | 见缺陷 7                                                                                                                                                                                                                                                                           |
| Preview.js 不解析 CSF `args`                          | ❌ **无**         | 规则只在 `Button.stories.tsx:10` 的散文里，运行时兜底在 `packages/ui/preview/main.tsx:41-47`。`repo-hygiene.test.ts` 只有 2 条，不涉及 stories。**新写一个 `{ args }` 形式的 story 不会有测试失败**                                                                                |
| 窗口拖不动（`data-tauri-drag-region` + capabilities） | ❌ **无前端测试** | `TitleBar.tsx` 无测试文件                                                                                                                                                                                                                                                          |

### 组件画廊

`packages/ui/src/components/*.stories.tsx` 共 **7 个**（Button / Card / Dialog / Field /
StatusBadge / Table / Tag）。**`apps/web` 的组件一个 story 都没有**（全仓
`find -name "*.stories.tsx"` 只有那 7 个）。

记忆里那条「没有 stories 的组件无法验收」如果适用于业务组件，
则弹层、抽屉、三栏页全部不达标。**我判断不了这条是否只针对设计系统组件
——规矩里没写清楚**，列入「我没能验证的」。

### 测试质量抽查（10 条）

按剧本四问抽查，整体质量**高于我预期**：

**好的**（测试名是一句完整承诺、断言行为不断言实现）：

1. `overview-stats.test.tsx:222` `it('连点五次只建一条 —— state 更新是异步的，挡不住同一批事件')`
   ——名字说清了系统承诺什么**和为什么难**，断言的是真实 `createWorkflow` 调用次数，不是 mock 自证。
2. `chat-input.test.tsx:100-114` 扫源码禁止别处重抄 Enter+shiftKey 逻辑——**用测试防重复**，
   这个思路正是我这份报告 R1 想要的东西。
3. `overview.test.tsx:159-165` 区分「加了筛选的空」与「本来就空」——测的是产品语义。
4. `agents-editing.test.tsx:204` 明写回归点（`useState` 只取一次 `models[0]`）。
5. `apps/web/tests/_contractClient.ts:1-46` 全局把出站 payload 拿真契约 `safeParse`
   ——这是**反 mock-喂-mock** 的正确做法，值得表扬。

**弱的**：6. `no-internal-jargon.test.ts:29` `it('没有一处用户可见文本写着 M0–M9')`
——名字是一句完整承诺，但**断言没有兑现承诺**（缺陷 1）。测试名越肯定，
假保障越危险。7. `env-health.test.tsx:140` 归在「空态」下的其实是「探测失败」，
真正的 0 项空态没测。8. `context-menu.test.ts:1` / `group-frame.test.ts:1` 用 `@vitest-environment node`
测纯函数——本身没问题，但文件名让人以为组件被测过了。**建议改名**
（如 `menu-actions.test.ts` / `group-boxes.test.ts`）。9. `update-card.test.tsx:81` 只有 `toBeEnabled` 没有 `toBeDisabled`——
禁用态是这个卡片的主要状态之一。10. `dto-drift.test.ts:124` 的兜底扫描（缺陷 2）——**这是抽查里最严重的一条**：
一条专门用来「防止有人漏登记」的元测试，自己的匹配规则漏掉了目标。

---

## 建议（需确认）

> 以下**不是缺陷**，不得据此直接改 UI。

1. **`lib/format.ts`**：把 `formatTime` / `formatBytes` / `formatDuration` /
   `formatTokens` 收成一处并配单元测试。这四个函数目前共 14 份拷贝。
   `SupervisorDrawer.formatWhen` 语义确实不同（只给时分），保留但建议改名
   为 `formatClockOnly` 之类，避免下次有人当成重复合并掉。
2. **`describe(error)` 提到 `client-core`**：与 `CoreApiError` 定义在同一层，
   统一带 `hint`（缺陷 4 的修法）。顺带把 `UpdateCard.tsx:111` 的
   `describe(status, latest)` 改名——**同名不同义比重复更糟**，
   它翻译的是更新状态不是错误。
3. **`RunsPage` 的事件投影函数下沉**（剧本 §R4.3 点名，我同意）：
   `nodeRows` / `stateOf` / `pendingApprovalNode` / `attemptOf` / `failureDetail`
   （`RunsPage.tsx:700-750` 一带）都是**从 RunEvent 流投影出视图**的逻辑，
   `client-core/src/event-store.ts` 才是它们的家，那里有测试。
   放在页面组件里意味着「事件乱序 / 重复 / 缺失时怎么办」只能靠组件测试碰运气。
   `RunsPage.tsx` 820 行里有 4 个组件 + 12 个纯函数。
4. **`.oxlintrc.json` 加 `jsx-a11y`**（缺陷 9 的修法之一）。实测能立刻报出
   真实问题。exhaustive-deps 得另找工具（oxlint 未实现），
   或至少把两条无效的 `eslint-disable` 注释改成说明性注释。
5. **`useDebouncedSearch` 铺到提示词页与记忆页**，模型页补搜索框。
   ⚠️ **模型页加搜索框属于改 UI，图纸「07 模型」有没有画搜索框我没核对，
   必须先看图纸再动**。
6. **`runs__action` 收成 `packages/ui` 的组件**：11 个文件手写这个 class，
   而 `@aiwf/ui` 的 `Button` 只有 6 个文件用。要么把 `runs__action` 提成组件，
   要么说明为什么设计系统的 Button 不适用。⚠️ 涉及外观，需 F1 与图纸确认。
7. **`as never` 换成安全窄化**：`AgentsPage.tsx:314,357` 抄
   `ModelsPage.tsx:34-36` 的 `runtimeLabel()` 就行——同一个仓库里正确答案已经有了。
   `EnvHealth.tsx:180` 的 `item.installHint!.command` 我**没找到真实的失败路径**
   （`item` 在渲染期不被改写，闭包捕获的窄化实际成立），
   改成在 `:175` 处 `const hint = item.installHint` 即可去掉断言，属于洁癖级。
8. **大列表虚拟化**：1000 条工作流 / 5000 条事件目前全量渲染。
   我判断不了这是既定架构选择还是遗漏，**留给 F2 实测帧率后再定**。
9. **`apps/web` 复杂组件补 stories**（弹层、抽屉、三栏），
   前提是先澄清那条记忆的适用范围（见下）。

---

## 我没能验证的

1. **`LaunchDialog` 的 `rev` 竞态能否真实发生**（缺陷 9 末段）。
   依赖数组确实缺 `rev`，但启动表单开着时草稿版本能否变化，
   取决于弹层是否模态、主管 AI 能否在后台改草稿。
   **需要 F2 实测**：开启动表单 → 让主管 AI 改草稿 → 看 Dry Run 报告是否刷新。
2. **Agent 内置角色的编辑是否被后端兜住**。前端确实没拦（`AgentsPage.tsx:139-176`），
   界面文案也自相矛盾，但 `agent.update` 对 `builtin` 的处理在 Rust 侧，属于 B2。
3. **中文标识符的规矩是否覆盖测试文件**。CLAUDE.md 只写「标识符用英文」，
   没区分生产/测试。测试里大量使用（`dropdown-completeness.test.tsx`、
   `onboarding.test.tsx`、`prompts-page.test.tsx`、`no-internal-jargon.test.ts` 等），
   数量之大不像疏忽，更像有意的约定。**缺陷 8 只统计了生产代码的 4 处**。
   建议在 CLAUDE.md 里写明。
4. **「没有 stories 的组件无法验收」是否适用于业务组件**。
   若适用，`apps/web` 全部 30 个组件不达标；若只针对设计系统组件，
   现状达标。规矩里没写清楚，我不猜。
5. **模型页该不该有搜索框**。我没读图纸「07 模型」——按第一纪律，
   这必须以图纸为准，不能因为「另两个同构页有」就判定缺失。
   同理，Agent/提示词/模型的新建与保存措辞不统一（「创建」vs「保存」、
   「新建角色」vs「登记模型」）**可能是图纸就这么写的**，我按代码一致性记录，
   但**判定权在 F1**。
6. **覆盖率数字**。未跑 `pnpm test:cov`（本轮按要求不跑重型门禁），
   表三全部是静态证据，不是行覆盖率。
7. **`packages/client-core` 的 `updater.ts:160` 也有一份 `describe`**，
   我没展开核实它与前端 8 份的关系（它在另一层，可能合理）。
