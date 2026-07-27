# 端到端测试

单元测试测「这段代码对不对」，端到端测「装好的应用真能干活吗」。
两者抓到的问题不一样 —— 下面六个缺陷全是端到端跑出来的，
当时单元测试全绿。

## 怎么跑

```bash
# 1. 起开发用的 HTTP 桥接（复用桌面版同一套 core-api）
pnpm dev:server -- --port 5177 --db /tmp/aiwf-e2e/aiwf.sqlite

# 2. API 层：60 项断言，含真实脚本执行、审批、并行、取消、真实 git worktree
python3 tests/e2e/api_e2e.py --workdir /tmp/aiwf-e2e/runs
python3 tests/e2e/api_e2e.py --workdir /tmp/aiwf-e2e/runs --repo /path/to/git/repo

# 3. 真实 GitHub 全流程：读 Issue → worktree → 改代码 → 推分支 → 开 PR
python3 tests/e2e/github_scenario.py --repo /path/to/repo --issue 1

# 4. 浏览器层：16 条用例，真实点击 → 真实引擎
VITE_AIWF_SERVER=http://127.0.0.1:5177 pnpm dev    # 另开一个终端
pnpm test:e2e
```

## 为什么要有这一层

桌面壳跑在 WKWebView 里，浏览器工具驱动不了它。
`aiwf-devserver` 把同一套 `aiwf-core-api` 用 HTTP 暴露出来，
浏览器就能操作真实引擎 —— 测的是桌面版跑的那套逻辑，不是替身。

**只用于本地开发与测试**：无鉴权、只绑 127.0.0.1。
生产的 Web 形态（M6）走 tRPC + SSE + 会话鉴权。

## 端到端抓到的缺陷

| #   | 缺陷                       | 症状                         | 为什么单元测试没抓到                                  |
| --- | -------------------------- | ---------------------------- | ----------------------------------------------------- |
| 1   | 失败的脚本不留日志产物     | 脚本失败时看不到 stderr      | 产物测试只覆盖成功路径                                |
| 2   | 并发写事件 seq 冲突        | 取消运行时偶发「数据库错误」 | 单元测试是单线程的，竞态窗口不存在                    |
| 3   | 终态被推进覆盖回 running   | 取消后运行停不下来           | 要「取消恰好发生在节点开始前」的时序，8 轮里出现 1 次 |
| 4   | 界面用了自造的 runtime 值  | 保存模型没反应               | 组件测试 mock 掉 coreClient，连 Zod 校验一起绕过了    |
| 5   | Rust 的 None 序列化成 null | 整页「返回值不合契约」       | 契约里 `.optional()` 只接受字段缺席，不接受 null      |
| 6   | 事件被重复渲染             | 同一条事件显示两遍           | `select()` 与轮询并发拉同一个 fromSeq                 |

还有两个可用性问题：
默认工作目录带 `~` 且不展开、引擎自己的运行目录不存在却报错 ——
都会让用户「打开启动表单什么都不改就无法运行」。

## 这些缺陷带来的守卫

修 bug 之外，每一类都留了防止复发的机制：

| 守卫             | 位置                                        | 防的是                              |
| ---------------- | ------------------------------------------- | ----------------------------------- |
| 契约校验替身     | `apps/web/tests/_contractClient.ts`         | #4：mock 绕过 Zod                   |
| Option 字段检查  | `crates/core-api/tests/parity_test.rs`      | #5：新 DTO 漏 `skip_serializing_if` |
| 两端命令表一致   | 同上                                        | 漏注册命令（不会编译报错）          |
| 接入方式枚举同步 | `crates/engine/tests/contract_sync_test.rs` | Rust 侧枚举脱离契约                 |
| 并发写事件       | `crates/store/tests/store_test.rs`          | #2：4 线程 × 25 条，断言 seq 无缺口 |
| 终态不可覆盖     | 同上                                        | #3                                  |
| 事件去重         | `apps/web/tests/runs-store.test.ts`         | #6                                  |

## 真实 GitHub 场景

`tests/e2e/github_scenario.py` 是图纸「GitHub Issue 修复」那条主线的可执行版本：
AI 节点（分析 / 执行 / 审查 / 决策）留给 M3，其余每一步都是真的 ——
真调 gh 读 Issue、真建 worktree、真改代码、真推分支、真开 PR。

它验证的几件事单靠单元测试证明不了：

- **审批前外部世界没被动过**：主仓库工作区干净，远端还没有这个分支
- **批准后才发生外部写操作**：分支推上去、PR 开出来
- **每个节点都留下 succeeded 事件**：8 个节点全在事件流里
- **跑完自己收拾干净**：关 PR、删远端分支、移除 worktree

需要 gh 已登录且对目标仓库有写权限。测试用的夹具仓库是
`HuLuca1998/aiwf-e2e-fixture`（私有），里面留了一个可复现的缓存失效缺陷。

## 测试数据

跑测试会在 `--workdir` 下留下真实的运行目录、产物与 SQLite 库，
`--repo` 指向的仓库里会真的建 worktree 和分支（用完自动清理）。
这些数据保留着，出问题时可以直接翻。
