# B2 引擎与存储审查 · 第 5 轮（**部分覆盖**）

> ⚠️ **这份报告不完整。** 原本派出的 B2 子代理在写报告前
> 因 API 中断（`Response stalled mid-stream`）失败，没有留下任何产出。
> 下面是由主会话**补做的核心项**，只覆盖 E1（错误处理）与 E11（测试质量）的一部分。
> **E2 并发与锁、E3 调度、E5 脚本节点、E6 worktree、E7 审批检查点、E8 存储层
> 全部没做** —— 那是 B2 剧本里分量最重的几项，需要单独补一轮。

- 日期：2026-07-28
- 基线：`04ec7a1`（Rust 侧无未提交改动）
- 门禁：`pnpm rs:test` 161 项全绿、clippy -D warnings 通过（由发起方跑过）
- 方式：静态 grep + 读代码。**没有实测并发**，本报告不含任何并发结论

---

## 结论

| 指标         | 数                      |
| ------------ | ----------------------- |
| 做了的检查项 | 2（E1 部分 / E11 部分） |
| 缺陷         | 1                       |
| 观察         | 3                       |

---

## 缺陷

### B2-1【高】主管 AI 的三次写库全部「失败也不管」，接口照常返回成功

**位置**：`crates/core-api/src/lib.rs:1636-1650`

```rust
store
    .create_supervisor_session(&question, workflow_id.as_deref(), None)
    .ok()                                                    // ← 建会话失败 → None，静默
});

if let Some(id) = &session {
    let _ = store.append_supervisor_message(id, "user", &question);   // ← 失败不管
    let _ = store.append_supervisor_message(id, "agent", &text);      // ← 失败不管
}

Ok(SupervisorAnswer { text, tool_calls, proposal, session_id: session })
                                                             // ← 无论如何都返回成功
```

**坏法**：磁盘满、库被锁、写入约束冲突——任何一种情况下：

1. 界面上 AI **照常回答**，用户以为一切正常
2. 但这轮对话**没有进历史**（或只进了一半：会话建了、消息没进）
3. **没有任何报错**，用户下次回来打开历史会话，发现对话不见了或缺一半
4. `session_id` 仍然返回给前端，前端下一问会带着这个 id 续接——
   续接到一条内容不全的会话上

这正好踩中主管 AI 那句产品承诺的反面：
「你问的每一句都会存下来，隔天回来还能接着问」（历史会话空态文案）。

**与 B1 的 D3 是同一段代码的两面**：D3 说这个声明 `mutates: false` 的方法
其实写了三次库；这里说那三次写入**失败了也没人知道**。

**建议方向**（需确认）：至少把失败记进日志；或者在返回值里带一个
「这轮没能存下来」的标记，让界面能提示用户。

---

## 观察

### O1 · 生产代码里 `unwrap` / `expect` / `panic` 确实是 0 处

```
grep -rn "\.unwrap()\|\.expect(\|panic!\|unreachable!\|todo!" crates/*/src/*.rs | wc -l
→ 0
```

CLAUDE.md 那条纪律（生产代码不用这些）**是真的在执行**。

### O2 · 23 处 `let _ = `，多数可接受，两处在生产路径上

| 位置                                   | 内容                              | 判断                               |
| -------------------------------------- | --------------------------------- | ---------------------------------- |
| `core-api/lib.rs:1641,1642`            | 主管 AI 消息写入                  | **缺陷 B2-1**                      |
| `core-api/lib.rs:51`                   | `create_dir_all` 默认工作目录     | 可接受（后续操作会自己失败并报错） |
| `devserver/main.rs:32,105,137,145,166` | 建目录 / join / respond / 读 body | devserver 是开发工具，优先级低     |

`devserver/main.rs:145` 的 `read_to_string` 失败不管值得单独一提：
body 读失败时会被当成空 body 继续处理。这是测试工具，不影响产品，
但会让自动化测试遇到诡异的「参数缺失」而不是「读取失败」。

### O3 · 23 处 `unwrap_or_default()`

没有逐个判断「这里该不该有默认值」——**这项没做完**，
需要 B2 补一轮时逐处过。

### O4 · 测试的失败路径覆盖整体扎实

| 测试文件                       | 用例数 | 失败路径提及 |
| ------------------------------ | ------ | ------------ |
| `store/tests/store_test.rs`    | 161    | 104          |
| `engine/tests/executor_test`   | 36     | 35           |
| `engine/tests/artifacts_test`  | 22     | 14           |
| `engine/tests/path_guard_test` | 17     | **40**       |
| `engine/tests/runner_test`     | 15     | 23           |
| `engine/tests/acp_test`        | 13     | 31           |
| `engine/tests/exec_test`       | 12     | 28           |
| `engine/tests/worktree_test`   | 11     | 25           |

`path_guard_test` 17 个用例里有 40 处失败路径关键词——符合
TESTING.md「每种绕过方式都要有一条用例」的要求。
`redactor_test` 13 用例但只有 3 处提及，**值得 B2 补一轮时细看**
（脱敏的形态覆盖够不够，是 B3 关心的事）。

---

## 没做的（B2 剧本的大头）

| 项                                             | 为什么重要                                       |
| ---------------------------------------------- | ------------------------------------------------ |
| E2 并发与锁                                    | 锁的粒度、持锁期间的 I/O、busy_timeout、取消时机 |
| E3 执行计划与调度                              | 四种汇聚策略、quorum 边界、孤立节点              |
| E5 脚本节点                                    | 真超时、并发读、1MB 上限、孤儿进程               |
| E6 Git worktree                                | **这块出错会动用户的仓库，最危险**               |
| E7 审批与检查点                                | 检查点与状态更新是否同一事务                     |
| E8 存储层                                      | seq 并发唯一性、索引、事务边界、FTS5 中文        |
| E12 可读性（2870 行 store / 2208 行 core-api） | 拆分建议                                         |

**建议**：下一轮单独补一次完整的 B2，尤其 E2 与 E6。
