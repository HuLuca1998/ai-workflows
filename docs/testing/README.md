# 端到端测试

单元测试与集成测试测的是「这段代码对不对」，这里测的是
「装好的应用真的能干活吗」。两者抓到的问题不一样 ——
下面三个缺陷全是端到端跑出来的，单元测试当时全绿。

## 怎么跑

```bash
# 1. 起开发用的 HTTP 桥接（复用桌面版同一套 core-api）
pnpm dev:server -- --port 5177 --db /tmp/aiwf-test-data/aiwf.sqlite

# 2. API 层端到端：59 项断言，含真实脚本执行、审批、并行、取消
python3 tests/e2e/api_e2e.py --workdir /tmp/aiwf-e2e-runs

# 带真实 git 仓库跑 worktree 那一组
python3 tests/e2e/api_e2e.py --workdir /tmp/aiwf-e2e-runs --repo /path/to/repo

# 3. 浏览器端到端（真实点击）
pnpm dev:full          # 另开一个终端：web + devserver
pnpm test:e2e
```

## 为什么要有这一层

桌面壳跑在 WKWebView 里，浏览器工具驱动不了它。
`aiwf-devserver` 把同一套 `aiwf-core-api` 用 HTTP 暴露出来，
浏览器就能操作真实引擎 —— 测的是桌面版跑的那套逻辑，不是替身。

`crates/core-api/tests/parity_test.rs` 守住两端命令表一致：
漏注册一个命令不会编译报错，症状是「桌面版好用、Web 版某个按钮没反应」。

## 端到端抓到的缺陷

| 缺陷 | 症状 | 为什么单元测试没抓到 |
| ---- | ---- | -------------------- |
| 失败的脚本不留日志产物 | 脚本失败时看不到 stderr | 产物测试只覆盖了成功路径 |
| 并发写事件 seq 冲突 | 取消运行时偶发「数据库错误」 | 单元测试是单线程的，竞态窗口不存在 |
| 终态被推进覆盖回 running | 取消后运行停不下来 | 需要「取消恰好发生在节点开始前」的时序 |

后两个都只在**真并发**下出现，而且第三个要连跑几轮才碰得到一次
（8 轮里出现 1 次）。这就是循环跑的意义。
