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

| 编号 | 事项                                                                                                                                                                                                                                                                  | 位置                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| H-1  | **会话 id 在映射层被丢**，每问一句新建一条 ACP 会话                                                                                                                                                                                                                   | `ipc-mapping.ts:189`       |
| H-2  | **流式断在 core-api**，chunk 攒成整段；两端无推送通道                                                                                                                                                                                                                 | `core-api/src/lib.rs:2112` |
| H-3  | **系统提示词每轮重发**（含整张草稿图）                                                                                                                                                                                                                                | `core-api/src/lib.rs:2063` |
| H-4  | **翻开历史会话继续问，agent 一无所知**（从不用 `session/load`）                                                                                                                                                                                                       | `SupervisorDrawer.tsx:299` |
| H-5  | **`stopReason` 被丢弃**，截断的答案当成功交出去                                                                                                                                                                                                                       | `core-api/src/lib.rs:2099` |
| H-6  | **权限裁决硬编码全拒**，与界面上的权限档无关且不可见                                                                                                                                                                                                                  | `engine/src/acp.rs:423`    |
| H-7  | **「取消」不取消远端**，`session/cancel` 零调用点                                                                                                                                                                                                                     | `engine/src/acp.rs:388`    |
| H-8  | **模型下拉是装饰**，`modelRef` 无消费点                                                                                                                                                                                                                               | `SupervisorDrawer.tsx:508` |
| H-9  | **池键用问题原文**，问同一句话会撞进同一条会话                                                                                                                                                                                                                        | `core-api/src/lib.rs:2091` |
| H-10 | Web 形态下 `context` 与 `contextJson` 对不上 ⚠️ 待实证                                                                                                                                                                                                                | `dispatch.rs:41`           |
| H-11 | **`_session/steering` 从没用过**：两端握手都声明了这个能力，实测都返回 `outcome: injected`（`transcripts/{codex,claude}-steering.jsonl`）。界面的「待发消息队列」已交付，但**「立刻插话」还没有** —— 它要能在 prompt 阻塞时旁路发到同一个 stdin，而现在整轮持有槽位锁 | `engine/src/acp.rs:1110`   |

**H-7 与 H-11 是同一个架构问题的两半**：`SessionPool::prompt` 整轮持有槽位锁
（`acp.rs:1110`），于是任何「打断当前轮」的动作 —— 无论是 `session/cancel`
还是 `_session/steering` —— 都拿不到 client。要修得先把 stdin 的写入端
从 `AcpClient` 里分出来（`Arc<Mutex<ChildStdin>>`），让打断类请求旁路发送。
在那之前「取消」只是前端改个状态，agent 还在跑、还在烧配额。

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
| O-1  | **5 种节点类型未实现**：`branch` / `transform` / `script.python` / `env` / `mcp.tool`（`subworkflow` 的 sync 调用已实现，parallel 与 onFailure:retry 明确报「尚未实现」）                                                                                                                                 | Dry Run 会诚实报错                                                          |
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
| O-15 | **引用类配置字段没有选择器**：`agentProfileId`/`promptId` 是自由文本，要用户手打 `builtin:analyst` 这类内部 id（与 Q-1 同族：Schema 表达力不足以驱动「从列表选」控件）                                                                                                                                    | 表单表达力问题，与 Q-1 一起设计                                             |
| O-13 | **现存孤儿 worktree 没有回收入口**：概览页统计了 `.aiwf-worktrees` 占用，但没有清理动作（清理策略已生效，只有历史遗留的堆着）                                                                                                                                                                             | 界面功能，与 O-6 那批列表操作一起做                                         |
| O-12 | **主管 AI 抽屉的遮罩挡住整个画布**：`inset:0` + `z-index:20`，看 Diff 时对不上画布上是哪几个节点                                                                                                                                                                                                          | 与 O-8（ghost 呈现）是同一件事的两半                                        |
| O-20 | **编辑器没有撤销/重做**：工具栏那两个按钮永久禁用，⌘Z 无响应。批量删除现在有确认框兜着（删除确认框自己也如实写「撤销还没有做」），但改配置、拖节点、删连线全都不可撤销                                                                                                                                    | 要一份操作历史（Patch 是结构化的，逆操作可推），属于新能力                  |
| O-21 | **节点库添加的节点堆在一起**：每次只偏移 28px，加四个基本重叠，必须先手拖开才能连线                                                                                                                                                                                                                       | 布局问题，与 M2 蛇形布局一起做                                              |
| O-22 | **记忆的六档作用域只有「工作区」真被注入**：`memories_for_injection` 两个调用点都写死 `("workspace", None)`。界面已如实标注（选别的档会说「暂不生效」），跨侧守卫盯着两边一致                                                                                                                             | 要让引擎按节点/运行的作用域取记忆，改动牵动执行链                           |

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

## 独立复核（2026-08-02）：21 条，已修 19 条

两个独立会话复核了这一轮的改动，共报 21 条。**每一条我都自己实跑复现过**
（有一条转述时没验，被用户当场指出来 —— 那是这一轮最该记住的教训：
CLAUDE.md 明写「别把 agent 报的结论直接采信」，而我照抄了）。

### 已修（每条都做过突变验证）

| #   | 缺陷                                                                                 | 为什么之前没发现                                                           |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | **批准子运行的审批后，下游节点跑两遍**（模板里那一步是 `git push` + `gh pr create`） | 子运行绕过 `Supervisor::start` 不在 `cancels` 里，`spawn` 的防重复看不到它 |
| 2   | **定时触发起运行时 inputs 写死 `{}`**，四条定时模板到点必死                          | 手动跑一切正常，实跑记录完全看不出来                                       |
| 3   | **日志巡检的远端脚本是语法错的**，抓错误那半从没工作过                               | 错在发给远端的字符串里，本地 `zsh -n` 看不见                               |
| 4   | **报告节点拿不到上一步的结论**，只能编一份格式完美的空报告                           | 报告写得很像样，看不出是编的                                               |
| 5   | **子工作流不补入口默认值**，映射外的必填字段全空                                     | 与 #2 同构，我自己实跑嵌套时才撞上                                         |
| 6   | **三条模板引用了「不一定会走到」的端口**                                             | 守卫第一版判据写成「有没有可能走到」，太松                                 |
| 7   | **老事件 `exit_port` 为 NULL 兜底 success**，恢复旧运行时判成功而一个节点没跑        | 迁移 016 是 ADD COLUMN，新库测不到                                         |
| 8   | **端口悬空 / 合流缺策略只守着内置模板**，用户画的图 Dry Run 全绿跑起来出事           | 守卫写在 `templates.test.ts`，不在 `validateGraph`                         |
| 9   | **`outputParse: json` 解析失败仍算成功**，下游 AI 收到字面量 `null`                  | 引擎把解析失败当元数据，七条模板没一条读 `parseError`                      |

补 conformance 夹具时发现：**加之前那道对冲是空的** —— 夹具里没有能触发
新规则的图，Rust 侧不跟上也不会红。

### 一条工作方法上的教训

**改了契约源却没跑 `contracts:gen`，带着红门禁提交了一次。**

`packages/contracts/generated/builtin-workflows.json` 是模板跑
`applyPatch` 算出来的 —— 改模板脚本必须重新生成。我改完直接提交，
`gen:check` 在 verify 的最后一步才报「1 个生成物漂移」。

更糟的是我在汇报里说了「verify exit=0」：那个 0 来自**后台任务的完成通知**，
而真实退出码写在输出文件里，是 1。两者冲突时以文件为准 ——
通知只说明「命令跑完了」，不说明「它成功了」。

### 已修的第 10 条

**AI 节点条件路由（原 B-13，安全相关）**

`executor.rs` 原来取 `outputs(...).first()`，注释自承「条件路由还没做」。
端口路由（B-9）修真之前那无所谓 —— 所有下游一律执行；修真之后它变成
**安全缺陷**：`ai.review` 恒 `passed`、`ai.decide` 恒 `auto_decided`，
而 `github-issue-fix` 里 `approve_diff`（push 前的改动确认）三条入边
全是非首端口 —— 那道人工门**永远不执行**，`git push` + `gh pr create`
直接跑。

现在由模型的结论决定：多端口节点的提示词末尾加一行硬要求
（`PORT: <a | b>`），引擎解析它。**说不清时退回第一个并发
`system.port_fallback` 事件** —— 静默退回等于回到缺陷本身。
三种说不清都覆盖了：没写、写了不存在的端口、一份回答里写了两个不同的。

守卫 `crates/engine/tests/ai_port_routing_test.rs`（7 条，突变验证过）。

### 又一条工作方法上的教训：「已确认不是的」清单指错了方向

**这一条我原来记错了根因，先说清楚错在哪。**

原记录的结论是：「codex adapter 声明 `mcpCapabilities.http: true` 而不实现，
接受 `session/new` 里的 `mcpServers` 却从不去连 —— 不是我们这一侧的缺陷」，
并据此写了「在那之前不要说 AI 主管能建工作流」。

**那个结论是错的。** 用户一句话点破：ACP 拉起的就是本机的 codex，
本机 codex 接了 MCP，助理应该也拿得到。照这条查下去当场看到：

```
~/.codex/config.toml → [mcp_servers.aiwf]
  url = "http://127.0.0.1:5178/mcp/299f5b20...1699d41c"   ← 快照
实际服务                = "http://127.0.0.1:5179/mcp/269d1635...8b0e031d"   ← 现况
```

端口与令牌**两个都不对**。codex 老老实实按 config.toml 去连了，
连的是一个不存在的地址。

**为什么会漂**：「一键接入」（`mcp_connect`）把当时的地址写进 config.toml，
那是一张**快照**。而端口在启动时可能被占用后重绑
（`crates/mcp/src/http.rs` 读回实际端口），换工作区令牌也变。
`mcp_clients::connected()` 只查「那一条在不在」，不查它对不对 ——
于是设置页一直显示「已接入」。

**修法**：执行宿主起完 MCP 就把已接入客户端刷新到当前地址
（`mcp_clients::refresh_connected`），两个宿主都接上。

**实测验证（2026-08-02，devserver:5205）**：

| 步骤           | 结果                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| 启动时刷新     | config.toml 从 `:5178/...299f5b20` 改写成 `:5179/...269d1635`                     |
| 主管 AI 第一问 | `toolCalls: 16`，它自己说「系统 MCP 已确认可用」                                  |
| 走完确认链再问 | `toolCalls: 32`，建出 `wf_56d6a9e3ef787c54`「CI 早班车」，3 节点 2 连线，校验通过 |
| 建出来的图     | `entry(trigger=schedule, scheduleTime=08:00)` → `script.shell` → `end`，端口全对  |

**「codex 真的连上了」是有硬证据的，不是推断**：那 8 条待确认单是
`crates/mcp/src/protocol.rs` 的 `request_confirmation` 写的，
而那一行只有「MCP 工具被调用」这一条路径能走到。

守卫 `crates/core-api/tests/supervisor_tools_reach_test.rs` 补了第二半：
起了 MCP 的宿主必须刷新地址（突变验证过 —— 拆掉 devserver 那一行它变红）。

**顺带咬到的一条**（已单独修）：批准脚本把参数写成
`{"id":…,"decision":"approve"}`，`dispatch.rs` 的 `boolean()` 是
`unwrap_or(false)`，于是八次调用全返回 200、八条确认单**全被拒批**，
而 agent 侧只看到「还在等确认」。现在契约标必填的布尔少传即报 VALIDATION，
守卫 `crates/core-api/tests/required_boolean_test.rs` 从契约的 `required`
里捞，以后再加必填布尔自动覆盖。

**这条留下的教训**（比缺陷本身值钱）：

- **「已确认不是的」清单里那三条，每条单独都对，合起来仍然指错了方向。**
  「配置文件与监听端口一致」——我查的是**当前进程刚生成的**那份配置，
  不是 codex 会去读的 `~/.codex/config.toml`。**查对了文件才算查过**
- 「不是我们这一侧的缺陷」是最该被怀疑的那类结论。它一成立，
  整条路就从「继续找」变成「等别人修」——代价是一整条能力停在那里
- 用户比我更早想到「ACP 调的是本机 codex」。**顺着调用链往外想一层**，
  比在协议参数里逐字比对更快找到它

---

### 还没修

### 隔离系统 MCP 与 skill：调查到哪了（未实现，用户明确说先不急）

用户的另一半要求：「我们这个软件自己提供 mcp 和 skill，
让 ACP 调用的 codex / claude 只能用我们提供的，不加载系统的」。
现状是**反过来的** —— 上面那条修复正是靠「用系统的」才通的。

已找到的钩子（`@agentclientprotocol/codex-acp` 1.1.7 的 `dist/index.js`）：

```js
const codexPath = process.env['CODEX_PATH'];
const configString = process.env['CODEX_CONFIG']; // JSON，parse 后当 config 传进去
const config2 = configString ? JSON.parse(configString) : void 0;
```

另有 `this.codexAcpClient.getHomePath()`，报错文案里提到
「Check <homePath> and project .codex directories, especially their config.toml files,
or any CODEX_CONFIG override」—— 说明三个来源叠加，且 `CODEX_CONFIG` 是覆盖层。

**还没验的**：`CODEX_CONFIG` 能不能整段替掉 `mcp_servers`（而不是合并）、
claude adapter 那侧有没有对应机制、skill 从哪加载。
两端语义差异必须各跑一遍探针 —— 只测 codex 一端发现不了那类差异。

---

---

**还剩 2 条**：

- **子运行占着父运行的执行线程**，与 `supervisor.rs` 模块头
  「挂起在审批上的运行不占线程……不该占着一个执行槽」的明文承诺相反。
  代价是线程不是 CPU（实测 6 秒里只用了 0.018s）。**这条是架构取舍**：
  改它要把子运行也纳入 Supervisor 的调度，属于重构不是补丁 ——
  而同步语义（「父节点的成功/失败就是子运行的成功/失败」）正是靠它成立的
- **`approval.interaction`（单选/多选）不生效**（白名单已记）。
  它决定审批弹层长什么样，属界面表达力，与 Q-1 同族

另：`pr-followup` 拼 20 个 PR 的评论正文经环境变量喂 python3，
实测 macOS 上 ~1MB 撞 ARG_MAX —— 是**响亮失败**不是静默，
只是报错文案对用户毫无意义。

---

## 这一轮新发现、已修的（2026-08-02）

从「工作流触发方式」这条需求做下去，实跑挖出三条坏账。三条的形态一样：
**契约声明了、界面画出来了、模板认真用了，而引擎从头到尾没读过它**。

### B-9 · 端口路由是假的 —— 所有下游一律执行

**这一轮最大的一条，也是整个仓库目前最大的一处「假装成功」。**

`plan.rs` 的 `ready_nodes` 只数「有多少上游**节点**完成了」，
从不看上游从哪个端口出去。端口只进了事件摘要的文案
（「完成 · 走 success 分支」），再无下文。

四处都在认真对待端口：契约声明每种节点的输出端口、界面画出端口并
按语义上色、右键能切换连线端口、内置模板精心把失败分支接到失败终点 ——
而调度器一眼都没看过。

实测（`run_4b439b16806ef3f3`，仓库动态报告模板）：一条**成功的**运行
把标着「结束 · 材料不足」的失败终点也跑了一遍，事件 #78/#79 就跟在
#72（写报告成功）后面，运行状态仍是 succeeded，没有任何一处会报。

修法：事件加 `exit_port` 列（迁移 016），调度按「入边被走过几条」判就绪；
收尾判据同步换成「**够得着的**节点都完成了」—— 沿用旧的「完成数 ==
节点总数」的话，端口路由一生效，任何有分支的图都会被判成 failed。
守卫在 `crates/engine/tests/port_routing_test.rs`，做过元测试。

### B-10 · `entry.trigger` 五个枚举值，引擎 grep 零命中

用户在画布上把入口设成 `schedule`，节点上老实显示「触发：schedule」，
到点什么都不发生，也没有任何地方告诉他不会发生。

掩护它的是 node-config-drift 白名单里那一行：
「界面：触发方式决定什么时候发起运行，那是发起方的事」——
**而当时根本没有发起方**。一条听起来合理的白名单理由掩护了很久。

修法：枚举收敛成 `manual / schedule / interval`（删掉三个引擎做不到的），
补 `scheduleTime` / `intervalMinutes`，加 `crates/engine/src/schedule.rs`
与 `crates/core-api/src/scheduler.rs`。守卫拿生成物的枚举值逐个喂给解析器。

**顺带发现**：漂移守卫会被**测试夹具里的字符串**骗过去 ——
`schedule.rs` 的测试用例写了 `"inputSchema": {}` 当占位，
`entry.inputSchema` 就被判成「已接上」。现在扫描跳过 `#[cfg(test)]`。

### B-11 · 报告抽屉永远打不开

界面按契约的 `REPORT_ARTIFACT_NAME`（`report.json`）去 `run.artifacts`
里找，而引擎只会存**固定几个名字**的产物：`stdout.log` / `agent.md` /
`command.sh`…… 没有任何路径产出 `report.json`。

修法：`end.artifacts` 从欠账变成真的 —— 结束节点按声明去工作目录取文件，
取不到发 `artifact.missing`，越界发 `artifact.rejected`。
守卫 `crates/engine/tests/end_artifacts_test.rs`（删掉实现红 5 条）。

### 这三条是怎么被抓到的

**全都是实跑抓的，不是读代码读出来的。**

- 定时触发写完、单测 16 条全绿，实跑五分钟一条运行都没起来 ——
  `next_fire_at` 对「从没跑过」的间隔触发返回「当刻 + 一个间隔」，
  永远在未来。单测只断言了「第一次不立刻跑」，**从没断言过
  「等够一个间隔要跑」**
- 端口路由那条是拿真模板跑完之后逐条读事件流看出来的：
  85 条事件里第 78 条不该在那儿

CLAUDE.md 第五条「能实跑就别推断」这一轮兑现了三次。

### B-12 · `subworkflow` 契约有 7 个字段、建表就有 `parent_run_id`，引擎零引用

不算「假装成功」（它老实标着 `implemented: false`，Dry Run 会拦），
但契约、存储、界面三处都为它铺好了路，而中间那段一直是空的。

现在 `mode: sync` 是真的：独立子 Run + `parent_run_id`、入参映射、
出参回填、环检测（A → B → A）、8 层深度上限。实跑验证过嵌套两层，
子运行在运行列表里与父运行平级且指得回去。

`parallel` 与 `onFailure: retry` **明确报「尚未实现」** ——
悄悄按 sync 跑的话 `concurrencyLimit: 5` 看起来生效而实际串行，
用户等五倍时间且找不到原因。

守卫 `crates/engine/tests/subworkflow_test.rs`（8 条，做过突变验证：
把节点改成直接标绿红 6 条；去掉环检测红 1 条）。

### 这一轮还做了

- **子工作流 sync 调用**（见上面 B-12）
- **内置模板从 1 条到 6 条**：Issue 修复 / Issue 需求开发 /
  仓库动态报告（定时）/ 服务器日志巡检（定时）/ 依赖升级巡检（每周）/
  发布前检查单。每条的采集脚本都实跑验证过，不是「看起来对」
- **同工作流并行运行按工作流分组，子运行标出来**：三个 Issue 修复
  同时在跑时，平铺是三行一模一样的名字；子运行与父运行平级的话，
  用户看到一条自己没启动过的运行无从判断是谁叫起来的
- **模板结构不变量改成遍历全部模板**：原来 9 条断言只跑
  `github-issue-fix`，新加的模板等于没测 —— 改完立刻抓到
  新模板缺汇聚策略、端口名写错、审批端口没下游

### 仍未还的（这一轮记上账）

| #    | 欠账                                                                                                                        | 证据                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| O-23 | **内置模型 `model:codex` 的 modelId 是 `gpt-5-codex`，当前 codex adapter 不认**：每个 AI 节点都发 `system.model_downgraded` | `run_4b439b16806ef3f3` 事件 #25 / #37：「模型 gpt-5-codex 这个 runtime 不认，改用它自己的默认值」 |
| O-25 | **子工作流的 `parallel` 与 `onFailure: retry` 未实现**：明确报「尚未实现」，不是静默降级。`concurrencyLimit` 因此还用不上   | `crates/engine/tests/subworkflow_test.rs` 的 parallel 用例                                        |
| O-24 | **拒批走 `node.failed` 而不是 `rejected` 端口**：图上接在 `approval.rejected` 上的分支，人工拒批时不会走到（AI 拒批会走）   | `runner.rs` 的 `decide_approval` else 分支直接 `run.failed`                                       |

---

## 上一轮新发现、已修的

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
