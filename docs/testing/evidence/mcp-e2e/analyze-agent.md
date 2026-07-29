<!-- 运行 run_18c6a6bb11d596f0 · 节点 analyze · 由引擎落成产物 analyze/agent.md，原样留档 -->

我会按 `issue` skill 的只读分析流程处理：先识别当前仓库与上游 Issue，再核对相关代码和历史证据；这一轮只给根因与方案，不改代码、不更新 Issue 状态。若本地没有 Issue 编号或上游访问证据，我会明确列出缺失信息。当前证据显示工作目录是空的，而且不是 Git 仓库；因此无法从 `origin` 自动确定“上游 Issue”，也没有本地代码可交叉验证根因。我会再检查本次运行目录的元数据和相邻文件，确认是否只是仓库尚未落到当前路径。不会据此猜 Issue 或仓库。已找到上游定位信息：Issue `HuLuca1998/aiwf-e2e-fixture#1`，标题为“配置热重载后旧值仍然生效”。Issue 里的“TTL 缓存未清空”目前只是报告者判断，不足以直接当根因；下一步要读取仓库实现、测试与提交历史，验证 watcher、快照和缓存之间的真实调用链。GitHub 的补充只读请求未获授权，所以我不会继续访问外部 API。现有 Issue 正文已经完整保存在本次任务产物中；为补足代码证据，我会检查同一工作区内已存在的只读仓库副本，并明确记录它的 remote、分支与 commit。若无法证明副本对应当前上游版本，最终结论会标为不确定。调用链已经能闭环：`getConfig` 在 60 秒 TTL 内直接返回 `Map` 里的对象；`onFileChanged` 虽然调用了 `readFromDisk`，却既不删除旧 entry，也不把新结果写回缓存。需要注意一个证据边界：当前仓库是刻意简化的 E2E fixture，`readFromDisk` 并未真实读文件，只返回时间戳，因此可以验证“缓存失效缺陷”，不能验证真实文件 watcher 的时序与 I/O 错误处理。现在我会用确定性时钟复现实测这一点。根因说明：上游 [Issue #1 原文](/private/tmp/claude-501/-Users-luca-work-ai-workflows/25d68c60-d98e-498a-be30-ac84bca58783/scratchpad/e2e/runs/run-1785297624/.aiwf-artifacts/run_18c6a6bb11d596f0/read_issue/stdout.log:1) 的现象与本地 commit `4997c86` 一致。[src/cache.js](/private/tmp/claude-501/-Users-luca-work-ai-workflows/25d68c60-d98e-498a-be30-ac84bca58783/scratchpad/e2e/runs/run-1785293475521-0000/repo/src/cache.js:5) 中，`getConfig` 在 60 秒 TTL 内直接返回缓存；`onFileChanged`（第 14–16 行）只调用 `readFromDisk`，既不删除旧 entry，也不将返回值写回，因此热重载后仍返回原对象。确定性时钟实测显示：文件变更后、TTL 内两次读取对象相同，只有 TTL 到期才刷新。触发条件是“该 key 已缓存，并在缓存写入后 60 秒内发生热重载”；陈旧值最多持续剩余 TTL。

不确定项：仓库是简化的 E2E fixture，`readFromDisk` 没有真实文件 I/O，仓库也没有测试设施；Issue 所说的“更新磁盘快照”无法从当前实现证实。此外，GitHub 补充访问未获授权，因此无法确认远端是否在本地 commit 之后又有更新。

方案清单（按改动面与风险排序）：

1. 按 key 删除缓存，推荐

   - 改动点：在 `onFileChanged(key)` 中执行 `cache.delete(key)`；当前无副作用的 `readFromDisk(key)` 可删除。下一次 `getConfig` 再读取并缓存新值。
   - 风险：首次读取成本转移到下一次业务请求；若真实读取可能失败，需要明确失败行为。真实 watcher 是否存在异步写入竞争，当前 fixture 无法验证。
   - 怎么验证：增加测试覆盖“变更后 TTL 内立即得到新对象”“其他 key 的缓存不受影响”“连续变更不会恢复旧值”“未变更时仍复用 TTL 缓存”。改后运行 `node --test`。
   - 改动量：约 1–2 行。

2. watcher 收到事件后主动刷新缓存

   - 改动点：`onFileChanged` 读取新值，并用新的时间戳执行 `cache.set(key, ...)`。
   - 风险：文件读取进入 watcher 热路径；短时间大量事件会重复读取。真实 I/O 失败、事件乱序时，需要决定保留旧值、删除缓存还是传播错误，改动和测试面更大。
   - 怎么验证：除方案 1 的用例外，验证“刷新后下一次调用不再读盘”“多次事件最终保留最后一次值”“读取失败后的缓存状态符合约定”。
   - 改动量：约 3–8 行，若补错误策略会更多。

建议采用方案 1：它直接修复失效契约，改动最小，也不把 I/O 和失败处理塞进 watcher。