# 审查循环清单

这份清单是**循环执行**的：每一轮挑一组，做完划掉，再从头复核一遍还剩什么。
它与 [`DEBT.md`](DEBT.md) 的分工是——DEBT 记「已经欠下的账」，
这份记「这一轮要动的手」，两边指向同一批问题时以 DEBT 的编号为准。

## 怎么跑一轮

每一轮**六步**，顺序不能换：

1. **派一个 agent 去探**。让它独立读当前的项目，回答「已有功能里哪些值得优化」——
   不带着这份清单去看，否则它只会确认清单已有的东西。它找到的追加进清单
2. **重新读一遍清单**（不是凭记忆）。上一轮的改动可能让某些条目失效或变简单
3. 从清单里挑**一组**（不是一条）——同组条目共享上下文，分开做会重复调研
4. **测试先行**：先写测试描述期望行为，跑一遍确认它红，再写实现
5. **设计一条工作流真的跑一遍**，每轮换一个方向（见下面的「方向轮换」）。
   要看的不只是「跑通了」，而是：
   - **执行过程**：每一步停在该停的地方了吗，失败时停在哪
   - **AI 调用**：agent 收到的提示词是什么，它的回答是不是基于真实材料
   - **数据记录**：写进库的每一条，问三句 —— **正确吗**（值对不对）、
     **真实吗**（是真发生过的，不是标记成功而已）、**必须留吗**（不留会丢什么）
6. 跑 `pnpm verify`，绿了才算完；做完的条目从清单里**删掉**，不标「已完成」——
   `git log` 是历史，这份是现状

**每一轮都要产出可验证的东西。** 只调研不落测试的一轮不算一轮。

### 方向轮换

每轮挑一个没跑过的方向设计工作流，避免反复测同一条最顺的路：

| 方向     | 要压的东西                                       |
| -------- | ------------------------------------------------ |
| 外部读取 | gh / 网络 / 文件读入，数据真的进到下游了吗       |
| AI 调用  | 提示词、多轮、工具调用、超时与降级               |
| 写副作用 | worktree、提交、文件改动，失败时回没回滚         |
| 人工介入 | 审批的三种决定、权限档、恢复                     |
| 失败路径 | 非零退出、超时、拒绝、杀进程，各自停在该停的地方 |
| 数据留存 | 事件、产物、检查点：够不够复盘，有没有冗余       |

### 三问的判据

「数据正确、真实、必须留」不是形容词，落到可检查的东西上：

- **正确**：值与外部事实一致（issue 号真的是那个、分支真的存在、退出码真的是 0）
- **真实**：有对应的副作用可以独立验证。`node.succeeded` 而脚本没跑过，
  就是不真实 —— 刚修过的审批那条正是这种
- **必须留**：删掉它之后，「这次运行为什么是这个结果」还答得出来吗？
  答得出就是冗余，答不出就必须留

---

## 〇、第 1 轮探索新发现（按「用户多久会撞上」排）

来自第 1 轮派出去的探索 agent，每条都核过代码。**这一节优先做完。**

### X-3 · ACP 权限请求一律拒绝，`ai.execute` 也走这条

`answer_reverse_call` 一律回 reject，注释只论证了主管 AI 的场景 ——
而 `AcpClient` 是同一个。仓库自己的实测文档写着 codex **跑命令前**触发
`request_permission`、reject 真实生效，且 codex 的文件隔离靠
`session/set_mode`（全仓零调用）。这解释了 `executor.rs:1109` 记的那次事故：
「`ai.execute` 报完成而工作区一个字节没变」。

**验收**：裁决按场景分开（主管全拒；节点执行按能力声明裁决），每次裁决写进事件流；
建会话时按权限档调一次 `session/set_mode`。

### X-4 · 取消运行不打断正在跑的节点

`cancel()` 置标志就返回，执行线程还阻塞在 `execute()` 里（AI 节点默认 900 秒）。
跑完之后照常 emit `node.succeeded` / `run.failed` —— **取消之后还在写事件**。
`AcpClient::cancel`（`session/cancel`）零调用点。

**验收**：取消时对活会话调 `session/cancel`、对脚本进程组发信号；
取消后的节点结束事件不写或写成 `node.cancelled`。

### X-6 · `client-core` 那层事件投影是死代码，界面各自又写了一份

`EventStore` 从未被实例化，7 个投影方法零调用点，却有 14 条绿测试守着。
界面重复实现了 `toTurns` / `progress` / `category` 三份。后果之一：
`RunsPage.tsx:867` 手写的映射表把 9 类压成 4 个中文词，
`script.stdout` 的类别标签显示成「运行」——而契约明说「前缀即分类，UI 不需要另维护映射表」。

**验收**：二选一（界面改用 EventStore，或删掉没人用的方法连同测试）；
类别必须来自 `categoryOfEventType`。

### X-8 · `PathGuard` 从未被调用，35 项逃逸测试守着没接电的开关

生产代码零调用点，而 `PROJECT.md` / ADR-0002 / CLAUDE.md 三处都写着它在守。
两个接受外部路径的落点（`ai.execute` 的 `declared` workdir、
`git.worktree` 的 `repoRoot`）都不过它 —— 配置里写 `/` 或 `~/.ssh` 就用它。
同形态还有 `capabilities.ts` 零测试、`isWithinCapabilities` 零调用点。

**验收**：两个落点都过 `PathGuard::check`，授权根取工作区 workdir；
各配一条越权用例；再配一条故意越权、断言变红的元测试。

---

## 〇之二、第 2 轮探索新发现

两个 agent 分头查了「死代码」与「重复逻辑 / 重复存储」，每条都跑命令核过。

### Y-0 · `version-drawer` 有一条偶发失败的测试

全量跑 `pnpm verify` 时偶尔红在
「回滚回传版本 id，由引擎写成新的草稿修订」（`onRollback` 一次都没被调用），
单独跑那个文件 12 条全过，再跑一次全量又绿。

**flaky 测试比没有测试更糟**：它会训练所有人「红了就重跑一次」，
而那正是真实失败被忽略的方式。

**验收**：找出是隔离问题（全局状态没清）还是时序问题（等待条件写得不对），
修掉；连着跑 20 次全量不红。

### Y-2 · 全文索引是创建时的冻结副本，还留孤儿

`index_text` 是 **INSERT-only**，没有 upsert 也没有先删后插：

- `rename_workflow` 改完名字再 `index_text` 一次 → 同一个 `ref_id` **两行**，
  旧名字永远搜得到
- `update_memory` / `update_prompt` 改了正文**从不重建索引** —— 索引永远是创建时的文本
- 删除触发器只覆盖 `workflow` / `run_event` / `artifact`，
  而 `memory` 与 `prompt` 也进索引却没有触发器 → 删掉之后留孤儿行。
  DDL 注释写着「删除交给触发器，保证级联删除不留孤儿索引行」，对这两类是假的

眼下影响有限（`Store::search` 没有对外出口），但 `runner_test` 拿它当
「密钥没进索引」的断言 —— 一个悄悄停止跟踪更新的索引会让那条断言变弱。

**验收**：改名/改正文后重建索引，删除后清掉；一条测试改完再搜，搜不到旧值。

### Y-3 · 节点的副作用与能力声明，契约里有一份、executor 里又硬编码一份

`node-catalog.json` 声明了每种节点的 `externalWrite` 与 `defaultCapabilities`，
`catalog.rs` 也解析进了结构体 —— **两个字段全仓零读取**。
executor 自己维护 `SIDE_EFFECT_NODES` 与 `check_capability` 的 match。

X-7 已经把那份硬编码修对了，但**成因还在**：两份东西没有任何守卫连着，
下次加节点类型照样会漂。注意两者语义不同（`externalWrite` 是「对外部世界写」，
而「要不要审批」更宽，本地写文件也算），所以不是简单替换。

**验收**：`check_capability` 由 `defaultCapabilities` 驱动；
挂起名单与契约之间加一条守卫（不只是子集检查，要能发现「契约说有副作用而名单里没有」）。

### Y-4 · 状态机转移表有三份，守卫只比状态名不比边

Rust `status.rs` 一份、TS `state-machine.ts` 一份，**两份都没有生产调用点**；
真正在运行时生效的是第三份 —— 写死在 SQL 里的
`WHERE status NOT IN ('succeeded','failed','cancelled')`（`store/lib.rs:2229`）
以及 `runner.rs` 里两处 `matches!`。

`contract_sync_test` 只比对状态名集合，边一条都没比。
而且终态判断两边算法不同：Rust 硬编码集合，TS 由「出边为空」推导 ——
在 TS 加一条出边就会让两边对「终态」的理解分叉，而守卫仍然绿。

**验收**：把转移边导出进 `contracts.meta.json` 并加进 `contract_sync_test`；
运行时那三处改成调用同一份判断。

### Y-5 · 权限档 → 授权 scope 的决策，界面与 MCP 门各写一份且已经漂了

`SupervisorDrawer.tsx` 的注释自己点名了双胞胎：「与 `catalog.rs` 的 `gate_for`
是同一套规则 —— 那边是真的拦截，这边只是把它说出来」。
而 Rust 那边多一个 `!tool.destructive` 条件，界面完全没建模：
`workspace_safe` 下抽屉显示 `workflow:write-draft` 已授权，
而一个 destructive 的写草稿工具仍然会被拦成 NeedsConfirm。

抽屉承诺了一个引擎会拒绝的权限 —— 它自己的注释把这种情况叫「比不显示更糟」。

**验收**：授权说明由同一份规则派生；一条测试断言两边对同一档位给出同一组 scope。

### Y-6 · 一批确认过的死代码

零生产调用点、只有测试在用（每条都跑过 `rg` 确认）：

- `store` 的六个非分页 `list_*`（约 98 行，与 `_paged` 版本重复，会各自漂移）
- `Store::search` + `SearchHit` + 整套 FTS5 —— 没有任何 IPC / MCP / 契约出口，
  而 `fts_index` 的触发器在每次写入时都在维护（成本最高的一条）
- `upsert_memory`（37 行）—— **agent 记忆写回「同 key 原地更新」的语义生产里不存在**
- `artifacts::preview` + `Preview`（34 行，与 `ArtifactStore::read` 重复）
- `@aiwf/ui` 的 `Card` / `Dialog` / `Table`（组件 150 行 + stories 164 行），
  零应用消费者 —— `NodeConfigDialog` 自己手写了一个弹层，`ModelsPage` 自己定义了 `Field`
- `capability_flags` / `known_runtimes` / `Client::from_runtime` / `ApiError::with_hint` /
  `with_artifact_root` —— 连测试都不引用
- `run.env_snapshot_json` 字段从不写也从不读；真的快照在 `run_checkpoint.env_json`，
  而 `ipc-mapping.ts` 硬编码 `envSnapshot: {}` 去满足契约。**一个概念三种表示，两种永远是空的**

**验收**：删（连同它们的测试），或者接上。删之前确认不是「马上要用」的。

---

## 〇之三、第 3 轮探索：用户视角

从「第一次用这个应用的人」出发找的，按多快撞上排。

### Z-3 · 进度条按「完成数 × 10%」画，与旁边的数字对不上

`RunsPage.tsx:818` 的注释说「总数要等图加载后才知道」——
而总数就在手边（`runsStore.ts:74` 的 `nodeTypes` 是整张图）。
示例工作流 12 个节点，第 10 个完成时进度条已经满格，下面还写着
「10 个节点已完成」、右侧两个还在跑。自己搭的 3 节点工作流跑完，
进度条永远停在 30%，看起来像卡住了。

**验收**：按 `done / 总数` 算；取不到图时不画这条，不用编出来的刻度。

### Z-5 · 记忆页只能删不能加，而空态承诺「AI 会提议」

全页没有任何新建入口（模型/Agent/提示词三页都有右上角 `+`）。
另一半供给也不存在：引擎里与记忆相关的代码只做**注入**，
没有任何路径写出 `source = 'ai_proposed'` 的记忆，所以「AI 提议」那块从不渲染。
把内置记忆删光之后这一页就永久空着。

**验收**：要么加新建表单（`memory.create` 后端与契约都已就绪），
要么把空态改成实话 —— 照 `NodeConfigDialog.tsx:269` 的写法直说这条路径没接。

### Z-6 · 设置页十档里四档是空的，一档与另一档完全重复

`general` / `ai` / `git` / `notify` 四档只渲染「这一档还没有可配置的项。」；
`security` 渲染的 `<PermissionPolicy/>` 与 `env` 档里那份逐字相同。
默认档是列表第五项。

**验收**：空档从导航里去掉或写清「将来放什么、现在该去哪配」；
权限策略只放一处；默认档改成第一项。

### Z-7 · 十二处 catch 把「接下来怎么办」丢掉了

用 `err instanceof Error ? err.message : String(err)` 而不是 `describeError`，
于是 `CoreApiError.hint` 被丢掉 —— 而 `describeError.ts` 的注释说的正是
它存在的理由。同类：`EnvHealth.tsx:180` 的「复制」用可选链吞掉了
剪贴板不可用的情形，成功也没有任何反馈；模型页详情区全只读，
登记后改不了任何字段（而 `model.update` 契约是全字段可改）。

---

## 〇之四、第 4 轮探索：出错时会怎样

按「出事之后有多难查」排。前两条有实测输出为证。

### W-1 · 进程里有两个 Supervisor，同一个节点会真的执行两遍 ← 最难查

`Supervisor::spawn` 用 `self.cancels` 挡「同一个运行只允许一个线程」，
但那张表是**实例级**的，而一个 App 进程里有两个实例：
桌面壳 `AppState.supervisor` 一个，进程内 MCP 服务 `serve()` 里又 `new` 一个。
两张表互不知道对方，`resume` 的 `is_active()` 对另一侧起的线程恒返回 false。

实测（两个 Supervisor 指同一个库、同时 resume 同一条 failed 运行）：
副作用文件 **2 行**，`node.started` **2 条**，最终状态 `succeeded`。

`run.resume` 的 scope 是 `workflow:run`，`trusted_workflow` 档下免确认 ——
主管 AI 手上就有这把工具。用户点「从失败节点重试」的同时让 AI 也恢复一下
就撞上了。脚本、`git push`、AI 写文件全做两遍，没有任何错误。

**验收**：两个实例指同一个 db 并发 resume，断言副作用只发生一次
（或第二次拿到 AlreadyRunning）。修法是把「谁在推进这个 Run」落到库里
（一列 owner/lease），而不是进程内存的 HashMap。

### W-3 · 一键初始化不看有没有运行在跑

`workspace_reset` 直接 `reset_workspace()`，没有「先看看有没有 active run」，
也没有停掉任何执行线程（`Supervisor` 根本没传进来）。

实测：重置报成功、运行记录消失，而那个 shell 脚本跑完了、文件写进去了。
它写事件时撞的 `FOREIGN KEY constraint failed` 只 `eprintln!` 到 stderr，
打包版里没人看得到。

同一个函数还有一处名不副实：`清空重建()` 的注释写「整件事在一个事务里，
中途失败就回滚」，而事务只包 DROP 那一段 —— `COMMIT` 之后才跑 migrate 与 seed。

**验收**：有 active run 时拒绝并说清是哪几条；注释与实现二选一改到一致。

### W-4 · 失败页三个主操作零 in-flight 防重

「从失败节点重试」「回到最近审批点」「用相同参数重跑」都是裸 button，
没有 disabled、没有 loading、store 里也没有 ref 锁。后端 `run.start` 不幂等 ——
连点两次就是两条运行、两个执行线程、同一个 workdir。
第二条的 worktree 节点会撞 `BranchExists`，报「分支已存在。换一个分支名」——
一句完全指错方向的提示。

发布按钮同类：`disabled` 只绑了 `dirty`，连点会得到两个 `config_hash`
完全相同的版本。

仓库里已经有做对的写法（`OverviewPage.tsx:85` 的 `creatingRef` 配
「连点五次只建一条」测试）——**那是全仓唯一一条连点测试**，没有推广。

**验收**：每条配一个「连点五次」的用例；发布还需要后端幂等
（同一个 rev 重复发布返回已有版本）。

### W-5 · `hint` 这条管道建好了但零灌注

`ApiError::with_hint()` **全仓零调用**（含测试）。生产代码 `hint: None` 21 处、
`Some` 5 处而那 5 处全在两个 `From` impl 里 —— `ApiError::validation()`
写死 `hint: None`，用它的 22 处全部没有。而管道两头都通着：
MCP 侧拼「接下来：」，前端 `describeError` 渲染成 `${message}（${hint}）`。

最刺眼的一条：`NotPendingApproval` 的 `{expected:?}` 作用在 `Option<String>` 上，
用户界面上看到字面的 `Some("n_review")`。而 `WrongState`（连点两次审批最常撞的）
被 `_ => None` 吞掉 —— 批准成功之后紧跟一条「运行 r_x 当前是 running，
不能提交审批决定」，没有一个字告诉用户「你的批准已经生效了」。

底层错误原样外泄同档：`UNIQUE constraint failed: 表.列` 直接给用户；
检查点 JSON 解析失败报成「图无法解析」，用户会去检查画布，而画布毫无问题。

**验收**：照 `patch.rs` 的 `PatchError::hint()` 给各错误类型配 `hint()`；
门禁：所有 `VALIDATION` 码必须带非空 hint，配一条故意不带、断言变红的元测试。

---

## 一、ACP 与 Agent 架构

### A-1 · 主管 AI 每问一句就新建一个 ACP 会话

**现状**：`crates/core-api/src/lib.rs:2013` 每次 `supervisor_ask` 都
`AcpClient::connect` + `new_session_with_mcp`，答完就断。

**为什么是问题**：

- **agent 不记得上一句**。用户问「那第二个方案呢」，而 agent 手上是一张白纸——
  它只能靠我们把历史重新拼进 prompt，那不是对话，是每次重新做一次自我介绍
- 每问一句起一个 adapter 进程（实测握手到建会话几百毫秒起步）
- `supervisor_ask` 的 `session_id` 参数是**我们数据库里的会话 id**，
  与 ACP 的 session id 是两回事，眼下没有任何地方把两者对上

**验收**：同一条主管会话里连问两句，第二句的 ACP session id 与第一句相同；
agent 能引用第一句的内容；杀掉 App 后再问，会话能重建且用户看得出它重建过。

### A-2 · 提示词是一次性拼出来的，没有分层

**现状**：`executor.rs:760-830` 把角色、记忆、材料、指令拼成一个字符串发过去；
`supervisor_prompt` 同理，每次把记忆和上下文重新拼一遍。

**为什么是问题**：ACP 有 session 级的上下文，角色与记忆属于「这一整段对话都成立」的东西，
每轮重发既浪费 token 又让模型分不清哪些是新信息。参考 Claude Code / Codex 的做法：
系统级的身份与约束放会话开头，每轮只发这一轮的材料与指令。

**验收**：角色/记忆只在建会话时发一次；第二轮 prompt 里不再重复它们；
有测试断言第二轮的 prompt 不含角色文本。

### A-3 · Turn 上限、输出契约、模型策略都不生效

见 `node-config-drift.test.ts` 白名单里的 `ai.*.turnLimit` /
`outputContract` / `modelPolicy` 共 12 条。**Turn 上限那条是安全项**——
agent 想跑多少轮就跑多少轮，一个死循环的会话没有任何东西拦得住。

**验收**：超过 turnLimit 时中断并写事件；输出不合 outputContract 时明确失败
（而不是把坏形状传给下游）。

---

## 二、节点与配置字段

### B-1 · 42 个配置字段填了不生效

白名单在 `packages/contracts/tests/node-config-drift.test.ts`，那是这笔账的精确版本。
守卫已经补上（漂移必须登记），**但字段本身还没接**。

优先级按「用户填了最可能出事」排：

1. `script.shell.secretEnv` —— **这是安全承诺**，契约写着用 `keychain://` 引用，
   实现为零。用户按承诺配了密钥引用，脚本里拿不到，只能退回明文
2. `ai.*.turnLimit` —— 见 A-3
3. `approval.bodyMarkdown` —— 审批人唯一的上下文，现在审批卡上只有标题
4. `git.worktree.cleanupPolicy` —— 唯一一条在用户磁盘上持续累积的（DEBT B-4）
5. 其余按 DEBT B-5 的表

**验收**：接一个从白名单删一行（第二条守卫会拦住「接上了却还挂着」）；
暂时不接的要在配置弹层上说清「引擎目前不读它」，照 `NodeConfigDialog.tsx:269`。

### B-2 · 6 种节点类型没实现

`subworkflow` / `branch` / `transform` / `script.python` / `env` / `mcp.tool`。
executor 的兜底分支会明确报「尚未实现」，Dry Run 也先拦一次——**这一档不算假装成功**，
但「保证每个节点运行正常」这件事在它们身上无从谈起。

**验收**：每实现一个，`preflight.rs` 的 `IMPLEMENTED` 加一项，
配一条端到端测试（真的跑，不是 mock 掉执行）。

### B-3 · `notify` 节点是空实现

DEBT B-1。归在 `entry | end` 那一档，什么都不做直接返回成功，Dry Run 也不报，
还有一条绿着的测试掩护。**示例工作流里就有一个**。

---

## 三、测试覆盖

### C-1 · 用测试仓库跑真实工作流

测试仓库：`HuLuca1998/aiwf-e2e-fixture`。

要覆盖的形态（每种一条端到端）：

- **外部读取**：`gh issue view` → 解析 → 传给下游（用户撞过的那条链路）
- **AI 调用**：真实 ACP（用 codex，不用 claude——见 CLAUDE.md 的理由）
- **worktree**：建分支 → 改文件 → 提交 → 清理
- **审批**：权限档挂起 → 批准 → **确认那个节点真的执行了**（刚修过的坑）
- **失败路径**：脚本非零退出、AI 超时、审批拒绝，各自停在该停的地方

**验收**：每条都断言**副作用真的发生了**（文件真的改了、分支真的建了），
不是只看事件流里有没有 succeeded。

### C-2 · 已实现节点的字段级测试

10 种已实现节点 × 各自的配置字段，逐个断言「填了会生效」。
接一个字段（B-1）就补一条。

---

## 四、界面与可观测

### D-1 · 画布上看不出工作流向与未闭合环节

**现状**：可达性检查只在 Dry Run 里（`preflight.rs` 的 `check_reachable`），
设计的时候看不见——用户拖完线要点「运行」才知道有个节点没连上。

**要什么**：

- 从入口到出口的**流向**在画布上可见（连线方向、执行顺序）
- **未闭合**的环节标出来：孤立节点、没有出边的非终止节点、连到不存在端口的边
- 环：图是 DAG，成环时要当场指出是哪几个节点

**验收**：拖出一个孤立节点，画布上当场标红并说清原因，不必点运行。
引擎那份可达性逻辑要复用，不能前后端各写一套判断（那必然漂移）。

### D-2 · 白名单字段要在配置弹层显示「不生效」

见 B-1 验收。

---

## 五、已经做完的（这一轮）

留在这里是为了下一轮复核时能看出「哪些是刚动过的」，
**下一轮开始时清空这一节**。

- 种子数据不合契约（时间非 ISO、prompt vars 形状、memory.source 枚举外）+ 修正批次 + 契约守卫
- 打包版 PATH 只有 launchd 那四条 → `aiwf_engine::tooling` 统一，所有子进程走同一份
- 弹窗点遮罩丢数据（LaunchDialog / SupervisorDrawer）
- `format: 'repo'` 仓库+分支联动下拉（走本机 gh，含组织仓库）
- 权限档审批通过后节点不执行（`runner.rs`）
- `ai.*.target` 引擎从不读（`executor.rs`）
- 配置字段接缝守卫 + 42 条欠账登记
- 主管 AI 一条对话复用一条 ACP 会话（A-1）
- 新建 Agent 角色的权限被 Zod 悄悄清空（X-1）+ 契约替身的通用「被吃掉的键」守卫
- 事件摘要落库前过脱敏（X-5）—— 之前界面写着「已脱敏」而链路上一次都没调过
- 权限档说的话要算数（X-7）：ai.execute 进挂起名单与能力校验、
  名单里两个契约里不存在的类型删掉、未知档位按最严、设置页文案改成与实际一致
- 脱敏器接上「已知明文」那条路（Y-1）：MCP 令牌登记进去 ——
  它是系统里真实存在的明文密钥，而且什么形态规则都认不出
- AI 节点看 stopReason（X-2）：拒答不再报成功，截断要说出来
- **第三条接缝守卫**（事件类型）：引擎发射的必须在契约里声明过 ——
  写这个修复时我自己发了个 `system.warning`，编译过、测试绿、照样写进库
- 端到端压了一轮「人工介入」方向
- 节点库能点也能用键盘了（Z-1）—— 之前它挂着 role="button" 却没有 onClick，
  键盘用户根本无法往画布添加任何节点
- 侧栏那行「环境正常」由真实健康结果决定（Z-2），
  「重新检查」也会更新时间戳 —— 之前它只看时间戳存不存在然后硬编码 ok: true
- 跳转 URL 与读取对上了（Z-4）：首页「重试」改用 ?run=，RunsPage 读 tab 参数
- 超长摘要不再压垮运行：`emit_full` 兜底截断 —— 之前一行五千字的 stderr
  会让 `node.failed` 一条都写不进去，节点永远停在「运行中」
- 主管 AI 单开一条数据库连接（W-2）—— 之前它握着主锁做完整轮 ACP 对话，
  桌面壳另外 58 条命令全堵在后面，用户看到的是「应用卡住了」
