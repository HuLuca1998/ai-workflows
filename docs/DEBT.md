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

### B-1 · `notify` 节点假装成功

**位置**：`crates/engine/src/executor.rs:461`

```rust
"entry" | "end" | "notify" => Ok(NodeOutcome::Succeeded { port: "success" }),
```

`notify` 和 `entry` / `end` 归在同一档 —— 什么都不做，直接返回成功。

而它的契约定义（`packages/contracts/src/nodes/definitions.ts`）承诺的是
「macOS 系统通知，点击可跳回运行」，带 6 个配置字段
（`title` / `subtitle` / `body` / `on` / `clickAction` / `onFailure`）
与 `success` / `failed` 两个端口。

**三层掩护**：

| 掩护                                    | 说明                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `preflight.rs:46` 的 `IMPLEMENTED` 清单 | 它在里面，所以 **Dry Run 也不报**。用户拿不到任何警告                                             |
| `executor_test.rs:211` 一条绿着的测试   | 名字叫「通知节点在无桌面环境下也不应崩溃」，注释写「实际发送在 Tauri 壳里做，引擎只负责记录意图」 |
| ROADMAP 里「通知与恢复」列为已完成      | 该范围整体记为 ✅                                                                                 |

测试注释说的那两件事都不成立：**壳里没有实现，引擎也没记任何意图**。

**验证**：

```bash
rg -n 'notification|notify' apps/desktop/src-tauri/src/ apps/desktop/src-tauri/capabilities/ apps/desktop/src-tauri/Cargo.toml
# 零命中：无 tauri-plugin-notification 依赖、无 capability、无消费方
```

**影响放大的地方**：内置模板 `github-issue-fix` 里就有一个 `notify` 节点，
而「一键初始化」种下的示例工作流用的就是这个模板。**用户第一条能跑的工作流，
最后一个节点是绿的、什么也不会发生。**

它同时违反 `executor.rs` 第 3 行自己写下的铁律：

> 一条铁律：**没实现的节点类型明确报「尚未实现」，绝不假装成功**。

**还清的判据**：二选一。
真做 —— 接 `tauri-plugin-notification`、capabilities 逐条授权、`clickAction` 能跳回运行、
发 `system.notification_sent` 事件（见 B-2）；
或诚实降级 —— 把 `notify` 移出 `IMPLEMENTED`，让 Dry Run 说话，
并把那条测试改成断言「报未实现」而不是「不崩溃」。

---

### B-2 · 50 个事件类型，23 个从未被发射

**这是本次盘点最大的一条。**

架构原则第 2 条是：

> **RunEvent 是唯一事实来源**。不存在第二份运行状态。`event-store.ts` 把同一条流投影成
> 对话视图、事件视图、产物视图、节点进度、运行状态、**可解释性证据**
> （用了哪个模型 / 提示词 / 注入了哪些记忆 / 谁批准了什么）。

实际发射覆盖率 **27 / 50 = 54%**。

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

零发射的 23 个，按危害排：

| 事件                                             | 谁在承诺它                                                                                         | 后果                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `node.cancelled`                                 | **界面明写**：`NodeConfigDialog.tsx:269`「收到取消信号后先停止子进程，再写入 node.cancelled 事件」 | 界面上的一句话，实现为零           |
| `system.model_downgraded`                        | **界面明写**：`AgentsPage.tsx:482`「降级发生时会写入 RunEvent，不会静默替换模型」                  | 降级真的会静默发生                 |
| `system.prompt_resolved`                         | 「提示词与模型在运行记录中可追溯到具体版本」                                                       | 见 B-3，提示词那一半完全没有       |
| `system.audit`                                   | 契约里 40+ 个方法标着 `audited: true`                                                              | 审计标记没有任何落点               |
| `system.permission_granted` / `_denied`          | 权限档确实在拦（实证过），但**拦了不留痕**                                                         | 事后无法回答「这次运行被拦了什么」 |
| `system.redaction_applied`                       | 脱敏确实在做（三道），但不留痕                                                                     | 无法证明脱敏发生过                 |
| `system.checkpoint_saved`                        | 「每个节点完成后落一次带 Scope 快照的检查点」                                                      | 检查点真的落了，但事件流里看不到   |
| `artifact.created` / `artifact.truncated`        | 产物确实在落盘、确实会截断                                                                         | 「产物视图」这个投影没有源事件     |
| `system.notification_sent`                       | 呼应 B-1                                                                                           | —                                  |
| `system.memory_written`                          | 记忆提议写入已实现                                                                                 | 写入不留痕                         |
| `run.paused` / `run.resumed` / `run.interrupted` | 状态机里有这些状态                                                                                 | 见 B-7                             |
| `node.queued` / `node.retried` / `node.skipped`  | 调度器真的会排队、真的会跳过                                                                       | 节点进度投影缺档                   |
| `approval.reminded` / `approval.expired`         | 对应 `approval` 节点的 `reminderAfterMs` / `waitStrategy` 字段（见 B-5）                           | 提醒与超时都不存在                 |
| `conversation.agent_delta`                       | 流式增量                                                                                           | 对话只有整条消息，无流式           |
| `system.env_snapshot` / `system.session_rebuilt` | 风险表里写着「不可恢复时明确告知『已用结构化状态重建』」                                           | 那句「明确告知」没有载体           |

**掩护它的是什么**：契约测试验的是「事件 Schema 定义正确」和「流不变量成立」，
**没有任何测试验「每个声明的事件类型都有发射点」**。所以定义了不发，一路绿灯。

**加强证据 —— 前端已经把消费侧写好了，而且测得很认真**：

```bash
# 投影处理 32 个事件类型，其中 11 个引擎从不发
rg -o "'(run|node|approval|conversation|tool|artifact|system|reasoning)\.[a-z_]+'" \
   packages/client-core/src/event-store.ts --no-filename | sort -u
```

`node.queued`、`node.retried`、`node.skipped`、`node.cancelled`、`approval.expired`、
`run.paused`、`run.resumed`、`run.interrupted`、`artifact.created`、
`system.model_downgraded`、`system.prompt_resolved` —— 这 11 个在
`event-store.ts` 里都有真正的投影分支，而引擎一个都不发。

而 `packages/client-core/tests/event-store.test.ts:68` 是这么测的：

```ts
ev({ type: 'node.queued', seq: 5, nodeId: 'n1', attempt: 1 }),
```

**测试自己构造事件喂给投影**。投影处理得完全正确，测试绿 ——
但生产中这个事件永远不会出现。契约、投影、投影测试三处各自都「完成」了，
**中间那一段断着，而三处的绿灯合起来看像一条通的链路**。

这是这份台账里最典型的一条：不是谁偷懒，是**每一侧都做完了自己那份**，
而没有任何测试站在接缝上。

**还清的判据**：加一条守卫测试，断言契约声明的每个事件类型在引擎/core-api 里
至少有一个发射点；有意暂不发射的进白名单并写明理由（照 `DELIBERATELY_HIDDEN` 的做法）。
然后逐个补发射点 —— 按上表的顺序，界面明确承诺的那两条先补。

---

### B-3 · 提示词库与执行路径是断开的

**位置**：`crates/engine/src/executor.rs` 的 `run_ai`

AI 节点执行时只读两个配置字段：`agentProfileId` 和 `instruction`。
提示词拼接是「角色 → 记忆 → 指令」三段，**从不读 `prompt` 表**。

**验证**：

```bash
rg -n 'pub fn with_' crates/engine/src/executor.rs
# 有 with_agent_profiles / with_memories / with_capabilities…… 没有 with_prompts

for f in promptId turnLimit outputContract modelPolicy; do
  echo -n "$f: "; rg -c "\"$f\"" crates/engine/src | awk -F: '{s+=$2} END{print s+0}'
done
# 全部 0
```

而契约对 `promptId` 的描述是「提示词\n**留空则用该节点类型的内建提示词**」——
这句话暗示「填了就用填的那个」。实际上填了也不用。

**掩护它的是什么**：整个「提示词库」屏做完了而且做得很细
（分段可见可改、变量表、版本历史带「时间 · 谁改的」、「插入变量」后光标定位、
存储层拒收空分段），当时列为已交付并专门记了三条改进。
**一屏做得越完整，越没有人会去问「它有出口吗」。**

出口标准写着「提示词与模型在运行记录中可追溯到具体版本」：
模型那一半有 `system.model_resolved`（`runner.rs:311`），提示词那一半零。

**还清的判据**：`NodeExecutor` 加 `with_prompts`，`run_ai` 读 `promptId` 并解析到具体版本，
执行前发 `system.prompt_resolved` 带 promptId + version。
一条端到端测试：节点指定提示词 → 运行 → 事件流里能读到用的是哪一版。

---

### B-4 · `cleanup_worktree` 是死代码，worktree 无限累积

**位置**：`crates/engine/src/worktree.rs:87`

```bash
rg -n 'cleanup_worktree' crates apps -g '!node_modules' | grep -v 'worktree.rs'
# 全部命中都在 crates/engine/tests/worktree_test.rs —— 生产代码零调用
```

那个函数写得很好：有「有未提交的改动，已拒绝清理」和「不是引擎建的 worktree，已拒绝清理」
两条安全检查，还处理了「分支名斜杠转短横，避免清理时误删同级 worktree」。
**只是没有人调用它。**

`git.worktree` 节点的 `cleanupPolicy` 配置字段零消费方（`conflictPolicy` / `fetch` /
`parentDir` 同样）。所以：**每跑一次带 worktree 节点的工作流，
磁盘上就留一个 worktree 目录 + 一个 git 分支，永不回收。**

**掩护它的是什么**：交付清单里写着

> **Git worktree 节点**：分支已存在拒绝复用、**有未提交改动拒绝清理**、
> 分支名斜杠转短横（避免清理时误删同级 worktree）

第二条描述的是一个从未被调用的函数。而 `worktree_test.rs` 里 6 条测试全绿 ——
它们测的是函数本身，函数确实是对的。

**还清的判据**：`cleanupPolicy` 真的驱动清理（运行结束 / 节点成功 / 从不，按配置），
一条测试断言「跑完一个带 worktree 的运行后，按策略该清的清了、该留的留了」。
另外给现存的孤儿 worktree 一个回收入口（概览页已经在统计 `.aiwf-worktrees` 的占用，
统计了却没有清理入口本身也是个断头路）。

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
| `ai.*`         | `promptId`、`turnLimit`、`outputContract`                             | 见 B-3                                                                                         |
| `git.worktree` | `parentDir`、`fetch`、`conflictPolicy`、`cleanupPolicy`               | 见 B-4                                                                                         |
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

**对照组**：`NodeConfigDialog.tsx:269` 对重试策略是这么写的 ——

> 重试策略还不能改：引擎目前不读它，改了也不会生效。

**这就是正确做法，而且已经在这个仓库里了。** 上面 22 个字段该按同样的方式处理：
要么实现，要么在表单上说清楚它现在不生效。

**还清的判据**：~~加一条守卫测试，对每个已实现节点类型的 configSchema 顶层字段，
断言它在引擎里有消费点或在「已知不生效」白名单里~~（已补，见本节开头）；
剩下两半 —— **白名单里的字段要在配置弹层上显示「引擎目前不读它」**
（照 `NodeConfigDialog.tsx:269` 那个写法），以及逐个把它们真的接上。

---

### B-6 · `IMPLEMENTED` 清单与 executor 之间没有守卫

**位置**：`crates/engine/src/preflight.rs:43` 与 `crates/engine/src/executor.rs:460`

```bash
rg -n 'IMPLEMENTED' crates/engine
# 只有 preflight.rs 内部两处，没有任何测试
```

Dry Run 靠 `IMPLEMENTED` 清单判断「这个节点类型能不能跑」，
executor 靠 `match node.node_type.as_str()` 分派。**两份清单，零一致性检查。**

B-1 就是这么发生的：`notify` 在清单里，match 分支里也「有」（和 entry/end 并列），
两边都对得上，只是那一档什么都不做。

这条是结构性的：**未来任何节点类型都能用同样的方式混进去**，
而且 Dry Run 会替它背书。

**还清的判据**：一条测试，对 `NODE_TYPES` 的每一种，断言
「在 `IMPLEMENTED` 里 ⇔ executor 有专门的分派分支且不是空操作」。
空操作节点（`entry` / `end` 确实什么都不用做）显式登记，写明理由。

---

### B-7 · 杀掉 App，正在跑的运行永远卡在「运行中」

**用户可见，而且没有出路。**

契约定义 11 个运行状态。引擎实际写入的只有 5 个：

```bash
rg -n 'advance_run_status\([^)]*' crates/engine/src crates/core-api/src --no-filename
# 字面量只有 running / waiting_approval / failed；runner.rs:257 的变量取 succeeded|failed
```

`paused`、`interrupted`、`resuming` **从未被写入**（`status.rs` 里那几行是枚举到
字符串的映射定义，`supervisor.rs:96` 是读不是写）。

于是这条路走死了：

| 步骤 | 发生什么                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | 用户跑一条工作流，运行状态 = `running`                                                                            |
| 2    | 用户 Cmd+Q / App 崩溃 / 断电 —— 进程没有机会执行任何代码                                                          |
| 3    | 重启 App。`Store::open_workspace` 只做迁移 + 种内置数据，**没有孤儿运行扫描**                                     |
| 4    | 那条运行**永远显示「运行中」**，没有线程在推进它                                                                  |
| 5    | 想恢复？`supervisor.rs:96` 只接受 `failed` / `interrupted` / `paused` —— 状态是 `running`，**连「恢复」都点不了** |

`interrupted` 这个状态就是为这个场景定义的。没有任何代码写它，
所以第 5 步那个判断在等一个永远不会到来的状态。

**掩护它的是什么**（三层，这条的掩护最厚）：

1. **出口标准写着「杀掉 App 后重启能回到同一审批点」，而且真的验过** ——
   `supervisor_test.rs` drop 全部内存对象后重开数据库，批准并跑完。
   但那验的是卡在 `waiting_approval` 的运行，**那个状态本来就是等人的**，
   重启后当然还在。**正在跑**的运行被杀，出口标准没覆盖
2. `record_background_failure`（`supervisor.rs:190`）的注释精确描述了这个后果：

   > 不写的话，运行会停在 running 但已经没有线程在推进它 ——
   > 界面显示「运行中」，实际永远不会有下一步，而日志里也没有线索。

   **写这段注释的人完全清楚这个失败形态。** 但那个函数只处理
   「线程 panic 而进程还活着」，进程被杀时它根本不会被调用

3. 前端投影有 `run.interrupted` 分支（见 B-2），界面大概率也有对应样式 ——
   一切看起来都准备好了，只是没有东西触发它

**还清的判据**：`open_workspace`（或 Supervisor 启动）扫一次
「状态是 `running` / `resuming` 但没有活线程」的运行，标成 `interrupted`
并发 `run.interrupted` 事件。一条测试：写一条 `running` 的运行 →
不经过任何清理直接重开 Store → 断言它变成 `interrupted` 且可恢复。

这条同时把出口标准补全 —— 现在那条标准只验了两种崩溃场景里的一种。

---

## 二、烂账

### L-1 · Supervisor 两处吞错

**位置**：`crates/engine/src/supervisor.rs:195` 与 `:210`

```rust
let _ = store.append_event(&aiwf_store::NewRunEvent { ... });   // 写事件失败被吞
let _ = store.advance_run_status(run_id, "failed", None);        // 状态推进失败被吞
```

（`runner.rs` 里那几处 `let _ = ...?` 带 `?`，错误会传播，不算。）

界面审查曾报过同一形态（「主管 AI 的三次写库全部『失败也不管』」），已修。
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
跑起来、修好、再跑」）靠的是一次人工端到端跑通（见 [archive/mcp-e2e-report.md](archive/mcp-e2e-report.md)），
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

## 三、欠账

这些都记在账本上、有理由、不需要额外机制。列在这里是为了台账完整，
详细排期见 [ROADMAP.md](ROADMAP.md)。

| #   | 欠账                                                                                                  | 状态                                          |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| O-1 | **6 种节点类型未实现**：`branch` / `transform` / `subworkflow` / `script.python` / `env` / `mcp.tool` | Dry Run 会诚实报错                            |
| O-2 | **Web 形态实际为零**：只有 `MemoryTransport` 与 `crates/devserver`（179 行、无鉴权）                  | 开工前先回答「给谁用」                        |
| O-3 | **WKWebView 零测试**：`tests/e2e/` 全是 Playwright；「拖动卡」的定论依赖它                            | 唯一一条真实用户反馈悬着                      |
| O-4 | 模型策略映射                                                                                          | 要等 `provider.api` 运行时                    |
| O-5 | 审查未覆盖项：混沌输入、键盘走查与读屏、worktree 与存储层的深度审查                                   | 见 [archive/审查历史.md](archive/审查历史.md) |

---

## 优先级建议

不按类别排，按「不修的代价」排：

| 顺序 | 条目                    | 为什么排这里                                                                          |
| ---- | ----------------------- | ------------------------------------------------------------------------------------- |
| 1    | **B-1** notify          | 示例工作流里就有一个。一键初始化后用户第一次跑就撞上                                  |
| 2    | **B-7** 运行卡死        | 用户可见，而且连「恢复」都点不了。Cmd+Q 是最常见的退出方式                            |
| 3    | **B-4** worktree 不清理 | 唯一一条**在用户磁盘上持续累积**的。每跑一次多一个目录和分支                          |
| 4    | **B-6** + **B-5** 守卫  | 这两条是**成因**。不补守卫，B-1 / B-5 会以新形态重新长出来                            |
| 5    | **B-2** 事件发射        | 违反的是架构第一原则。界面明确承诺的两条（`node.cancelled` / `model_downgraded`）先补 |
| 6    | **B-3** 提示词          | 一整屏功能没有出口；出口标准只兑现一半                                                |
| 7    | **L-1** 吞错            | 概率低但后果不可逆（事件流缺档 = 无法重建）                                           |
| 8    | O-3 WKWebView           | 用户唯一的真实体感反馈至今没有定论                                                    |
| 9    | O-1 节点类型            | 表达力，不是正确性                                                                    |

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
