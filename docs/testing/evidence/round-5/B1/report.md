# B1 契约与 API 审查 · 第 5 轮

- **日期**：2026-07-28
- **基线 commit**：开工时 `06e56bd`（工作区有未提交的前端改动）。
  审查期间他人把那批改动提交为 `04ec7a1` —— 该提交只含 `apps/web` 与 `docs/`，
  **不含 `packages/contracts`、`crates/`、`services/` 任何文件**，也不含我的实验代码
  （逐个探针字符串 `git grep` 验证，见文末「工作区还原验证」）。
- **形态**：静态代码审查 + devserver（`http://127.0.0.1:5177`，真实数据）实证
- **门禁结果**：`pnpm verify` 由发起方跑过，退出码 0。我收工前复跑：
  - `pnpm contracts:check` → ✓ 生成物与契约源一致
  - `cargo test -p aiwf-engine --test contract_sync_test` → 7 passed
  - `cargo test -p aiwf-core-api --test parity_test` → 10 passed
  - `pnpm test` → 71 files / 979 tests passed
- **覆盖**：C1（门禁有效性，6 次实证漂移）、C2（12 个方法 DTO 形状，逐个打真实 JSON）、
  C3（IPC 方法名映射）、C4（Scope 映射）、C6（状态机集合一致性）、C9（错误契约）。
  **没看**：C5 事件契约完整项、C7 节点定义、C8 Patch 与版本守卫、C10 契约测试质量 ——
  按发起方给的优先级排在这五项之后，时间用完了。

---

## 结论

| 指标   | 数                                  |
| ------ | ----------------------------------- |
| 检查项 | 6 组（C1 / C2 / C3 / C4 / C6 / C9） |
| 缺陷   | 14（高 3 / 中 9 / 低 2）            |
| 建议   | 7                                   |

两条主线结论：

1. **三道防漂移门禁里有两道名不副实。** `contract_sync_test.rs` 里那条叫
   「引擎侧状态机与契约同名同数」的测试**根本不读契约**；`parity_test.rs`
   **完全不做 DTO 字段比对**。实证见「门禁有效性结论」。
2. **「界面用到但契约没有」这一列这次是空的 —— 但出现了镜像形态的同类问题。**
   历史三次事故的字段（`lastRun` / `workflowName` / `nodeLabel`）现在三处齐全。
   新的坑反过来：**契约声明了、引擎根本不发**，而 Zod 的 `.default()` 把值凭空填出来，
   界面与 MCP 读到的是编造值（B1-07），或者存储层有、DTO 层丢掉（B1-03）。

---

## 缺陷（按严重度排序）

### B1-01【高】`contract_sync_test.rs` 的状态机门禁不读契约，改契约不会让它变红

- **位置**：`crates/engine/tests/contract_sync_test.rs:66-104`
- **现象**：测试名叫「引擎侧状态机与契约同名同数」，文件头注释写
  「TS 改了状态机而 Rust 没跟上，这里立刻红」。实际上它把 Rust 的 `RunStatus::ALL`
  与**这个测试文件里硬编码的 11 个字面量**比对。`meta()`（读契约生成物的函数）
  在这个测试里一次都没被调用 —— 它守的是「Rust 与测试文件一致」，不是「Rust 与契约一致」。
- **复现**：
  1. 在 `packages/contracts/src/state-machine.ts:7` 的 `RUN_STATUSES` 里加第 12 个状态
     `abandoned`（并在 `RUN_TRANSITIONS` 补 `abandoned: []`）
  2. `pnpm contracts:gen`
  3. `cargo test -p aiwf-engine --test contract_sync_test` → **7 passed，全绿**
     （契约 12 个状态，Rust 11 个）
  4. 此时唯一变红的是 `packages/contracts/tests/state-machine.test.ts:22`，
     而它的报错**只告诉你把新状态补进那份硬编码列表**
  5. 照报错提示补上 → `pnpm test` 979 passed、`contract_sync_test` 7 passed、
     `parity_test` 10 passed，**漂移完整出厂，Rust 侧仍然是 11 个状态**
- **影响**：这道门禁的存在会让所有人以为状态机漂移不可能发生，而它恰好不拦这件事。
  真实后果是引擎收到一个它不认识的状态字符串，或界面等一个引擎永远不会写的状态。
- **同一形状还波及** `NODE_STATUSES`（8 个）：同一个测试、同一种硬编码，同样不读契约。

### B1-02【高】12 个出参结构体不受 DTO 漂移守卫，加字段无人报警

- **位置**：守卫在 `packages/contracts/tests/dto-drift.test.ts:123-140`；
  漏掉的结构体在 `crates/core-api/src/lib.rs`
- **现象**：剧本把「给某个 DTO 加一个字段但契约里没有」归给 `parity_test.rs`，
  但 `parity_test.rs` **完全不做字段比对**（它只查 camelCase 标注、`skip_serializing_if`、
  命令表注册）。真正在守这件事的是 `dto-drift.test.ts`，
  而它的兜底用 `/pub struct (\w+Dto) \{/g` 找 DTO —— **只认名字以 `Dto` 结尾的结构体**。
- **复现**：给 `ArtifactDto`（受守卫）与 `WorkflowSummary`（不受守卫）各加一个字段并补上初始化
  1. `cargo test -p aiwf-core-api --test parity_test` → **10 passed，全绿**
  2. `pnpm test` → 979 个测试里只有 1 个失败，报的是 `ArtifactDto` 的 `driftProbeA`；
     **`WorkflowSummary.driftProbeB` 无人报警**
- **无人守的 12 个**（都带 `#[derive(Serialize)]`，都会真的发到界面）：

  | 结构体                    | 行号 | 服务的方法                            |
  | ------------------------- | ---- | ------------------------------------- |
  | `ApiError`                | 70   | 所有方法的错误出口                    |
  | `RunSummary`              | 191  | `run.list` / `run.get`                |
  | `RunEventsPage`           | 237  | `run.events` 外层信封                 |
  | `WorkflowSummary`         | 415  | `workflow.list`                       |
  | `WorkflowDetail`          | 473  | `workflow.get`                        |
  | `SupervisorSessionDetail` | 1220 | `supervisor.session`                  |
  | `Page<T>`                 | 1354 | 所有分页列表的信封                    |
  | `VerOnly`                 | 1366 | `agent.update` / `prompt.update`      |
  | `SupervisorAnswer`        | 1505 | `supervisor.ask`                      |
  | `DiscardResult`           | 1662 | `workflow.discardIfEmpty`             |
  | `Proposal`                | 1677 | `supervisor.ask` 的 proposal          |
  | `DiagnosticsResult`       | 1773 | `run.diagnostics` / `env.diagnostics` |

- **影响**：`WorkflowSummary` 与 `RunSummary` **正是历史三次事故里两次的当事结构体**
  （`WorkflowSummary` 漏 `lastRun`、`RunSchema` 漏 `workflowName`）。
  事故之后建的守卫恰好把这两个漏在外面 —— 同一个坑第四次踩下去，守卫还是不响。
  而 B1-03 说明它**已经在漏了**。
- **附带**：`LastRunDto` / `VersionMetaDto` 被列进豁免名单，理由是「别的 DTO 的容器或嵌套片段」。
  但守卫本身支持 `字段路径` 钻进嵌套（`dto-drift.test.ts:94-107` 已经这么用），这两个是可以守的；
  且 `LastRunDto` 嵌在同样无人守的 `WorkflowSummary` 里，等于双重失守。

### B1-03【高】`versionId` / `draftRev` 被 DTO 层丢弃，「重跑」跑的是 rev 0 而不是原来那个版本

- **位置**：
  - 存储层**有**：`crates/store/src/lib.rs:424-425` `RunRow.version_id` / `RunRow.draft_rev`
  - DTO 层**丢**：`crates/core-api/src/lib.rs:191-205` `RunSummary` 没有这两个字段；
    `crates/core-api/src/lib.rs:494-508` 的 `From<RunRow> for RunSummary` 直接不搬
  - 映射层也不补：`packages/client-core/src/ipc-mapping.ts:225-238` 的 `toRun()`
  - 消费方**在读**：`apps/web/src/runs/runsStore.ts:236`
- **实证**（打真实 devserver）：
  ```
  $ curl -s -X POST /ipc/run_list -d '{"statuses":[]}'
  真实 run 行的键: ['endedAt','id','inputsJson','startedAt','status','workdir','workflowId','workflowName']
    versionId  引擎发了吗: False
    draftRev   引擎发了吗: False
  ```
- **坏法**：`runsStore.ts:236` 是
  ```ts
  ...(run.versionId ? { versionId: run.versionId } : { draftRev: run.draftRev ?? 0 })
  ```
  `run.versionId` 恒为 `undefined`（引擎不发，契约里是 `.optional()` 所以 Zod 也不报错），
  于是**永远走 else 分支**，`run.draftRev` 同样恒为 `undefined`，最终提交 `draftRev: 0`。
  ```
  输入：对一条「跑的是已发布 v3」的运行点「重跑」
  得到：draftRev: 0 —— 跑的是这个工作流最初那份草稿
  应该：versionId: "<原运行那个版本>"
  ```
- **影响**：重跑得到的不是「相同参数的重跑」，而是另一份完全不同的图。
  这直接违背 `runsStore.ts:234` 那句注释想保证的事
  （「沿用原运行的版本：不带的话会跑当前草稿，而草稿可能已经改过」）——
  前端已经写对了，Rust DTO 没跟上，而 B1-02 说明没有任何门禁会发现这件事。
- **佐证**：真实库 `select count(*), count(version_id) from run` → `884 | 4`，
  881 条运行的版本归属信息在 DTO 层被丢弃。

### B1-04【中】`supervisor.ask` 契约声明 `mutates: false`，实现却写三次库

- **位置**：契约 `packages/contracts/src/api.ts:683-685`；实现 `crates/core-api/src/lib.rs` 的 `supervisor_ask`
- **现象**：契约写 `mutates: false, audited: true, scope: 'workflow:read'`，
  实现里有 `store.create_supervisor_session(...)` 与两次 `store.append_supervisor_message(...)`
  —— 三次持久化写入。
- **坏法一（权限）**：只持有 `workflow:read` 的调用方能让数据库长出会话行与消息行。
  只读 Scope 不该产生持久化副作用。
- **坏法二（确认门被绕过，目前是潜在的）**：`services/mcp-server/src/tools.ts:83` 用
  `tool.mutates` 决定要不要走 `confirmWrite`：
  ```ts
  if (tool.mutates && this.options.confirmWrite) { … }
  ```
  `supervisor.ask` 今天不在 `MCP_FIRST_RELEASE_TOOLS`（`api.ts:995-1012`）里，所以还没有活的绕过。
  但工具清单是**从契约派生**的 —— 把方法名加进那个数组是一行改动，
  加进去它立刻成为一个「不需要用户确认」的写工具。
- **注**：契约里那句注释「这个方法本身 mutates: false 是有意的：AI 不能直接写库」
  对**工作流图**成立，对会话历史不成立。注释与实现各说了一半。

### B1-05【中】`RunsPage` 的 `KNOWN_STATUSES` 用 `as` 断言绕开类型检查，新状态被静默改写成「已创建」

- **位置**：`apps/web/src/runs/RunsPage.tsx:785-801`
- **现象**：
  ```ts
  function runStatus(status: string): RunStatusName {
    return KNOWN_STATUSES.has(status) ? (status as RunStatusName) : 'created';
  }
  ```
  入参是 `string`，出口是类型断言 —— 编译器不做任何检查。
- **实证**：在契约里加状态 `abandoned` 后跑 `pnpm typecheck`，**只报一处**：
  `apps/web/src/pages/OverviewPage.tsx(420,3): error TS2322`。RunsPage 一声不吭。
- **对比**：`OverviewPage.tsx:419-421` 的 `badgeStatus` 是**正确写法** ——
  返回类型写 `RunStatusName`，赋值处让编译器去撞，所以它被 typecheck 抓到了。
  那段注释（`OverviewPage.tsx:411-418`）描述的耦合是真的，只是这份保护没覆盖 RunsPage。
- **影响**：契约新增状态的运行，执行记录页会渲染成「已创建」。
  **用户看到的状态是错的，不是缺的** —— 一个正在等审批的运行显示成「已创建」，没有人会去点它。
- **附带（同一份清单在仓库里手写了 4 份）**：

  | 位置                                               | 形态                   |
  | -------------------------------------------------- | ---------------------- |
  | `packages/contracts/src/state-machine.ts:7`        | `RUN_STATUSES`（真源） |
  | `packages/ui/src/components/StatusBadge.tsx:1-12`  | `RunStatusName` union  |
  | `packages/ui/src/components/StatusBadge.tsx:20-32` | `STATUS_META` record   |
  | `apps/web/src/runs/RunsPage.tsx:785-797`           | `KNOWN_STATUSES` set   |

  `RUN_STATUSES` 在 `packages/contracts` 之外**一次都没有被 import**（全仓 grep 确认）。
  且 `packages/ui/package.json` 没有 `@aiwf/contracts` 依赖，
  所以 `RunStatusName` 目前**结构上无法**从契约派生 —— 要修得先加这条依赖。

### B1-06【中】引擎错误没有 `hint`，`normalizeIpcError` 还会再丢一次

- **位置**：`crates/core-api/src/lib.rs:69-74`；`packages/client-core/src/ipc-mapping.ts:481-501`
- **实证**（curl 打真实 devserver，用过期 `baseRev=0` 提交草稿）：
  ```
  HTTP 400
  {"code":"REVISION_CONFLICT","message":"草稿已变化：基础版本 0，当前 rev 1","retriable":true}
  ```
- **现象**：契约的统一错误对象是 `{code, message, retriable, hint}`
  （`packages/contracts/src/errors.ts:28-35`），`hint` 的注释写「给用户的下一步建议，界面直接展示」。
  而 Rust 的 `ApiError` 只有三个字段，**没有 hint** —— 引擎侧产生的错误一条都不可能带 hint。
- **第二次丢失**：`ipc-mapping.ts:484-494` 的 `normalizeIpcError` 重建 `CoreApiError` 时
  只读 `code` / `message` / `retriable`。**即使将来 Rust 补上 hint，也会在这一层被丢掉**
  （`details` 同理）。这是个当下看不出症状、补了上游也不生效的坑。
- **终点**：`apps/web/src/editor/editorStore.ts:244-249` 的 `describe()` 是
  ``hint ? `${message}（${hint}）` : message``。hint 恒为 undefined，
  用户最终看到的就是裸的 `草稿已变化：基础版本 0，当前 rev 1`。
- **影响**：这条错误还剩「哪种错」和「一句引擎口径的话」，没有「接下来该干什么」。
- **注**：客户端**自己**造的错误（`client.ts:52-59`、`ipc-mapping.ts:124-127`、
  `httpTransport.ts:23-27,39-44`）都带了 hint，形状是对的。缺的只有 Rust 那一侧。

### B1-07【中】`RunSchema` 三个字段无任何生产者，Zod 用 `.default()` 把值凭空填出来

- **位置**：`packages/contracts/src/domain.ts:76-91`
- **现象**：`packages/client-core/src/client.ts:69` 对每个返回值做 `spec.output.safeParse(raw)`。
  契约里带 `.default()` 而引擎不发的字段，**Zod 会填出一个值**，界面与 MCP 读到的是编造值。
  逐个确认（真实 JSON 佐证见 B1-03 的键清单）：

  | 字段               | 契约位置                                    | 引擎发吗                               | 落到界面的值                        |
  | ------------------ | ------------------------------------------- | -------------------------------------- | ----------------------------------- |
  | `permissionPreset` | `domain.ts:90` `.default('workspace_safe')` | 否                                     | 恒为 `"workspace_safe"` —— **编造** |
  | `envSnapshot`      | `domain.ts:82` `.default({})`               | 否（`ipc-mapping.ts:232` 硬编码 `{}`） | 恒为 `{}` —— **编造**               |
  | `versionId`        | `domain.ts:77` `.optional()`                | 否（store 有，见 B1-03）               | 恒缺席                              |
  | `draftRev`         | `domain.ts:78` `.optional()`                | 否（store 有，见 B1-03）               | 恒缺席                              |
  | `parentRunId`      | `domain.ts:89` `.optional()`                | 否（store 的 `run` 表也没这列）        | 恒缺席                              |
  | `workflowName`     | `domain.ts:76` `.default('')`               | **是**（`lib.rs:194`）                 | 真实值 ✓                            |

- **坏法**：
  ```
  输入：一次在 review_every_change 档下跑的运行，调 run.get
  得到：{ permissionPreset: "workspace_safe", envSnapshot: {} }
  应该：真实档位，或字段整个缺席
  ```
- **影响范围**：当前 Web 界面没有显示 `permissionPreset`（grep 只命中
  `settings/PermissionPolicy.tsx` 与 `onboarding/OnboardingPage.tsx`，那两处读的是
  `workspace.settings`，是真值），所以界面上暂时看不出问题。
  但 `run.list` / `run.get` **都在 `MCP_FIRST_RELEASE_TOOLS`**（`api.ts:1003-1004`），
  而 `services/mcp-server/src/bin.ts:37` 用同一个会 Zod-parse 的 `CoreApiClient` ——
  **MCP 里的 AI 每次查运行都会读到 `permissionPreset: "workspace_safe"`**，
  并据此推断这次运行的权限档。
- **另注**：`envSnapshot` 恒为 `{}` 掩盖了「同一工作流不同参数并行运行互不影响」
  这条 M2 出口标准所依赖的字段目前没有实现。

### B1-08【中】`workflow.patch` 的 `diff` 与 `validation` 是客户端伪造的常量，`operations` 被整个丢弃

- **位置**：`crates/core-api/src/lib.rs:1087-1094`（`workflow_save_draft` 只返回 `i64`）；
  `packages/client-core/src/ipc-mapping.ts:338-344`
- **现象**：
  ```ts
  case 'workflow.patch':
    return { rev: raw as number, diff: { added: [], removed: [], changed: [] },
             validation: { ok: true, issues: [] } };
  ```
  ```
  输入：任何一次 workflow.patch
  得到：diff 恒为空、validation.ok 恒为 true
  应该：反映真实改动与真实校验结果
  ```
- **影响**：注释说「Diff 与校验结果已在客户端算过（DraftStore）」—— 对 Web 界面成立，
  但 **MCP 调 `workflow.patch` 时没有 DraftStore**，拿到的就是「一定成功、什么都没改」。
  契约摘要写「rev 不匹配返回 REVISION_CONFLICT」，`validation.ok: true` 会让 MCP 侧的 AI
  以为它提交的图是合法的。
- **附带**：契约入参的 `operations`（`api.ts:305`，`.min(1)` 必填）在
  `ipc-mapping.ts:129` 被整个丢弃，只发 `{id, baseRev, graphJson}`。
  而这个方法 `audited: true` —— **审计事件里没有「改了什么」**，
  这与 CLAUDE.md「刻意没有整份回写，那会绕过 Diff 与审计」的设计意图相反。

### B1-09【中】`run.start` 的 `dryRun` 被静默丢弃，`dryRun: true` 会真的跑一次

- **位置**：契约 `packages/contracts/src/api.ts:414` `dryRun: z.boolean().default(false)`；
  `packages/client-core/src/ipc-mapping.ts:135-141` 的白名单不含它；
  `crates/devserver/src/dispatch.rs:184-192` 的 `run_start` 参数列表**逐个核对确认没有**
  （只收 `workflowId` / `versionId` / `draftRev` / `inputsJson` / `workdir`）
- **坏法**：
  ```
  输入：coreClient.call('run.start', { workflowId, versionId, dryRun: true })
  得到：真的启动一次运行，产生副作用
  应该：不执行；或者契约里删掉这个字段（已有独立的 run.dryRun 承担此职责）
  ```
- **缓解**：当前 `apps/web/src` 没有任何地方传 `dryRun`
  （`LaunchDialog.tsx:91` 调的是独立的 `run.dryRun`）。但 MCP / HTTP 调用方看契约会以为它有效。

### B1-10【中】`run.get` 查不到时抛「请提 issue」，而不是 NOT_FOUND

- **位置**：`crates/core-api/src/lib.rs:693` 返回 `Option<RunSummary>`；
  `packages/client-core/src/ipc-mapping.ts:379`；契约 `api.ts:473` 要求 `z.object({ run: RunSchema })`
- **实证**：
  ```
  $ curl -s -X POST /ipc/run_get -d '{"runId":"run_nope"}'
  null          （HTTP 200，不是错误状态）
  ```
  → `ipc-mapping.ts:379` 变成 `{ run: null }` → `client.ts:69` 的 `safeParse` 失败 →
  抛 `CoreApiError{ code:'INTERNAL', message:'run.get 的返回值不合契约',
hint:'这是引擎侧实现与契约不一致，请提 issue 而不是在界面里兼容' }`（`client.ts:70-77`）
- **影响**：用户点了一条已删除运行的链接，看到的是「请提 issue」。
  「找不到」是正常业务路径，不是实现 bug —— 契约的 `ERROR_CODES` 里没有 `NOT_FOUND`，
  而 Rust 侧把 `StoreError::NotFound` 映射成了 `VALIDATION`（`lib.rs:95`），
  这条路径干脆连错误都没走。

### B1-11【中】`RunEventDto` 丢掉 `status` / `artifactRefs` / `parentEventId`，且写入侧从没填过

- **位置**：契约 `packages/contracts/src/events.ts:147,151,152` 声明这三个可选字段；
  `crates/core-api/src/lib.rs:213-233` 的 `RunEventDto` 没有它们；
  存储层读取侧 `crates/store/src/lib.rs:2246-2251` 的 SELECT 也不取这三列
- **实证**（真实事件 JSON）：
  ```
  事件键: ['actor','id','runId','schemaVer','sensitivity','seq','summary','ts','type']
  ```
  契约声明 16 个字段，真实事件只有 9 个键。
  `nodeId` / `nodeLabel` / `attempt` / `payloadRef` 在 Rust DTO 里**有**
  （带 `skip_serializing_if`，这条运行级事件恰好为 None）；
  `status` / `artifactRefs` / `parentEventId` **在 Rust DTO 里根本不存在**。
- **坏法**：
  ```
  输入：packages/contracts/src/events.ts:239 的 validateEventStream 想检 DANGLING_PARENT
  得到：parentEventId 永远 undefined，这条不变量校验永远不执行 —— 是死代码
  应该：要么 engine 真的串起父子事件，要么把这三个字段从契约里摘掉
  ```
- **影响**：`artifactRefs` 缺席意味着**事件与产物之间没有任何关联链路** ——
  `run.artifacts` 只能按整条 run 列产物，无法回答「这一步产出了什么」。

### B1-12【中】`retriable` 与结构化冲突信息造出来了，没有任何消费方

- **位置**：`packages/contracts/src/errors.ts:17-26`（每个错误码的默认可重试性）；
  `crates/core-api/src/lib.rs:92-127`（逐个错误分支填 `retriable`）
- **现象一**：全仓 grep `REVISION_CONFLICT`，**命中的全是测试与定义，
  没有一处界面代码按错误码分支**。`retriable` 从 store 一路算到界面，然后没人读。
  `REVISION_CONFLICT` 是 `retriable: true`，本该给用户一个「重新加载后再保存」的动作，
  现在只有一行红字。
- **现象二**：`crates/store/src/lib.rs:33` 的 `StoreError::RevisionConflict{..}` 带结构化的
  base / current 修订号，转成 `ApiError` 时走 `error.to_string()`（`lib.rs:92-104`），
  两个数字被拼进一句中文里。界面拿不到数字，要恢复只能去正则解析那句中文 ——
  而那正是「错误码枚举化，不靠字符串匹配」要避免的。

### B1-13【低】三个入参被静默丢弃（`categories` / `scopeId` / `archived`）

逐个在 `crates/devserver/src/dispatch.rs` 核对了实际参数列表：

| 契约入参                 | 契约位置     | dispatch 实际收                                              | 后果                                       |
| ------------------------ | ------------ | ------------------------------------------------------------ | ------------------------------------------ |
| `run.events.categories`  | `api.ts:484` | `dispatch.rs:211-216` 只收 `runId`/`fromSeq`/`limit`         | 按类别筛事件无效，返回全部                 |
| `memory.list.scopeId`    | `api.ts:691` | `dispatch.rs:42-48` 只收 `scope`/`query`/`limit`/`offset`    | 按 scopeId 筛记忆无效，返回该 scope 下全部 |
| `workflow.list.archived` | `api.ts:249` | `dispatch.rs:239-245` 只收 `status`/`query`/`limit`/`offset` | 归档筛选不生效                             |

```
输入：memory.list({ scope:'workflow', scopeId:'wf_a0c9...' })
得到：所有 workflow 作用域的记忆
应该：只有那个工作流的
```

严重度低是因为当前 UI 没用这三个参数、记忆表为空；但 `memory.list` 与 `run.events`
都在 `MCP_FIRST_RELEASE_TOOLS` 里，MCP 侧的 AI 会以为筛选生效了。

### B1-14【低】`workflow.get` 的 `archived` 恒为 false

- **位置**：`crates/core-api/src/lib.rs:473-484` 的 `WorkflowDetail` 没有 `archived` 字段；
  `packages/client-core/src/ipc-mapping.ts:319` 硬编码 `archived: false`
- **坏法**：
  ```
  输入：打开一个 archived=1 的工作流
  得到：workflow.archived === false
  应该：true
  ```
- **同处**：`latestVersion` 与 `lastRun` 也没有（契约里可选，所以只是缺席，不是错值）；
  `versions[].dependencyManifest` 被 `ipc-mapping.ts:328` 硬编码成 `{}`。

---

## 建议（需确认）

### S1 `contracts:check` 失败时不说哪里不一致

`packages/contracts/scripts/generate.ts:76` 只输出
「✗ core-api.schema.json 与契约源不一致，请跑 pnpm contracts:gen 后提交」。
生成物是 9000 行 JSON，开发者只能 `contracts:gen` 之后 `git diff` 才知道改了什么。
门禁**拦住了**（实证 1 确认），只是报错信息不够看懂。输出一行 diff 摘要成本很低。

### S2 `节点类型数量与契约一致` 锁的是数量不是名字

`contract_sync_test.rs:60-63` 断言 `nodeTypes.len() == 16`，实证 2 确认它能拦住「加一个节点类型」。
两点值得确认：

1. **它没有 Rust 侧的镜像可比**。全仓 grep 确认 `crates/` 的生产代码里
   **根本没有节点类型清单**（只在 `crates/engine/tests/executor_test.rs` 的测试夹具里
   出现过 `"script.shell"` 这类字面量）。所以这条不是「跨语言镜像校验」，
   是「你是不是不小心加了个节点类型」的提醒，而修法是把 16 改成 17。
2. **重命名它不响**。数量不变的漂移（`mcp.tool` → `mcp.invoke`）它一声不吭。
   把名字集合也锁上更贴合它的命名。

### S3 IPC 映射表的**值**没有任何门禁

`apps/web/tests/ipc-mapping.test.ts:131-167` 校验的是「界面用到的方法在契约里、且有映射」，
**不校验映射出来的命令名在 Rust `COMMANDS` 里存在**。
把 `run_rewind_to_approval` 打错一个字母：TS 全绿、Rust 全绿，症状是点了没反应。
Rust 的 `COMMANDS` 是个静态字符串数组，TS 侧读源码比对即可 ——
`dto-drift.test.ts` 已经在用「读 Rust 源码」这一招，照搬就行。

### S4 `EVENT_SUMMARY_MAX` 两边各硬编码一份

`packages/contracts/src/events.ts:109` 与 `crates/store/src/lib.rs:23` 各写了一个 2000，
只靠一句注释维系。**两边都真的拦**（契约 `z.string().max()`、store 在 `lib.rs:2178`
显式检查并提示走 artifact）—— 符合剧本要求的「两边都拦」。只是常量本身没有门禁。
要守的话得先把它加进 `contracts.meta.json`，再让 `contract_sync_test` 读。

### S5 `.default()` 与 `.optional()` 的态度在同一份代码库里自相矛盾

`RunSchema` 用 `.default('workspace_safe')` 描述一个无人生产的字段（B1-07 的根因）；
而 `workspace.stats` 的 `tokensThisWeek` 用 `.optional()`，`api.ts:230-236` 的注释明确写
「缺席表示还没有数据源，界面据此显示『—』而不是 0 —— 0 会被读成『这周没花钱』」。
同一个问题，两种相反的处理。**凡是引擎不保证生产的字段，`.optional()` 比 `.default()` 诚实。**

### S6 `ipc-mapping.ts` 的 `shapeFor` 是白名单式的，已经漏了四次

文件顶部注释（`ipc-mapping.ts:84-87`）自己承认「漏一个就静默丢掉」，并列举了两次事故
（`run.list` 的分页参数、`prompt.update` 的 `ver`）。B1-09（`dryRun`）与
B1-13（`categories`）就是第三、第四次。
可以加一条测试：拿每个方法的契约 input schema 的 key 集合，断言白名单分支覆盖了它们。

### S7 `ModelsPage` 的类型交叉是冗余的

`apps/web/src/models/ModelsPage.tsx:17` 的 `type ModelRow = Model & { lastLatencyMs?: number }` ——
`lastLatencyMs` 已经在 `ModelSchema`（`domain.ts:190`）里了，这个交叉没有作用。
（这条偏 F3 领域，只作记录。）

---

## 门禁有效性结论

| 门禁                                             | 制造的漂移                                                                                                          | 拦住了吗                                                                                                                         | 报错信息够不够看懂                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **实证 1** · `pnpm contracts:check`              | 手改 `generated/core-api.schema.json`：`pendingApprovals` → `pendingApproval`，`workflow.publish` 的 scope → `null` | ✅ **拦住**，退出码 1                                                                                                            | ⚠️ **不够**。只说「core-api.schema.json 与契约源不一致」，不说哪个字段。9000 行 JSON 里自己找（S1）            |
| **实证 2** · `contract_sync_test.rs`（节点类型） | 契约新增节点类型 `drift.probe` 并 `contracts:gen`，Rust 侧不动                                                      | ✅ **拦住**，`节点类型数量与契约一致` FAILED                                                                                     | ⚠️ **勉强**。只有 `left: 17 / right: 16`，靠测试名定位。且修法是把 16 改成 17，Rust 侧本就没有清单可同步（S2） |
| **实证 3** · `contract_sync_test.rs`（运行状态） | 契约新增第 12 个运行状态 `abandoned` 并 `contracts:gen`，Rust `RunStatus::ALL` 仍是 11 个                           | ❌ **没拦住**。7 passed 全绿，含那条名叫「引擎侧状态机与契约同名同数」的测试                                                     | —（根本没报错。**缺陷 B1-01**）                                                                                |
| **实证 4** · 全链路（承实证 3）                  | 按 TS 测试的报错提示把 `abandoned` 补进 `state-machine.test.ts` 的硬编码列表                                        | ❌ **漂移完整出厂**。`pnpm test` 979 passed、`contract_sync_test` 7 passed、`parity_test` 10 passed；契约 12 个状态 / Rust 11 个 | —（**缺陷 B1-01**）                                                                                            |
| **实证 5** · `parity_test.rs`（受守卫的 DTO）    | 给 `ArtifactDto` 加字段 `drift_probe_a`，契约不加                                                                   | ❌ **parity_test 没拦住**（10 passed）。由 `dto-drift.test.ts` 拦住                                                              | ✅ **很好**：「ArtifactDto 返回了这些字段但契约没声明，Zod 会静默剥掉：driftProbeA」—— 说清了字段名与后果      |
| **实证 6** · `parity_test.rs`（无守卫的 DTO）    | 给 `WorkflowSummary` 加字段 `drift_probe_b`，契约不加                                                               | ❌ **全线没拦住**。979 个 TS 测试 + 17 个 Rust 门禁测试全绿                                                                      | —（根本没报错。**缺陷 B1-02**）                                                                                |

**三道门禁的实际状况**：

| 门禁                                        | 宣称守什么                | 实际守什么                                                                                                                                                          |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm contracts:check`                      | 生成物与源一致            | ✅ **名副其实**。手改生成物一定被打回                                                                                                                               |
| `crates/engine/tests/contract_sync_test.rs` | Rust 镜像没脱离契约       | ⚠️ **部分**。事件分类、节点数量、方法清单、`AGENT_RUNTIMES` 确实读契约生成物；**状态机那条不读契约**，只对着测试文件里的字面量比 Rust                               |
| `crates/core-api/tests/parity_test.rs`      | 两端方法集一致 + DTO 规范 | ⚠️ **名副其实但范围比想象的窄**。它守命令表注册、camelCase 标注、`skip_serializing_if`，**不做任何 DTO 字段比对**。字段比对在 `dto-drift.test.ts`，且漏 12 个结构体 |

---

## DTO 对照表（抽查的 12 个方法）

每一行都打过 devserver 的真实 JSON 比对。

| 方法              | 契约字段数                                              | Rust 字段数                        | 差异（哪一侧有 / 哪一侧没有）                                                                                                                                                          | 界面用到但契约没有 |
| ----------------- | ------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `workflow.list`   | 8（+`lastRun` 6）                                       | 8（+`LastRunDto` 6）               | **名字全对齐**。`lastRun.version` 两侧都有，但 SQL 只在 run 有 `version_id` 时给值 → 真实库 884 条 run 只有 4 条有，200 条工作流的 `lastRun` 全部无 `version`                          | 无                 |
| `workflow.get`    | 4 顶层（`workflow`=8 / `graph` / `rev` / `versions`=7） | 8 顶层（扁平，无 `workflow` 包裹） | Rust 的工作流部分**没有** `archived` / `latestVersion` / `lastRun`；`VersionMetaDto` 没有 `workflowId` / `dependencyManifest`。三者由 `ipc-mapping.ts:319,328` 硬编码补出（**B1-14**） | 无                 |
| `workflow.patch`  | 出参 3（`rev`/`diff`/`validation`）；入参 4             | 出参 1（裸 `i64`）；入参 3         | Rust **没有** `diff` / `validation`（`ipc-mapping.ts:341-343` 硬编码）；入参 `operations` 根本没传给引擎（**B1-08**）                                                                  | 无                 |
| `run.start`       | 入参 6 / 出参 1                                         | 入参 5 / 出参 1                    | Rust **没有** `dryRun`（**B1-09**）                                                                                                                                                    | 无                 |
| `run.list`        | 14（`RunSchema`）                                       | **9**（`RunSummary`）              | Rust **没有** `versionId`、`draftRev`、`envSnapshot`、`parentRunId`、`permissionPreset`；`inputsJson`(Rust) ↔ `inputs`(契约) 靠 mapping 转（**B1-03 / B1-07**）                        | 无                 |
| `run.get`         | 14 + `{run:…}` 包裹                                     | 9，裸对象；查不到返回 `null`       | 同上；另 `null` 触发「返回值不合契约」（**B1-10**）                                                                                                                                    | 无                 |
| `run.events`      | 16（`RunEventSchema`）；入参 4                          | **13**（`RunEventDto`）；入参 3    | Rust **没有** `status`、`artifactRefs`、`parentEventId`；入参 `categories` 被丢（**B1-11 / B1-13**）                                                                                   | 无                 |
| `run.artifacts`   | 7 + `root`                                              | 7 + `root`                         | **完全一致**（真实 JSON 逐字段核对通过）                                                                                                                                               | 无                 |
| `memory.list`     | 15；入参 5                                              | 15；入参 4                         | 出参完全一致；入参 `scopeId` 被丢（**B1-13**）                                                                                                                                         | 无                 |
| `model.list`      | 10                                                      | 10                                 | **一致**                                                                                                                                                                               | 无                 |
| `agent.list`      | 15                                                      | 15                                 | **一致**（`capabilities` 真实值与 `CapabilitiesSchema` 五个键完全吻合）                                                                                                                | 无                 |
| `prompt.list`     | 8                                                       | 8                                  | **一致**                                                                                                                                                                               | 无                 |
| `workspace.stats` | 7                                                       | 7                                  | **一致**；`tokensThisWeek` 由 `lib.rs:944` 恒为 `None`（有注释，是有意的）                                                                                                             | 无                 |

**「界面用到但契约没有」这一列全空 —— 这次没有第四次同形状的坑。**
三次历史事故的字段（`lastRun` / `workflowName` / `nodeLabel`）现在契约、Rust、界面三处齐全，
真实 JSON 里都能看到。新问题是**反方向**的（契约有、引擎不发），见 B1-03 与 B1-07。

### 已验证「没问题」的项（避免下轮重复排查）

- **时间格式：匹配，结论确定。** 所有落库时间戳唯一来源是 `crates/store/src/lib.rs:2491` 的
  `now_iso()`，格式 `{year:04}-{month:02}-{day:02}T{HH}:{MM}:{SS}.{mmm}Z` ——
  有毫秒、有 Z 后缀、无偏移量，满足 `z.iso.datetime()`。真实 JSON 逐条核对：
  `"2026-07-28T10:52:47.605Z"`。**没有 strftime、没有 SQLite `datetime('now')`、没有秒级精度路径。**
  全仓唯一的另一个时间产出点是 `apps/web/src/onboarding/OnboardingPage.tsx:80` 的
  `new Date().toISOString()`，写给 `workspace.updateSettings.envCheckedAt`，
  而那个字段契约是宽松的 `z.string()`（`api.ts:209`），不冲突。
- **数字类型 / 负数：无风险。** `LastRunDto.duration_ms` 由 `lib.rs:988-993` 的
  `(b >= a).then_some(b - a)` 显式挡了负数（时钟回拨返回 `None` 而不是负值）；
  `worktree_bytes` / `active_worktrees` 只增不减；`ArtifactDto.bytes` 是 `u64`。
  契约里所有 `.min(0)` / `.nonnegative()` 都安全。
- **枚举取值：全部一一对应（真实库全量核对）。** `run.status` 实际出现 6 种、全部 ∈ `RUN_STATUSES`；
  `run_event.type` 15 种全部 ∈ `RUN_EVENT_TYPES`；`actor` 只有 `engine`/`user`；
  `sensitivity` 只有 `internal`；`model.runtime`/`effort` 真实值合法；
  `agent.capabilities` 与 `CapabilitiesSchema` 五键吻合。
- **可选 vs 必填：对得上。** 所有 Rust `Option<T>` 都带 `skip_serializing_if`
  （逐个核对 `lib.rs` 的 24 处），对应契约侧全是 `.optional()`。
  没有「Rust 发 null 而契约要 string」的情况；反向也查了。

---

## C3 · IPC 方法名映射（三方比对，无缺陷）

| 来源                                                                 | 条数 |
| -------------------------------------------------------------------- | ---- |
| 契约 `SPECS`（`packages/contracts/src/api.ts`）                      | 59   |
| 映射表 `COMMANDS`（`packages/client-core/src/ipc-mapping.ts:18-76`） | 55   |
| Rust `COMMANDS`（`crates/core-api/src/lib.rs:131-186`）              | 55   |

- **契约有而映射表没有的 4 个**：`workflow.validate`、`workflow.diff`、`run.retryNode`、`env.install`。
  都是尚未接通引擎的能力。调用时 `ipc-mapping.ts:512-517` / `httpTransport.ts:22-28`
  抛明确错误并带 hint，`apps/web/tests/transport.test.ts:25-26` 有用例钉住其中两个。**不是缺陷**。
- **映射表里没有契约外的方法** ✅
- **映射出的 55 个命令名，Rust `COMMANDS` 里全部存在** ✅
- **Rust 没有映射表用不到的命令**（即无旁路） ✅
- **唯一的名字不一致**：`workflow.patch` → `workflow_save_draft`。**是有意的**，
  `ipc-mapping.ts:36-37` 有注释说明（客户端算 Diff、落库写整份图 + `baseRevision` 守卫）。
  其余 54 个都是机械的点号转下划线 + 驼峰转蛇形，无拼写不一致。

**唯一的空白**：没有门禁校验映射表的**值**（建议 S3）。

## C4 · Scope 映射（声明层面无缺陷）

- **59 个方法全部声明了 Scope**，无遗漏。
- **6 个 `scope: null`**（不给远端），每个在 `api.ts` 里都有注释说明理由：
  `mcp.pendingConfirms`（否则 MCP 能看见待确认队列、找到自己那条）、
  `mcp.decideConfirm`（给远端等于自己批准自己）、`model.test`（会拉起 adapter 进程）、
  `run.diagnostics` / `env.diagnostics` / `env.install`（会动本机文件）。
- **没有「`mutates: true` 但 `audited: false`」**（写操作全部留痕）✅
- **没有「读方法拿写档 Scope」或「写方法只要读档 Scope」**（按声明值统计）✅
  —— 但 `supervisor.ask` 的**声明本身是错的**，见 B1-04。
- **MCP 工具清单确实从契约派生**：`services/mcp-server/src/tools.ts:31-49` 的 `listMcpTools()`
  遍历 `MCP_FIRST_RELEASE_TOOLS`，逐个 `getMethodSpec()` 取 summary / input schema / scope / mutates，
  且对 `scope === null` 的方法**直接抛错**（「本地专属方法不该出现在 MCP 清单里」）。
  手工维护第二份清单在结构上不可能。✅

---

## 我没能验证的

- **C5 事件契约**只做了两项抽查（`EVENT_SUMMARY_MAX` 两侧都真的拦、`seq` 在契约里是
  `.min(1)` 且注释写明由存储层分配）。`nodeLabel` 的消费方兜底、`payloadRef` 与 `summary`
  的约束表达、`SENSITIVITY_LEVELS` 各级别的处理**没查**。
- **C7 节点定义**完全没做，包括剧本要求的「在契约里加一个假节点类型，跑起界面看
  需不需要改 UI 代码」那个实验 —— 那需要起界面，超出本轮时间。
- **C8 Patch 与版本守卫**只验到错误出口（B1-06 / B1-12），没核对结构化操作清单是否覆盖
  界面全部动作、`removeNode` 连带断线有没有测试、一组操作中间失败的原子性。
- **C10 契约测试质量**没做（每个导出是否都有测试的逐项核对）。
- **`memory.list` 的真实 JSON 形状**：真实库 `memory` 表 **0 行**，devserver 返回
  `{"items":[],"total":0}`。`MemoryDto` 与 `MemorySchema` 的一致性是**纯代码比对**，
  没有真实数据佐证。尤其 `source` 与 `sensitivity` 在 Rust 侧都是裸 `String`，
  SQLite 里实际会存什么值**未验证**（只读约束下没有插数据）。建议下轮先 `memory.create` 再复查。
- **`workflow.patch` / `run.start` 的真实往返**：都是写方法，只读约束下没有 POST。
  B1-08 / B1-09 是基于 Rust 返回类型、`ipc-mapping.ts` 分支与 `dispatch.rs` 参数列表
  三处代码比对推出的，**没有实测 JSON**。
- **Tauri 桌面壳路径**：只测了 devserver（`crates/devserver/src/dispatch.rs`）。
  桌面壳的 `#[tauri::command]` 参数列表可能与 dispatch.rs 不同步 ——
  **B1-09 / B1-13 的结论只对 devserver / Web / MCP 形态成立，桌面壳未核对**。
- **`lastRun.version` 有值时的格式**：200 条工作流全部无该键（那 4 条有 `version_id` 的 run
  对应的工作流不在最近 200 条里），所以「有值时对不对」未验证。
- **`archived=true` 的工作流**：库里 200 条全是 `false`，B1-14 是代码推断
  （`WorkflowDetail` 结构体里根本没这个字段），没有实例佐证。

---

## 工作区还原验证

六次漂移实验全部 `git checkout` 还原，收工前逐项确认：

```
$ git status --porcelain packages/ crates/ services/ apps/
（空）
```

探针字符串全仓搜索（`git grep` 打 HEAD + 工作区 grep），全部无残留：
`drift.probe` / `drift_probe` / `driftProbe` / `abandoned` / `漂移探针` / `B1 审查临时节点`。

还原后四道门禁复跑全绿：`contracts:check` ✓、`contract_sync_test` 7 passed、
`parity_test` 10 passed、`pnpm test` 979 passed。

**未改动任何生产代码。本轮新增的文件只有这份报告。**

---

---

# C7 · 节点定义（追加）

补做发起方追加的一项，验证的是这个项目最核心的设计承诺：

> **「配置表单由 Schema 驱动渲染，新增节点类型不改 UI 代码」**（功能文档 §14 / CLAUDE.md）
> 「如果发现必须改 UI，说明 Schema 表达力不够，那才是要解决的问题」

- **方法**：往契约里加一个真的节点类型 `drift.probe2`，configSchema 混入 **9 种字段形状**，
  每个字段带 `.describe()` 中文标签；`pnpm contracts:gen`；
  **一行 UI 代码都不改**，用 Playwright 驱动真实浏览器（`localhost:5173` + devserver `5177`）看结果。
- **证据**：`shots/C7-配置弹层-九种字段形状.png`、`shots/C7-拖入被拒-节点配置不合法.png`

## 结论：**承诺不成立。加一个节点类型必须改 UI 代码。**

新增缺陷 3 条（1 高 / 1 中 / 1 中），详见下面。七种控件本身**够用**，问题不在控件。

| 剧本的问题                               | 结果                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 节点库里出现了吗？                       | ✅ **出现了**（见截图左侧最后一条「形状探针」），搜索也命中。但**图标是通用圆圈**，与其余 16 条都不一样          |
| 拖进画布能配置吗？                       | ❌ **第一次尝试根本拖不进去** —— 报「第 1 个操作的节点配置不合法」。改了 Schema 让必填字段带默认值之后才能拖进去 |
| 七种控件够不够用？                       | ✅ **够**。9 种字段形状全部落到 7 种控件，**没有一种 fallback 成不能编辑的东西**                                 |
| 有没有哪一种形状必须改 UI 代码才能显示？ | ⚠️ **长文本**：Schema 无法表达「这是长文本」，靠一份硬编码的**字段名白名单**                                     |

## 九种字段形状的实测渲染结果

不改任何 UI 代码，配置弹层渲染出 9 个字段，全部可编辑、保存成功、控制台零错误：

| #   | 契约里写的                              | 期望控件  | **实测渲染**                             | 判定        |
| --- | --------------------------------------- | --------- | ---------------------------------------- | ----------- |
| ①   | `z.string().min(1)` 名 `probeName`      | text      | `text(单行 input)`                       | ✅          |
| ②   | `z.string().min(1)` 名 `promptTemplate` | text-long | **`text(单行 input)`**                   | ❌ 见 B1-15 |
| ③   | `z.string()` 名 `script`（对照组）      | text-long | `text-long(textarea)`                    | ✅          |
| ④   | `z.number().int().min(0)`               | number    | `number(数字框)`                         | ✅          |
| ⑤   | `z.boolean()`                           | boolean   | `boolean(开关)`                          | ✅          |
| ⑥   | `z.enum(['low','medium','high'])`       | enum      | `enum(select)`                           | ✅          |
| ⑦   | `z.array(z.string())`                   | list      | `list(chips)`，输入 `alpha` 回车成功加入 | ✅          |
| ⑧   | `z.record(z.string(), z.string())`      | key-value | `key-value(键值表格)`                    | ✅          |
| ⑨   | `z.array(z.object({when,then}))`        | json      | `json(mono textarea)`                    | ✅          |

标签与 hint 全部来自 `.describe()` 的第一行 / 其余行，中文正常显示。
弹层头部的类型说明取自 `definition.title` + `summary`，也是 Schema 驱动的。
**`SchemaField.tsx` 与 `NodeConfigDialog.tsx` 确实一行都不用改** —— 这两个文件的承诺是兑现了的。

问题全部出在**它们之外的三张按节点类型穷举的表**。

---

## 缺陷（承接前文编号）

### B1-15【高】新增节点类型必须改 UI 代码：三张 `Record<NodeType, …>` 穷举表

- **位置**（全部在 `apps/web/src/editor/`，都是生产 UI 代码）：

  | 文件:行              | 表       | 类型                                        | 加节点类型后                    |
  | -------------------- | -------- | ------------------------------------------- | ------------------------------- |
  | `nodeDefaults.ts:12` | `TITLES` | `Record<NodeType, string>`                  | `error TS2741`                  |
  | `nodeDefaults.ts:36` | `SEEDS`  | `Record<NodeType, Record<string, unknown>>` | `error TS2741` **且运行时也坏** |
  | `nodeVisuals.ts:31`  | `ICONS`  | `Record<NodeType, string>`                  | `error TS2741`                  |

- **实证一（编译期）**：只往契约加一个节点类型、不碰 UI，`pnpm --filter @aiwf/web typecheck` 报 **3 个错**：
  ```
  src/editor/nodeDefaults.ts(12,7): error TS2741: Property '"drift.probe2"' is missing … Record<…>
  src/editor/nodeDefaults.ts(36,7): error TS2741: Property '"drift.probe2"' is missing … Record<…>
  src/editor/nodeVisuals.ts(31,7): error TS2741: Property '"drift.probe2"' is missing … Record<…>
  ```
  `Record<NodeType, X>` 要求**每个键都在**，所以这三处是强制的 —— `pnpm verify` / CI 会直接打回。
  另有 1 个错在 `packages/contracts/tests/nodes.test.ts:10`（`MINIMAL_CONFIG`），那是测试，可接受。
- **实证二（运行期，比编译期更严重）**：Vite 不做类型检查，所以界面照样跑得起来。
  但**拖不进画布**。同一个页面里做 A/B 对照：
  ```
  --- 对照组 notify（SEEDS 里有条目）---
  节点数: 3 → 4        错误提示: []
  --- 实验组 drift.probe2（SEEDS 里没有）---
  节点数: 4 → 4        错误提示: ["第 1 个操作的节点配置不合法"]
  ```
  链路：`EditorPage.tsx:209` 的 `onDrop` → `minimalConfigFor(type)`
  （`nodeDefaults.ts:56`）→ `SEEDS[type] ?? {}` 取到 `{}` →
  必填字段（`probeName` / `promptTemplate`）没有默认值，`safeParse` 失败 → 回落成 `{}` →
  `addNode` 操作被图校验拒绝 → 整个操作放弃。
  **用户看到的是一句「节点配置不合法」，而他什么都还没填。**
- **坏法**：
  ```
  输入：只往契约加一个带必填字段的节点类型，不改任何 UI 代码
  得到：① typecheck 3 个错，CI 打回；② 就算强行跑起来，节点也拖不进画布
  应该：Schema 里写完就能用
  ```
- **为什么这是「Schema 表达力不够」（CLAUDE.md 自己的判据）**：
  - `TITLES` **完全冗余** —— `titleFor()` 的兜底就是 `getNodeDefinition(type).title`，
    Schema 里本来就有 `title`。这张表存在的唯一后果就是逼你改它。
  - `SEEDS` **部分冗余** —— 可选字段的默认值 Zod 的 `.default()` 已经能表达；
    真正缺的是**「必填字段的占位值」**，`NodeDefinition` 里没有任何字段能表达它。
  - `ICONS` **完全无法表达** —— `NodeDefinition`（`definitions.ts:39-56`）没有 `icon` 字段。
    实测新节点在节点库与画布上都显示 `ph ph-circle`（`iconFor` 的兜底），
    截图里它是左侧唯一一个通用圆圈图标，与其余 16 条的语义图标格格不入。
- **修的方向**（需确认，属建议）：给 `NodeDefinition` 加 `icon` 与 `seed`（必填字段占位）两个字段，
  然后把这三张表删掉或降级成 `Partial<Record<…>>`。这正好是 CLAUDE.md 说的
  「那才是要解决的问题」。

### B1-16【中】长文本靠字段名白名单判定，Schema 无法表达「这是多行」

- **位置**：`packages/contracts/src/nodes/fields.ts:38`
  ```ts
  const LONG_TEXT_KEYS = new Set(['script', 'bodyMarkdown', 'body', 'instruction']);
  ```
  `controlFor()`（`fields.ts:122-123`）对 `type: 'string'` 的字段只看**字段名在不在这个集合里**。
- **实证**（同一个弹层里的 A/B 对照，见截图）：

  | 字段       | 名字                           | 实测 tagName        |
  | ---------- | ------------------------------ | ------------------- |
  | 提示词模板 | `promptTemplate`（不在白名单） | **`INPUT`**（单行） |
  | 脚本正文   | `script`（在白名单）           | `TEXTAREA`（多行）  |

  两个字段的 Zod 类型完全一样（`z.string()`），只因为名字不同就渲染成不同控件。

- **坏法**：
  ```
  输入：新节点类型有个多行文本字段，起名 promptTemplate / systemPrompt / template
  得到：一个 34px 高的单行输入框，用户写不了多行提示词
  应该：多行文本框
  ```
- **影响**：这是 B1-15 之外**第四份**必须手工维护的按名字穷举的清单。
  它在 contracts 而不是 UI 里，所以不算「改 UI 代码」，但性质一样 ——
  节点作者必须知道有这么个白名单，否则字段静默降级。而且它**只认这 4 个名字**，
  任何新的长文本字段都得回来改这一行。
- **修的方向**（建议）：Schema 层已经有现成的表达方式，
  比如约定 `.describe()` 的提示行里带标记，或给 `z.string()` 挂 `.meta({ multiline: true })`
  （Zod 4 支持 `.meta()`，且 `z.toJSONSchema` 会带出来）。

### B1-17【中】`NODE_LIBRARY` 是与 `NODE_TYPES` 并行维护的第二份清单

- **位置**：`packages/contracts/src/nodes/definitions.ts:533`
- **现象**：节点库面板（`NodeLibrary.tsx:23`）与右键菜单（`ContextMenu.tsx:160`）
  都从 `NODE_LIBRARY` 渲染，而它是一个**手写数组**，与 `NODE_TYPES` 各自独立。
  只往 `NODE_TYPES` 加类型而不加 `NODE_LIBRARY` 条目，节点类型存在但**界面上完全够不着**。
- **缓解（做得好的地方）**：`packages/contracts/tests/nodes.test.ts:35-39` 有守卫：
  ```ts
  const covered = NODE_LIBRARY.flatMap((entry) => entry.types);
  expect([...covered].sort()).toEqual([...NODE_TYPES].sort());
  ```
  **不重不漏，这条是真的在守**，忘了加会红。所以严重度只算中。
- **仍算缺陷的理由**：它是第五份要手工同步的清单，而 `NodeLibraryEntry` 的
  `label` / `summary` 与 `NodeDefinition` 的 `title` / `summary` 高度重复
  （现有条目的 `summary` 全部写成 `DEFINITIONS[x].summary`，说明这份重复已经被感知到了）。
  唯一真正需要额外表达的只有「脚本两条合并展示」这一个特例。

---

## C7 建议（需确认）

### S8 三张穷举表改成 `Partial<Record<NodeType, …>>` 就能解除编译期强制

三处的取值函数**已经都写了 `??` 兜底**（`titleFor`、`minimalConfigFor`、`iconFor`），
说明作者本来就预期会有缺项 —— 但 `Record<NodeType, X>` 让那些兜底永远走不到。
把类型放宽成 `Partial<Record<…>>`，编译期的强制立刻消失，运行期行为一点不变。
这是成本最低的一步（`SEEDS` 的运行期问题仍需按 B1-15 补 Schema 表达力）。

### S9 `NodeConfigDialog` 的「重试与超时」页按字段名找 `timeoutMs`

`NodeConfigDialog.tsx:235` 是 `fields.find((f) => f.key === 'timeoutMs')`。
与 B1-16 同一个形状：靠约定字段名而不是 Schema 声明。
新节点类型的超时字段若叫别的名字，这一页显示「该节点类型无超时设置」。
不算缺陷（图纸没规定），但属同类技术债，一并记下。

---

## C7 的工作区还原

`drift.probe2` 实验全部还原：

```
$ git status --porcelain
?? docs/testing/evidence/
$ grep -rn "drift.probe2|形状探针|probeName|promptTemplate" packages/ crates/ apps/ services/
（无输出）
$ pnpm contracts:check          → ✓ 生成物与契约源一致
$ pnpm --filter @aiwf/web typecheck  → 错误数: 0
```

实验期间往画布上拖过节点，但**只停留在本地草稿，从未点编辑器的「保存草稿」**。
收工前读库确认：`workflow_get` 返回 3 个节点（entry / script.shell / end），
`有没有 drift.probe2: False`。**数据库未被污染。**

**C7 全程未改动任何 UI 代码** —— 这正是这次实验的前提：
一旦允许改 UI，就测不出「新增节点类型要不要改 UI」了。
