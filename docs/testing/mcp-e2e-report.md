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
| 目标仓库    | `HuLuca1998/aiwf-e2e-fixture`（真实仓库，真实 issue）                    |

工作区是全新的，只有迁移种下的内置数据：2 个模型、4 个 Agent 角色、
4 条提示词、4 条记忆。

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
6. `workflow_patch` 修、重新发布、重跑 —— 自主循环了 4 轮

第 5 轮它甚至**自己往图里插了一个新节点**（`clone_repo`）并重新接线：
断开 `analyze→worktree`，改成 `analyze→clone_repo→worktree`。
没人告诉它要加这个节点。

## 抓到的真问题（都已修复）

这一轮的价值主要在这里 —— 三个只有真跑才会暴露的问题：

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

修复：相对路径按运行工作目录算；绝对路径不变，单独一条测试压着。

### 3. AI 节点根本没读 Agent 角色

不是这一轮抓到的，是为这一轮做准备时发现的：`run_ai` 只读
`instruction` 与 `runtime`，用户在「Agent 角色」屏上填的目标、人设、
输出契约、能力，一个字都没到过模型面前。

症状不是报错，是「界面上摆着一排设置，改了没有任何区别」，
而执行记录里那句「用了哪个模型」也无从谈起。

修复见 `bef2884`：角色进提示词、能力由引擎强制、
每个 AI 节点写一条 `system.model_resolved`。

## 数据完整性

`node scripts/dump-run.mjs <db>` 出的报告逐项核对：

- **seq 连续无缺口** —— `(run_id, seq)` 由存储分配
- **每个 `node.started` 都有配对的结束事件**
- **生命周期齐全**：`run.created → preflight_passed → queued → started → …`
- **可解释性证据在事件流里**，不在别处：
  - `system.memory_injected`：注入了哪 4 条记忆，按 key 列出
  - `system.model_resolved`：这一步用了哪个角色、哪个模型、哪个 runtime
- **产物落 artifacts/，事件里只留摘要**

`system.model_resolved` 写在**执行之前**：AI 节点连 adapter 可能挂上
好几分钟，而排查「它卡在哪」的第一个问题就是「它到底想连哪个」。
