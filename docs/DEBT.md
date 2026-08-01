# 技术债台账

**盘点日期**：2026-07-29 · **基线**：`b7c4f4a`
**门禁状态**：`pnpm verify` 绿

盘点方式：全仓扫描 + 逐条实证，不采信文档与注释的自述。
每条都给了可复现的验证命令 —— **不要凭这份文档下结论，跑一遍那条命令**。

---

## 分类的依据

按**可回收性**分，不按严重程度分。三类要用完全不同的方式处理：

| 类别     | 定义                                       | 为什么这么分                                               |
| -------- | ------------------------------------------ | ---------------------------------------------------------- |
| **欠账** | 知道没做，写在文档或注释里，有理由         | 记在账本上。按计划还就行，不需要额外机制                   |
| **烂账** | 做了，但做得不干净，会持续产生利息         | 不还会越滚越大，但至少看得见                               |
| **坏账** | **看起来做了，实际没做，而且有东西在掩护** | 最危险 —— 它不在任何人的账本上。发现它的唯一办法是逐条实证 |

坏账的判据是三条同时成立：

1. 有一处**明示或暗示它已经工作**（文档声称已交付 / 界面文案承诺 / 契约字段可填 / 节点可拖入）
2. 实现为零或不生效
3. **有东西在掩护它** —— 一条绿着的测试、一个不检查它的清单、一份写着「已交付」的文档

第 3 条是关键。单纯的「没做」是欠账；「没做但有东西让人以为做了」才是坏账。

---

## 一、坏账

### B-2 · 52 个事件类型，15 个从未被发射

**这是本次盘点最大的一条。**

架构原则第 2 条是：

> **RunEvent 是唯一事实来源**。不存在第二份运行状态。`event-store.ts` 把同一条流投影成
> 对话视图、事件视图、产物视图、节点进度、运行状态、**可解释性证据**
> （用了哪个模型 / 提示词 / 注入了哪些记忆 / 谁批准了什么）。

实际发射覆盖率 **37 / 52 ≈ 71%**（2026-08-01 实跑下方命令；上一轮是 31/51）。

**验证**：

```bash
node -e "
const {execSync}=require('child_process');
const m=require('./packages/contracts/generated/contracts.meta.json');
const 零=[];
for(const e of m.eventTypes){
  const n=execSync(\`rg -c '\"\${e}\"' crates/engine/src crates/core-api/src crates/store/src 2>/dev/null | awk -F: '{s+=\\\$2} END{print s+0}'\`,{encoding:'utf8'}).trim();
  if(n==='0') 零.push(e);
}
console.log(零.length+' / '+m.eventTypes.length);console.log(零.join('\n'));
"
```

（已确认没有变量拼接发射的情况：`rg 'format!\("(node|run|system)\.' crates/` 零命中。）

零发射的 15 个（精确清单以 `event_emission_test.rs` 的白名单为准），按危害排：

| 事件                                            | 谁在承诺它                                                                                         | 后果                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `node.cancelled`                                | **界面明写**：`NodeConfigDialog.tsx:331`「收到取消信号后先停止子进程，再写入 node.cancelled 事件」 | 界面上的一句话，实现为零           |
| `system.prompt_resolved`                        | 「提示词与模型在运行记录中可追溯到具体版本」                                                       | 见 B-3，提示词那一半完全没有       |
| `system.audit`                                  | 契约里 40+ 个方法标着 `audited: true`                                                              | 审计标记没有任何落点               |
| `system.permission_granted` / `_denied`         | 权限档确实在拦（实证过），但**拦了不留痕**                                                         | 事后无法回答「这次运行被拦了什么」 |
| `system.redaction_applied`                      | 脱敏确实在做（三道），但不留痕                                                                     | 无法证明脱敏发生过                 |
| `system.checkpoint_saved`                       | 「每个节点完成后落一次带 Scope 快照的检查点」                                                      | 检查点真的落了，但事件流里看不到   |
| `artifact.created` / `artifact.truncated`       | 产物确实在落盘、确实会截断                                                                         | 「产物视图」这个投影没有源事件     |
| `system.memory_written`                         | 记忆提议写入已实现                                                                                 | 写入不留痕                         |
| `run.paused` / `run.resumed`                    | 状态机里有这些状态（`run.interrupted` 已有发射点：孤儿扫描）                                       | 暂停/恢复机制整体未实现            |
| `node.queued` / `node.retried` / `node.skipped` | 调度器真的会排队、真的会跳过                                                                       | 节点进度投影缺档                   |
| `approval.reminded` / `approval.expired`        | 对应 `approval` 节点的 `reminderAfterMs` / `waitStrategy` 字段（见 B-5）                           | 提醒与超时都不存在                 |
| `conversation.agent_delta`                      | 流式增量                                                                                           | 对话只有整条消息，无流式           |
| `system.session_rebuilt`                        | 风险表里写着「不可恢复时明确告知『已用结构化状态重建』」（`env_snapshot` 已在发）                  | 那句「明确告知」没有载体           |

**掩护它的是什么**：契约测试验的是「事件 Schema 定义正确」和「流不变量成立」，
**没有任何测试验「每个声明的事件类型都有发射点」**。所以定义了不发，一路绿灯。

> **守卫已补**（2026-08-01）：`crates/engine/tests/event_emission_test.rs`
> 双向白名单 —— 零发射的必须写明理由，接上没删也红。
> 那份白名单现在是这笔账的精确版本（19 条）。剩下的工作是逐个补发射点，
> 按下表顺序。`run.interrupted`（孤儿扫描）与 `system.worktree_cleaned` 已有发射点。

**加强证据 —— 前端已经把消费侧写好了，而且测得很认真**：

```bash
# 投影处理 32 个事件类型，其中 10 个引擎从不发
rg -o "'(run|node|approval|conversation|tool|artifact|system|reasoning)\.[a-z_]+'" \
   packages/client-core/src/event-store.ts --no-filename | sort -u
```

`node.queued`、`node.retried`、`node.skipped`、`node.cancelled`、`approval.expired`、
`run.paused`、`run.resumed`、`run.interrupted`、`artifact.created`、
`system.prompt_resolved` —— 这 10 个在
`event-store.ts` 里都有真正的投影分支，而引擎一个都不发。
（`system.model_downgraded` 已还清：解析期与 adapter 拒绝两种降级都发。）

而 `packages/client-core/tests/event-store.test.ts:68` 是这么测的：

```ts
ev({ type: 'node.queued', seq: 5, nodeId: 'n1', attempt: 1 }),
```

**测试自己构造事件喂给投影**。投影处理得完全正确，测试绿 ——
但生产中这个事件永远不会出现。契约、投影、投影测试三处各自都「完成」了，
**中间那一段断着，而三处的绿灯合起来看像一条通的链路**。

这是这份台账里最典型的一条：不是谁偷懒，是**每一侧都做完了自己那份**，
而没有任何测试站在接缝上。

**还清的判据**：~~守卫测试~~（已补，见上）。剩下：逐个补发射点 ——
按上表的顺序，界面明确承诺的 `node.cancelled` 先补。

---

### B-5 · 42 个配置字段静默忽略：填了不报错，也不生效

用户在配置弹层里填了，保存成功，校验通过，运行时被无视。
**比「未实现」更糟 —— 未实现至少会报错。**

> **守卫已补**（2026-07-30）：`packages/contracts/tests/node-config-drift.test.ts`
> 逐个字段比对契约与引擎源码，漂移必须进白名单并写明理由。
> 那份白名单现在是这笔账的**精确版本**，下面这张表是它的摘要。
> 数字从 22 改成 42 是因为原来是估的 —— 守卫是算出来的。
>
> 白名单分三档：`界面`（消费者本来就不是引擎，2 条）、
> `未实现`（整个节点类型都没有，21 条）、`欠账`（节点跑得起来而字段不生效，42 条）。
> **接上一个就从白名单里删一行**，第二条守卫会拦住「已经接上却还挂在白名单里」。
>
> 触发这次补守卫的是 `ai.analyze.target`：契约里的必填字段「分析对象」，
> executor 从不读，于是内置模板里那个「读 issue → 分析」永远拿不到 issue 正文，
> agent 只能回一句「请提供要分析的具体问题和现有证据」。那条已经接上了。

| 节点           | 静默忽略的字段                                                        | 引擎实际行为                                                                                   |
| -------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `script.shell` | `env`、`secretEnv`、`successExitCodes`、`outputLimitBytes`、`workdir` | 环境变量只给 `scope.env_vars()`；退出码硬编码 `!=0` 判失败；输出上限硬编码；工作目录用运行级的 |
| `approval`     | `bodyMarkdown`、`interaction`、`waitStrategy`、`reminderAfterMs`      | 全仓零命中（连界面都不读）                                                                     |
| `ai.*`         | `turnLimit`、`outputContract`                                         | 不强制/不校验（`promptId` 已接上，B-3 还清）                                                   |
| `git.worktree` | `parentDir`、`fetch`、`conflictPolicy`                                | 位置固定/不 fetch/冲突策略不生效（`cleanupPolicy` 已生效）                                     |
| `entry`        | `trigger`、`injectedFields`                                           | 只有 `inputSchema` 与 `workdirSource` 生效                                                     |
| `end`          | `artifacts`                                                           | 零命中                                                                                         |

**验证**：

```bash
for f in env secretEnv successExitCodes outputLimitBytes bodyMarkdown waitStrategy reminderAfterMs; do
  echo -n "$f: "; rg -c "\"$f\"" crates/engine/src | awk -F: '{s+=$2} END{print s+0}'
done
```

两条要单独说：

**`secretEnv` 是安全承诺**。契约原文：「凭据环境变量\n用 `keychain://` 引用，**明文永不入库**」，
风格纪律也写着「Secret 只进 Keychain；仓库、事件、日志、导出物里一律用 `keychain://` 引用」。
实现为零 —— 用户按承诺的方式配了密钥引用，脚本里拿不到那个环境变量。
后果是用户会退回去用明文 `env`（那个也不生效），或者把密钥写进脚本正文。

**`bodyMarkdown` 是审批人唯一的上下文**。用户在审批节点里写「请确认这个 PR 是否符合规范，
重点看 X 和 Y」，审批时**看不到**。审批卡上只有 `title`。

**掩护它的是什么**：Schema 驱动的配置表单太好用了 —— 加个字段就能渲染、能填、能存、能校验，
**整条链路唯一不参与的就是引擎**。而「新增节点类型不改 UI 代码」这条设计承诺让所有人
把注意力放在渲染侧，没有人守「字段有没有消费方」。

**对照组**：`NodeConfigDialog.tsx:331` 对重试策略是这么写的 ——

> 重试策略还不能改：引擎目前不读它，改了也不会生效。

**这就是正确做法，而且已经在这个仓库里了。** 上面 22 个字段该按同样的方式处理：
要么实现，要么在表单上说清楚它现在不生效。

**还清的判据**：~~加一条守卫测试，对每个已实现节点类型的 configSchema 顶层字段，
断言它在引擎里有消费点或在「已知不生效」白名单里~~（已补，见本节开头）；
剩下两半 —— **白名单里的字段要在配置弹层上显示「引擎目前不读它」**
（照 `NodeConfigDialog.tsx:331` 那个写法），以及逐个把它们真的接上。

---

### B-8 · 主管 AI 的 ACP 用法：10 条硬性错误

**位置**：`packages/client-core/src/ipc-mapping.ts:189` 起，链路见下
**明细**：[`docs/acp/07-violations.md`](acp/07-violations.md)（这里只记索引与成因）

用户报的三个症状 ——「每条消息都是一个 session」「页面卡死没有流式」
「提示词每轮都重发」—— 是同一条链路上三处独立的断点，逐条实证如下：

| 编号 | 事项                                                            | 位置                       |
| ---- | --------------------------------------------------------------- | -------------------------- |
| H-1  | **会话 id 在映射层被丢**，每问一句新建一条 ACP 会话             | `ipc-mapping.ts:189`       |
| H-2  | **流式断在 core-api**，chunk 攒成整段；两端无推送通道           | `core-api/src/lib.rs:2112` |
| H-3  | **系统提示词每轮重发**（含整张草稿图）                          | `core-api/src/lib.rs:2063` |
| H-4  | **翻开历史会话继续问，agent 一无所知**（从不用 `session/load`） | `SupervisorDrawer.tsx:299` |
| H-5  | **`stopReason` 被丢弃**，截断的答案当成功交出去                 | `core-api/src/lib.rs:2099` |
| H-6  | **权限裁决硬编码全拒**，与界面上的权限档无关且不可见            | `engine/src/acp.rs:423`    |
| H-7  | **「取消」不取消远端**，`session/cancel` 零调用点               | `engine/src/acp.rs:388`    |
| H-8  | **模型下拉是装饰**，`modelRef` 无消费点                         | `SupervisorDrawer.tsx:508` |
| H-9  | **池键用问题原文**，问同一句话会撞进同一条会话                  | `core-api/src/lib.rs:2091` |
| H-10 | Web 形态下 `context` 与 `contextJson` 对不上 ⚠️ 待实证          | `dispatch.rs:41`           |

**H-6 值得单独说 —— 它是「够不着的防线」，实测出来的**：

`acp.rs:423` 收到权限请求一律挑 reject，看起来是道很严的门。
对 `codex-acp 1.1.7` 与 `claude-agent-acp 0.63.0` 各跑一遍同一件事
（在 cwd 里建个文件），结果相反：

| runtime · 档位                       | 请求权限次数 | 文件建了吗  |
| ------------------------------------ | ------------ | ----------- |
| codex · `agent`（**默认**）          | **0**        | ✅ **建了** |
| codex · `read-only`（`set_mode` 后） | 2            | ❌ 没建     |
| claude · `default`（默认）           | 1            | ❌ 没建     |

**那段拒绝代码在 codex 上一次都没被调用过**，而 codex 是首选 runtime，
cwd 传的是应用数据目录。修法很短：`session/new` 之后调一次
`session/set_mode`。

这也解释了为什么它一直没被发现：**只用 claude 测会看到一切正常。**

**三层掩护**：

| 掩护                                       | 说明                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `supervisor-history.test.tsx:150` 绿着     | 名字叫「第二问带上后端给的 sessionId」。它 `vi.mock` 掉整个 `workspace.js`，断言的是**组件传给 `coreClient` 的参数**，根本不经过 `toIpcInput` |
| `ipc-mapping.test.ts` 覆盖了 run.\* 与分页 | **没有一条测 supervisor.ask**                                                                                                                 |
| `acp_pool_test.rs` 11 条用真 mock 进程验   | 池本身是对的 —— **钥匙在半路掉了，测池测不出来**                                                                                              |

**验证**：

```bash
grep -A 8 "method === 'supervisor.ask'" packages/client-core/src/ipc-mapping.ts | grep -c sessionId
# 0 —— 白名单里没有它

grep -rn "\.cancel(" --include="*.rs" crates/ | grep -v "fn cancel" | grep -v "supervisor\|runner\|run_cancel"
# 无输出 —— session/cancel 零调用点

grep -rn "modelRef" crates/core-api/src/dispatch.rs apps/desktop/src-tauri/src/lib.rs | grep -i supervisor
# 无输出 —— 模型下拉无消费点
```

**成因与 B-5 / B-6 同源**：`ipc-mapping.ts` 那层是**白名单式**的，
只挑出列出来的字段、其余静默丢弃。这个形态已经吃掉过三次字段 ——
`ver`、`run.list` 的分页参数、现在是 `sessionId`，
而**症状都是「数据莫名为空」而不是报错**。文件里第 183 行的注释
自己就写着这件事，然后在下面第 189 行又犯了一次。

**还清的判据**：H-1 先修（H-3 依赖它 —— 每轮都是新会话时，
不发提示词等于什么都没说）。同时补两道守卫：

1. 一条**不 mock transport** 的端到端用例，断言第二问落在同一个池键上
   （用 `pid_for_test`，session id 靠不住）；
2. `ipc-mapping` 的接缝守卫：契约里声明了的入参字段，映射层必须发得出去 ——
   这条守卫能一次性挡住上面那三次同形态的丢字段。

规范与逐条明细在 [`docs/acp/`](acp/)：
[06-repo-rules](acp/06-repo-rules.md) 是 22 条准则，
[07-violations](acp/07-violations.md) 是违反清单（含 13 条可优化项），
[08-runtime-abstraction](acp/08-runtime-abstraction.md) 是两端差异与抽象层设计。

**这一条的证据不是读代码读出来的**：对两个 runtime 各跑了一遍探针，
12 份完整往返记录在 [`docs/acp/transcripts/`](acp/transcripts/README.md)。
其中三条修法**已在真实 runtime 上验证可行**——同一条会话里系统提示词
只发一次就够、`session/load` 能真恢复上下文、`session/cancel` 真停得住。

---

## 二、烂账

### L-1 · Supervisor 两处吞错

**位置**：`crates/engine/src/supervisor.rs:195` 与 `:210`

```rust
let _ = store.append_event(&aiwf_store::NewRunEvent { ... });   // 写事件失败被吞
let _ = store.advance_run_status(run_id, "failed", None);        // 状态推进失败被吞
```

（`runner.rs` 里那几处 `let _ = ...?` 带 `?`，错误会传播，不算。）

早前曾报过同一形态（「主管 AI 的三次写库全部『失败也不管』」），已修。
引擎侧这两处是同一类，没被扫到。

后果：数据库暂时不可写（锁竞争 / 磁盘满）时，运行会**表面上正常结束**而事件流缺档 ——
而事件流是唯一事实来源，缺了就无法重建。

**还清的判据**：至少记日志；`advance_run_status` 失败应该让运行进入明确的失败态，
而不是保持原状继续。

### L-2 · MCP 的 50 个工具只有 6 次实际调用测试

```bash
rg -c 'tools/call' crates/mcp/tests/http_test.rs   # 6
```

涉及的只有 `workflow_create` / `workflow_get` / `workflow_list` / `mcp_decide_confirm` 等少数几个。

`catalog_test.rs` 守的是**清单结构**：每个可分派命令都是工具、schema 非空、
命名安全、只读工具标了 `read_only_hint`、权限档决定写操作要不要确认 —— 这些都守得很好。
但它**不守「工具真的能调通并返回正确结果」**。

出口标准（「一个不知道这个系统长什么样的 AI 客户端，能只靠 MCP 把工作流从零搭出来、
跑起来、修好、再跑」）靠的是一次人工端到端跑通，
**那次验证不会因为回归而变红**。

**掩护它的是什么**：`catalog_test` 这个名字和位置让人以为 MCP 工具受测试保护。
它保护的是清单的形状，不是工具的行为。

**还清的判据**：至少给每个 scope 类别挑一个代表性工具做真实调用测试。
不必 50 个全测 —— 但「调用后返回的形状与契约的 output schema 一致」这条应该全覆盖，
那个可以自动生成。

### L-3 · lint 门禁只对 4 条规则有效

`.oxlintrc.json` 的 `rules` 里只有 4 条 `error`（`eqeqeq` / `no-debugger` /
`typescript/consistent-type-imports` / `import/no-cycle`），其余是 `warn`。
`oxlint .` 有 warning 时退出码是 0，所以 `pnpm verify` **不会因为 warning 变红**。

当前全仓 5 条 `no-console` warning 长期存在（`tests/e2e/acp-real.mjs`）。

> 盘点时我一度以为 `react-hooks/exhaustive-deps` 没生效（曾被报过）。
> **实测证伪了**：写一个缺依赖的探针文件跑 oxlint，它报了
> `react-hooks(exhaustive-deps)`。规则是生效的。
> 记在这里是为了下次别再重复这个误判。

**还清的判据**：要么把关心的规则提到 `error`，要么给 `pnpm lint` 加 `--deny-warnings`。
不改也行 —— 但那样就该知道 lint 门禁目前只守那 4 条。

### L-4 · 契约 63 个方法，Rust 实现 61 个

`run.retryNode` 与 `env.install` 在 `COMMANDS` 里没有。两条都有明确理由，
`apps/web/tests/transport.test.ts:26` 还有一条测试守着
「尚未接通的方法返回 null，由调用方报明确的未实现错误」—— **这是处理得对的**，
所以算烂账不算坏账（有账本、有守卫、错误信息明确）。

- `env.install`：明确不实现，理由充分（应用自己不下载任何东西）
- `run.retryNode`（重试单个节点）：功能上有替代 —— `run.resume` 承担了
  「从失败节点重试」，`RunsPage.tsx:309` 的注释说清了这一点

**还清的判据**：`env.install` 建议从契约里删掉或标注 `deprecated` ——
留一个永不实现的方法在契约里，每个读契约的人都要重新问一次「这个怎么没实现」。

---

### L-5 · 防连点只在组件活着的时候有效

界面这一层的防重复是 `useAsyncAction`：进行中把按钮变灰、丢弃后续点击。
它挡得住「连点五次」，挡不住这条路径 ——

1. 在运行 A 上点「确认取消运行」
2. 请求还没回来时切到别的页（运行页整个卸载）
3. 切回来：新的 hook 实例 `inFlight = false`，按钮是可点的
4. 再点一次 → 第二条 `run.cancel`

已经发出的请求不会因为组件卸载而取消，后端也不幂等，所以这是两条真实的命令。
同样的路径对 `run.start`（两条运行、两个执行线程、同一个 workdir）、
`approval.decide`（两条决定）都成立。

**为什么现在不修**：界面侧的解法（把 pending 提到一个不随组件卸载的
全局注册表，按 `操作:runId:nodeId` 键控）能挡住这一条路径，但挡不住
「两个窗口」「MCP 与界面同时发」——那些同样是真实路径。真正的解法在后端：
写操作收一个幂等键，重复的直接返回上一次的结果。

**还清的判据**（光让接口收一个 key 不算数 —— 两个窗口各自生成不同的 key，
后端照样执行两次）：

1. `run.start` / `run.cancel` / `approval.decide` / `run.diagnostics`
   都收 `idempotencyKey`
2. **定义同一个「逻辑意图」如何复用同一个 key**：比如「取消运行 R」的 key
   由 `(操作, runId, 用户所见的运行状态版本)` 派生，而不是每次调用现生成一个
3. 定义 key 相同但 payload 不同时的行为（拒绝，而不是静默返回上一次的结果）
4. 每个操作各配一条并发测试，不只是 `run.start`

---

### L-6 · `sync_models` 硬编码 effort，模型档位在同步目录上分不出档

**位置**：`crates/store/src/lib.rs`（`sync_models`）

节点的 `modelPolicy` 档位（fast / balanced / quality）按登记条目的
`effort` 排序挑选（`executor.rs` 的 `pick_tier`）。而模型清单的唯一
来源 `model.sync` 给每条新条目**硬编码 `effort='medium'`** —— 同步出来的
目录里所有条目同档，三个档位全部落在按名字排序的第一条：
用户选「快速」和「高质量」，拿到的是同一个模型。

根因是维度错位：契约把 effort 当条目属性（「同一模型的不同推理档位
登记为不同条目」），而 runtime 侧模型与推理档是两个独立配置项 ——
sync 拿不到「每模型的 effort」，只能编一个。

**还清的判据**：`sync_models` 按 runtime 报的 effort 选项展开条目
（或换掉「effort 属于条目」的建模），配一条「用 sync 造出的目录跑
`pick_tier`，三个档位选出三个不同条目」的测试。手工登记的目录不受影响。

## 三、欠账

这些都记在账本上、有理由、不需要额外机制。列在这里是为了台账完整，
详细排期见 [ROADMAP.md](ROADMAP.md)。

| #    | 欠账                                                                                                                                                                                                                                                                                                      | 状态                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| O-1  | **6 种节点类型未实现**：`branch` / `transform` / `subworkflow` / `script.python` / `env` / `mcp.tool`                                                                                                                                                                                                     | Dry Run 会诚实报错                                                          |
| O-2  | **Web 形态实际为零**：只有 `MemoryTransport` 与 `crates/devserver`（179 行、无鉴权）                                                                                                                                                                                                                      | 开工前先回答「给谁用」                                                      |
| O-3  | **WKWebView 零测试**：`tests/e2e/` 全是 Playwright；「拖动卡」的定论依赖它                                                                                                                                                                                                                                | 唯一一条真实用户反馈悬着                                                    |
| O-4  | 模型策略映射                                                                                                                                                                                                                                                                                              | 要等 `provider.api` 运行时                                                  |
| O-6  | **产物列表不分页**：`run.artifacts` 的契约里没有 `limit`/`offset`                                                                                                                                                                                                                                         | 要先改契约，不是纯界面改动                                                  |
| O-7  | **AI 提议只能整体接受**：逐条挑选要先做「操作依赖」分析（删掉 addNode 就不能保留引用它的 connect）                                                                                                                                                                                                        | 属于新能力，不是修复                                                        |
| O-8  | **提议的节点在画布上没有 ghost 呈现**：`NodeTone` 的 `ghost` 仍是死代码                                                                                                                                                                                                                                   | 要让画布能渲染「应用后的预览图」，改动大                                    |
| O-9  | **没有离线 / 连接断开的全局提示**                                                                                                                                                                                                                                                                         | 只对 Web 形态有意义，而 Web 形态本身是 O-2                                  |
| O-10 | **主管 AI 历史会话固定拿 50 条**：无搜索、无翻页，`supervisor.sessions` 也不传 limit                                                                                                                                                                                                                      | 与另外五个列表页同一套分页要一起做                                          |
| O-11 | **设置十档没有搜索**，其中四档落到「这一档还没有可配置的项」                                                                                                                                                                                                                                              | 空档要先有内容，搜索才有意义                                                |
| O-19 | **桌面 IPC 命令的返回类型没有跨侧守卫**：`parity_test` 只查「命令名都注册了」,不查签名。memory_update 改出参那次,桌面壳的 `-> IpcResult<()>` 没跟上,只有 `cargo build` 才发现 —— 而那是 verify 最后一步                                                                                                   | 加一条守卫:桌面命令与 core-api 同名函数的返回类型一致                       |
| O-16 | **Dry Run 不校验提示词变量能否绑上**：节点选了一个含 `${input.target}` 的库提示词,而入口 inputSchema 没有 `target`,Dry Run 报「0 项缺失」,一跑就 `未定义的引用 ${input.target}`。与幽灵角色同类(`check_agent_profiles` 已解决那半),缺的是把 prompt 内容穿到 preflight 再解析 `${…}` 比对入口字段+上游节点 | 与 `check_agent_profiles` 同构,要给 `dry_run_with_profiles` 加 prompts 参数 |
| O-18 | **内置模型默认全停用,新用户无引导启用**：模型页两条都 disabled,内置角色因此显示「已停用」,运行报 model_downgraded。诚实但没出路                                                                                                                                                                           | 要么默认启一条,要么在模型页/降级事件里给「去启用」入口                      |
| O-14 | **占位种子让校验空转**：节点 seed 是真实字符串（`待选择角色`/`待填写指令`/`# 待填写命令`），必填校验与 Dry Run 天然全绿（幽灵角色那一角已被 `check_agent_profiles` 堵上；其余占位值仍会一路绿到运行时才炸）                                                                                               | 改 seed 为空串会牵动校验噪音与一批模板/一致性测试，要整体设计「未配置」状态 |
| O-15 | **引用类配置字段没有选择器**：`agentProfileId`/`promptId` 是自由文本，要用户手打 `builtin:analyst` 这类内部 id（与 Q-1 同族：Schema 表达力不足以驱动「从列表选」控件）                                                                                                                                    | 表单表达力问题，与 Q-1 一起设计                                             |
| O-13 | **现存孤儿 worktree 没有回收入口**：概览页统计了 `.aiwf-worktrees` 占用，但没有清理动作（清理策略已生效，只有历史遗留的堆着）                                                                                                                                                                             | 界面功能，与 O-6 那批列表操作一起做                                         |
| O-12 | **主管 AI 抽屉的遮罩挡住整个画布**：`inset:0` + `z-index:20`，看 Diff 时对不上画布上是哪几个节点                                                                                                                                                                                                          | 与 O-8（ghost 呈现）是同一件事的两半                                        |

---

### Q-1 · modelPolicy 的「钉住某条模型」在节点表单里没有入口

契约的 `ModelPolicySchema` 是 union：档位（fast / balanced / quality）
**或** `{ modelId }` 钉住某条登记模型。引擎两种都实现了（`resolve_model`），
但 schema 驱动的节点配置表单只把 enum 支渲染成下拉 ——
对象支被 `fieldDescriptors` 静默丢掉，界面上无法钉住具体模型。

MCP / `workflow_patch` 路径可以写对象形态，所以这不是「填了不生效」，
是「界面表达力不足」。**还清的判据**：表单给出「档位或具体模型」的
复合控件（选项来自已启用模型），或明确决定界面只支持档位并把契约
描述收窄。同族的 `agentProfileId`/`promptId` 已用 `.meta({ reference })`

- 下拉解决（2026-08-01），modelPolicy 的对象支可照同一条路走。

## 优先级建议

不按类别排，按「不修的代价」排：

| 顺序 | 条目               | 为什么排这里                                                                            |
| ---- | ------------------ | --------------------------------------------------------------------------------------- |
| 4    | **B-5** 守卫的后半 | 白名单字段要在配置弹层上标「引擎目前不读它」，并逐个接上（三条接缝守卫已齐）            |
| 5    | **B-2** 事件发射   | 违反的是架构第一原则。界面明确承诺的 `node.cancelled` 先补（`model_downgraded` 已还清） |
| 7    | **L-1** 吞错       | 概率低但后果不可逆（事件流缺档 = 无法重建）                                             |
| 8    | O-3 WKWebView      | 用户唯一的真实体感反馈至今没有定论                                                      |
| 9    | O-1 节点类型       | 表达力，不是正确性                                                                      |

第 4 项值得展开：**B-5 和 B-6 是同一个病 —— 声明与实现之间缺一道桥。**
契约能声明节点类型、配置字段、事件类型，三样都有「声明了但没人实现」的情况
（B-6 / B-5 / B-2），而三样都没有守卫。补三条同构的守卫测试，
比逐条修实现更值 —— 那三条测试会把这份台账里的大半条目变成「会自己红的东西」。

---

## 这份台账怎么维护

- 修掉一条就删掉它，不要标「已修」—— `git log` 是历史，这份文件是现状
- 新发现的坏账要写清楚**掩护它的是什么**，那比缺陷本身更值钱
- 每季度重跑一次上面的验证命令。全部命令都是幂等只读的

盘点没覆盖的（下次的起点）：

- `packages/ui` 与 `packages/client-core` 的内部债（这次集中在契约↔引擎的落差）
- 存储层的约束覆盖（20 张表、188 项测试，但没有逐表核对过约束是否真的生效）
- 前端 61 个 `useEffect` 的副作用正确性

---

## 这一轮新发现、已修的

2026-07-31。用户报「本地跑一个工作流完全执行不通」，从
`run_18c740d6394b3c70`（19 条事件，4.3 秒失败）查下来，
内置模板 `github-issue-fix` 有**四处断链**，而它们全都不在任何账本上：

| 断链                                                                     | 症状                                             | 为什么没人发现                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| 脚本写 `$ISSUE` / `$REPO`，引擎注入的是 `AIWF_*`                         | 两个空串，`gh` 报 `invalid issue format: ""`     | 模板只被「能搭出、校验通过、发布 v1」测过，**没有一条测试跑过它的执行路径** |
| `worktree` 的 `repoRoot` 填 `${input.repo.name}`（GitHub 的 owner/repo） | git 去找一个叫 `owner/repo` 的相对目录           | 同上                                                                        |
| `decide` 的 `auto_decided` 端口没有下游                                  | 走那一支就安静地结束，PR 没建                    | 图校验只查「连线的端口存在」，不查「端口有没有下游」                        |
| `approve_diff` 两条互斥入边 + 默认汇聚是「等全部」                       | **它永远执行不到**，从它往后整条尾巴一次都跑不到 | 这条最隐蔽：前两条至少会报错，它是跑完然后什么都没发生                      |

四条都修了，并且各配了会红的守卫：

- `packages/contracts/tests/template-references.test.ts` —— 变量引用能不能解析
  （命名空间、input 字段与子键、上游可达性、端口存在、裸环境变量）
- `packages/contracts/tests/templates.test.ts` 新增两条 —— 端口有没有下游、
  互斥入边有没有声明汇聚策略
- `crates/engine/tests/template_e2e_test.rs` —— 拿**真的 gh、真的 git、
  真的 worktree** 对着 `HuLuca1998/aiwf-e2e-fixture` 的 issue #8 跑

每一条都做过元测试：把原始 bug 改回去，对应的测试变红。

### 顺带修掉的两条既有坑

- `runner_test` 与 `supervisor_test` 会**真的拉起 claude / codex adapter**
  （`Runner` 没有 mock 注入口，而测试里的 runtime 写的是真实值）。
  跑一次全量测试就在 `ps` 里留下一串 adapter 进程，用的是开发者自己的
  登录态与配额 —— CLAUDE.md 那条「测试与试验不要用 claude 的 adapter」
  说的就是这个。改成 `provider.api`（合法但没有 adapter）
- `scripts/scan-secrets.mjs` 的白名单指向 `docs/reference/acp/`，
  而那个目录已经移到 `docs/acp/`
