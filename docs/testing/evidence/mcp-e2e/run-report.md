# 运行报告 · GitHub Issue 修复

## 这一次跑的是什么

| | |
| --- | --- |
| 工作流 | GitHub Issue 修复 `wf_86f1f0aa32e80e55` |
| 版本 | v6 `wv_18c68a46d0687da8`（config_hash `4afffe48a32e`） |
| 运行 | `run_18c68b3474289bd8` |
| 状态 | **succeeded** |
| 开始 / 结束 | 2026-07-28T19:35:59.702Z → 2026-07-28T19:45:52.702Z |
| 入参 | `{"repo":"HuLuca1998/aiwf-e2e-fixture","issue":"1"}` |
| 工作目录 | `<工作区>/runs/run-1785267359702-0000` |
| 节点 / 连线 | 12 / 11 |
| 事件 | 37 条 |

## 事件流完整性

- seq 连续：✅ 无缺口
- 每个 node.started 都有结束事件：✅
- 生命周期：run.created → run.preflight_passed → run.queued → run.started → run.succeeded

## 每个节点发生了什么

| 节点 | 类型 | 结果 | 说明 |
| --- | --- | --- | --- |
| 入口 `entry` | `entry` | ✅ 成功 | 入口 完成 · 走 success 分支 |
| 读取 Issue `read_issue` | `script.shell` | ✅ 成功 | 读取 Issue 完成 · 走 success 分支 |
| 分析 Issue `analyze` | `ai.analyze` | ✅ 成功 | 分析 Issue 完成 · 走 success 分支 |
| 创建 Worktree `worktree` | `git.worktree` | ✅ 成功 | 创建 Worktree 完成 · 走 success 分支 |
| 执行修复 `fix` | `ai.execute` | ✅ 成功 | 执行修复 完成 · 走 success 分支 |
| 审查修复 `review` | `ai.review` | ✅ 成功 | 审查修复 完成 · 走 passed 分支 |
| 决定是否提交 `decide` | `ai.decide` | ✅ 成功 | 决定是否提交 完成 · 走 auto_decided 分支 |
| 人工审批 `approve` | `approval` | ✅ 成功 | 审批通过 |
| 提交并创建 PR `push_pr` | `script.shell` | ✅ 成功 | 提交并创建 PR 完成 · 走 success 分支 |
| 完成通知 `notify` | `notify` | ✅ 成功 | 完成通知 完成 · 走 success 分支 |
| 结束 `done` | `end` | ✅ 成功 | 结束 完成 · 走 success 分支 |
| 克隆仓库 `clone_repo` | `script.shell` | ✅ 成功 | 克隆仓库 完成 · 走 success 分支 |

## 为什么这么做（可解释性证据）

| seq | 类型 | 节点 | 内容 |
| --- | --- | --- | --- |
| 5 | `system.memory_injected` | — | 注入了 4 条记忆：不确定就说不确定、凭据只用引用、外部写操作要先确认、小步可验证 |
| 11 | `system.model_resolved` | analyze | Agent 角色「分析师」（builtin:analyst）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000 |
| 18 | `system.model_resolved` | fix | Agent 角色「执行者」（builtin:builder）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000/.aiwf-worktrees/fix-1-run_18c68b3474289bd8 |
| 21 | `system.model_resolved` | review | Agent 角色「审查者」（builtin:reviewer）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000 |
| 24 | `system.model_resolved` | decide | Agent 角色「决策者」（builtin:operator）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000 |
| 28 | `approval.requested` | approve | 人工审批 |
| 29 | `approval.decided` | approve | 决定：approved |

## 产物

目录：`<工作区>/runs/run-1785267359702-0000/.aiwf-artifacts/run_18c68b3474289bd8`

| 节点 | 文件 | 字节 |
| --- | --- | --- |
| analyze | `agent.md` | 3474 |
| analyze | `reasoning.md` | 386 |
| clone_repo | `stderr.log` | 23 |
| decide | `agent.md` | 230 |
| decide | `reasoning.md` | 47 |
| fix | `agent.md` | 2180 |
| fix | `reasoning.md` | 559 |
| push_pr | `stdout.log` | 22 |
| read_issue | `stdout.log` | 308 |
| review | `agent.md` | 2943 |
| review | `reasoning.md` | 944 |

## 完整事件流

| seq | 类型 | 节点 | actor | 摘要 |
| --- | --- | --- | --- | --- |
| 1 | `run.created` | — | engine | 运行已创建 |
| 2 | `run.preflight_passed` | — | engine | 依赖检查通过 |
| 3 | `run.queued` | — | engine | 已进入队列 |
| 4 | `run.started` | — | engine | 开始执行 |
| 5 | `system.memory_injected` | — | engine | 注入了 4 条记忆：不确定就说不确定、凭据只用引用、外部写操作要先确认、小步可验证 |
| 6 | `node.started` | entry | engine | 入口 开始 |
| 7 | `node.succeeded` | entry | engine | 入口 完成 · 走 success 分支 |
| 8 | `node.started` | read_issue | engine | 读取 Issue 开始 |
| 9 | `node.succeeded` | read_issue | engine | 读取 Issue 完成 · 走 success 分支 |
| 10 | `node.started` | analyze | engine | 分析 Issue 开始 |
| 11 | `system.model_resolved` | analyze | engine | Agent 角色「分析师」（builtin:analyst）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000 |
| 12 | `node.succeeded` | analyze | engine | 分析 Issue 完成 · 走 success 分支 |
| 13 | `node.started` | clone_repo | engine | 克隆仓库 开始 |
| 14 | `node.succeeded` | clone_repo | engine | 克隆仓库 完成 · 走 success 分支 |
| 15 | `node.started` | worktree | engine | 创建 Worktree 开始 |
| 16 | `node.succeeded` | worktree | engine | 创建 Worktree 完成 · 走 success 分支 |
| 17 | `node.started` | fix | engine | 执行修复 开始 |
| 18 | `system.model_resolved` | fix | engine | Agent 角色「执行者」（builtin:builder）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000/.aiwf-worktrees/fix-1-run_18c68b3474289bd8 |
| 19 | `node.succeeded` | fix | engine | 执行修复 完成 · 走 success 分支 |
| 20 | `node.started` | review | engine | 审查修复 开始 |
| 21 | `system.model_resolved` | review | engine | Agent 角色「审查者」（builtin:reviewer）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000 |
| 22 | `node.succeeded` | review | engine | 审查修复 完成 · 走 passed 分支 |
| 23 | `node.started` | decide | engine | 决定是否提交 开始 |
| 24 | `system.model_resolved` | decide | engine | Agent 角色「决策者」（builtin:operator）· 模型 model:codex · runtime acp.codex · cwd <工作区>/runs/run-1785267359702-0000 |
| 25 | `node.succeeded` | decide | engine | 决定是否提交 完成 · 走 auto_decided 分支 |
| 26 | `node.started` | approve | engine | 人工审批 开始 |
| 27 | `node.waiting` | approve | engine | 人工审批 等待人工决定 |
| 28 | `approval.requested` | approve | engine | 人工审批 |
| 29 | `approval.decided` | approve | user | 决定：approved |
| 30 | `node.succeeded` | approve | engine | 审批通过 |
| 31 | `node.started` | push_pr | engine | 提交并创建 PR 开始 |
| 32 | `node.succeeded` | push_pr | engine | 提交并创建 PR 完成 · 走 success 分支 |
| 33 | `node.started` | notify | engine | 完成通知 开始 |
| 34 | `node.succeeded` | notify | engine | 完成通知 完成 · 走 success 分支 |
| 35 | `node.started` | done | engine | 结束 开始 |
| 36 | `node.succeeded` | done | engine | 结束 完成 · 走 success 分支 |
| 37 | `run.succeeded` | — | engine | 全部节点已完成 |

## 这个工作区里还有什么

### 工作流（1）

| id | name |
| --- | --- |
| wf_86f1f0aa32e80e55 | GitHub Issue 修复 |

### Agent 角色（4）

| id | name | runtime | model_ref |
| --- | --- | --- | --- |
| builtin:analyst | 分析师 | acp.codex | model:codex |
| builtin:builder | 执行者 | acp.codex | model:codex |
| builtin:operator | 决策者 | acp.codex | model:codex |
| builtin:reviewer | 审查者 | acp.codex | model:codex |

### 模型（2）

| id | name | runtime | enabled |
| --- | --- | --- | --- |
| model:claude | Claude Code（本地 ACP） | acp.claude | 1 |
| model:codex | Codex（本地 ACP） | acp.codex | 1 |

### 提示词（4）

| id | group | name |
| --- | --- | --- |
| prompt:analyze-root-cause | 分析 | 根因分析 |
| prompt:decide-risk | 决策 | 风险分级 |
| prompt:fix-by-plan | 执行 | 按方案修复 |
| prompt:review-diff | 审查 | Diff 审查 |

### 记忆（4）

| id | key | enabled |
| --- | --- | --- |
| memory:builtin:external-writes | 外部写操作要先确认 | 1 |
| memory:builtin:say-unsure | 不确定就说不确定 | 1 |
| memory:builtin:secrets | 凭据只用引用 | 1 |
| memory:builtin:small-steps | 小步可验证 | 1 |

