# 端到端：让外部 AI 通过系统 MCP 设计并跑通一条工作流

这一轮验的不是某个函数，是一整条链路：**一个不知道这个系统长什么样的
AI 客户端，能不能只靠 MCP 把一条工作流从零搭出来、跑起来、出问题时
自己读事件流找到原因、修好、再跑。**

执行者是 `codex exec`（外部进程，只通过 MCP 与应用打交道），
被测的是这个仓库里的系统 MCP、引擎与存储层。

## 环境

|             |                                                                          |
| ----------- | ------------------------------------------------------------------------ |
| MCP         | `aiwf-mcp --db <工作区>/aiwf.sqlite`，`http://127.0.0.1:5178/mcp/<令牌>` |
| 客户端      | `codex mcp add aiwf --url …`，codex-cli 0.145.0                          |
| ACP adapter | codex-acp 1.1.7（`mcpCapabilities.http: true`）                          |
| 权限档      | `trusted_workflow` —— 这一轮无人值守，逐项确认跑不完                     |
| 目标仓库    | `HuLuca1998/aiwf-e2e-fixture`（真实仓库，真实 issue，真实缺陷）          |

工作区是全新的，只有迁移种下的内置数据：2 个模型、4 个 Agent 角色、
4 条提示词、4 条记忆。

Claude Code 那条接入路径单独验过：
`claude mcp add --transport http … --header "Authorization: Bearer …"`
之后 `claude mcp list` 显示 `✔ Connected`。

## 目标场景

```
入口 → 读取 Issue → 分析根因 → 克隆仓库 → 隔离 worktree
    → 修复 → 审查 → 风险分级 → 人工审批 → 提交并建 PR → 通知 → 结束
```

## AI 做到了什么

**不给图，只给一句话的目标与三份资源的名字。** 它自己：

1. 读了 `aiwf://guide/build-and-run`、`aiwf://catalog/nodes`、
   `aiwf://workspace/inventory`
2. `workflow_create` 建工作流
3. **一次** `workflow_patch` 加了 11 个节点 + 10 条连线，
   端口全部取自节点目录，没有一个 `UNKNOWN_PORT`
4. `workflow_validate` → `run_dry_run` → `workflow_publish` → `run_start`
5. 失败之后 `run_events` 读完整事件流，定位到具体节点与原因
6. `workflow_patch` 修、重新发布、重跑 —— 自主循环了 5 轮，发到 v6

第 4 轮它**自己往图里插了一个新节点**（`clone_repo`）并重新接线：
断开 `analyze→worktree`，改成 `analyze→clone_repo→worktree`。
没人告诉它要加这个节点，是它从「repo 不是一个 Git 仓库」这条事件
推出来的。

### 修复是真的

`fix` 节点的 Agent 在隔离 worktree 里真的改了代码并提交：

```
fb8c7c8 fix(cache): invalidate changed config entries
 src/cache.js       |  2 +-
 test/cache.test.js | 21 +++++++++++++++++++++
```

```diff
-// BUG: 热重载时没有清空缓存，watcher 只更新了磁盘快照
 export function onFileChanged(key) {
   readFromDisk(key);
+  cache.delete(key);
 }
```

这正是 issue #1 描述的缺陷，而且它顺手补了回归测试。

## 抓到的真问题（都已修复，都补了测试）

这一轮的价值主要在这里 —— 四个只有真跑才会暴露的问题，
每一个都是「界面上写着的话不是真的」。

### 1. `${…}` 被重复加引号

AI 写出 `gh issue view "${input.issue}"`。引擎替进去的值**已经加过
shell 引号**（`interp::shell_quote`，单引号内没有元字符会被解释，
那是刻意的安全设计），于是命令收到的是 `"'1'"`，报
`invalid issue format` —— 错误信息离原因隔着一层引号。

引擎的行为没错，坏在这件事**无处可知**：`script` 字段的描述里一个字
都没提。修复：

- 字段的 `.describe()` 写明这条（配置弹层与 `aiwf://catalog/nodes` 共用）
- `aiwf://guide/build-and-run` 给出正反例
- **Dry Run 拦下它**（`preflight::check_double_quoting`）——
  在起运行之前就说清是哪个节点的哪个变量

### 2. worktree 的相对路径按错了基准

`clone_repo` 把仓库克隆进运行工作目录，`worktree` 写
`repoRoot: "repo"` —— 报「不是一个 Git 仓库」。

`PathBuf::from("repo")` 按**进程的 CWD** 解析，而那是应用自己的目录。
脚本节点的 cwd 是运行工作目录，两个节点对「相对路径相对于谁」的理解
不一致，而错误信息里看不出这件事。

### 3. AI 节点根本没读 Agent 角色

`run_ai` 只读 `instruction` 与 `runtime`。用户在「Agent 角色」屏上填的
目标、人设、输出契约、能力，一个字都没到过模型面前。

症状不是报错，是「界面上摆着一排设置，改了没有任何区别」，
而执行记录里那句「用了哪个模型」也无从谈起。

### 4. `workdirSource` 是空的 —— 而它是安全声明

契约里这个字段写着「工作目录来源\n由引擎强制，Prompt 不能改变安全边界」，
图纸写着「Fix Agent 的 cwd 固定为 `$GIT_WORKTREE_PATH`，不会污染你当前分支」。

而引擎一直把运行工作目录直接当 cwd 交给 ACP 会话。Fix Agent 实际跑在
克隆出来的仓库里，不是隔离的 worktree —— 那两句话都是空的。

修好之后，运行记录里能直接核对：

```
system.model_resolved · fix
  Agent 角色「执行者」（builtin:builder）· 模型 model:codex
  · runtime acp.codex · cwd …/.aiwf-worktrees/fix-1-run_18c68b3474289bd8
```

### 5. AI 节点走的端口不存在

`run_ai` 硬编码 `port: "success"`，而契约里 `ai.review` 的端口是
`passed` / `changes_requested`，`ai.decide` 是 `auto_decided` / `escalated`。

于是事件流写着「审查修复 完成 · 走 success 分支」—— 一个不存在的分支；
输出落在 `outputs.review.success`，下游写 `${review.passed}` 解析不出来。
两样都是记录不准确。

## 数据完整性

`node scripts/dump-run.mjs <db>` 出的报告逐项核对：

- **seq 连续无缺口** —— `(run_id, seq)` 由存储分配
- **每个 `node.started` 都有配对的结束事件**
- **生命周期齐全**：`run.created → preflight_passed → queued → started → succeeded`
- **审批是引擎强制的暂停点**：`node.waiting → approval.requested →
approval.decided → node.succeeded`，绕不过去
- **可解释性证据在事件流里**，不在别处：
  - `system.memory_injected`：注入了哪 4 条记忆，按 key 列出
  - `system.model_resolved`：这一步用了哪个角色、哪个模型、哪个 runtime、
    跑在哪个目录里

`system.model_resolved` 写在**执行之前**：AI 节点连 adapter 可能挂上
好几分钟，而排查「它卡在哪」的第一个问题就是「它到底想连哪个」。

## 还没做的

- **条件路由**：调度器只看「上游完成没有」，不看走的是哪个端口。
  所以 `ai.review` 走 `changes_requested` 时，下游该跳过的那一支
  照样会跑。「循环修复」目前靠再起一次运行，不是靠图里的回边。
- **`run.delete`**：产品里没有删运行记录的路径。清理只能走
  `scripts/prune-runs.mjs`（默认只预览，`--yes` 才真删）。
