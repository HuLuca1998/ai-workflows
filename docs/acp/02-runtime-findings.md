# 实测结论：claude 与 codex 的行为差异

数据来源：2026-07-24 的 6 组能力探针，在 `claude-code-acp 0.16.2` /
`codex-acp 0.16.0` / SDK `0.4.5` 上真实运行（会产生真实模型调用）。
探针代码见 [reference/probe.ts](reference/probe.ts)，接新项目后建议先复跑一遍。

> **2026-07-27 在新版本上的复验**（SDK `1.3.0` + `@agentclientprotocol/claude-agent-acp 0.62.0`）：
> 参考实现在新包上编译并端到端跑通，`handshake` / `auth` 结果见下方
> [§8 新版本复验数据](#8-新版本复验数据2026-07-27)。协议层结论未变。
> codex 侧未在新版本复验，接入时请自行跑一遍 `probe.ts --agent codex`。

## 速查表

| 能力 | claude-code | codex | 影响 |
|---|---|---|---|
| `session/load` 恢复 | ✅ 全绿 | ✅ 全绿 | checkpoint/resume 可以依赖它 |
| `request_permission` 触发点 | 文件写入前 | shell 命令前（`kind: execute`） | 执法通道统一，但触发时机不同 |
| reject 是否真生效 | ✅ 文件未创建 | ✅ 命令未执行 | 拒绝是真的，不是摆设 |
| client fs 代理 | ✅ 走 `fs/write_text_file` | ❌ 完全不走，用自带 shell | **codex 的 path guard 没有落点** |
| 无头认证 | 复用本机登录态 | 复用登录态，**也支持 `CODEX_API_KEY` / `OPENAI_API_KEY`** | 批量无头场景 codex 更稳 |
| token / usage 数据 | 旧版❌ → **新版✅ 有完整 usage + cost** | 旧版❌（新版未验） | 新版可做精确预算，见 §5 |
| 权限/沙箱档位 | permission mode 经 session modes 暴露 | sandbox 档位经 session modes 暴露 | 可用 `session/set_mode` 标准化设置 |

## 1. `session/load` 会话恢复——两者全绿

探针做法：建会话 → 让 agent 回一个唯一标记串 → **杀掉进程**（模拟崩溃）→
新进程 `initialize` → `session/load` 同一 sessionId → 检查历史回放 → 再发一个
prompt 让它复述之前的标记。

结论：
- `agentCapabilities.loadSession` 两者均为 `true`；
- load 成功，历史完整回放（`user_message_chunk` 与 `agent_message_chunk` 都有，
  标记串都在）；
- **新 turn 能正确复述标记**，说明上下文是真的恢复了，不是只回放了个日志。

所以崩溃恢复可以依赖 `session/load`，不必每次都从零重建 prompt。前提是你自己
持久化了 `sessionId` 和 `cwd`。

## 2. 权限路由——统一通道成立，但触发点不同

- **claude**：在**写文件前**触发 `request_permission`，选项是
  `allow_always` / `allow_once` / `reject_once`。
- **codex**：在**跑 shell 命令前**触发，`toolCall.kind` 是 `execute`。

两侧 reject 都真实生效（文件确实没被创建 / 命令确实没执行）。

这意味着：把裁决逻辑接到 `requestPermission` 回调上，就得到了一条跨 runtime
统一的逐工具调用执法通道。裁决结果建议全部落事件流做审计。

**但它是协作式执法**：runtime 不主动问就不经过你。所以：

> 权限回调是策略层，不是安全边界。真正的隔离要靠 runtime 自身的沙箱档位
> （claude permission mode / codex sandbox）+ OS 级兜底（容器、独立用户、
> 只读挂载）。

## 3. fs 代理——两个 runtime 行为完全不同 ⚠️

探针做法：声明 client fs capability 并实现 `readTextFile`/`writeTextFile`，
然后让 agent 创建一个文件，观察这次写入走了哪条路。

- **claude**：走 client `fs/write_text_file`。你的进程里有硬落点，
  canonical path guard 能真正拦住工作区外的写入。
- **codex**：`clientFsWriteCalls` 为 **0**，文件却创建了——它用自带 shell 写的，
  完全绕过 fs 代理。

**推论**：如果你的隔离设计依赖"所有文件操作都过我的 path guard"，那么这个假设
对 codex **不成立**。codex 的文件隔离执法点是它的 **sandbox 档位**
（`read-only` / `auto` / `full-access`，经 session modes 设置）+ 权限请求，
再加上事后 diff 审计兜底。

这条是探针最有价值的负面结果——它推翻了一个看起来很合理的架构假设。

## 4. 无头认证——都能复用本机登录态

- 两者都可以直接 `session/new`，不需要 `authenticate` 往返，前提是本机已登录
  （`claude /login` / `codex login`）。
- **claude 必须清除嵌套会话环境变量**（`CLAUDECODE` 等），否则它以为自己跑在
  另一个 agent 内部而拒绝服务。详见 [03-pitfalls #1](03-pitfalls.md)。
- **codex 额外支持纯环境变量认证**（`CODEX_API_KEY` / `OPENAI_API_KEY`），
  不依赖本机登录态。**批量、无人值守、CI 场景优先选 codex**，因为登录态会过期
  而环境变量不会。

## 5. usage / token 数据——旧版没有，**新版有了** ✅ 结论已翻转

**旧版实测（0.16.2 / SDK 0.4.5）**：扫描所有 `session/update` 通知与
`session/prompt` 响应里任何形如 usage/token/cost 的字段，**两个 runtime 都是零命中**。
当时的结论是"ACP 家族无法做 token 预算，只能降级为 turn 数 + 墙钟"。

**新版实测（claude-agent-acp 0.62.0 / SDK 1.3.0，2026-07-27）**：
**已经有了完整计量**，同一个探针命中如下字段：

```jsonc
// session/prompt 的响应里：
"usage": {
  "inputTokens": 2,
  "outputTokens": 4,
  "cachedReadTokens": 15498,
  "cachedWriteTokens": 12973,
  "totalTokens": 28477
}
// session/update 通知流里还带了直接的成本：
"cost": { "amount": 0.137589, "currency": "USD" }
```

**推论（已更新）**：

- **可以做精确 token 预算与成本核算**了，直接读 `PromptResponse.usage`；
- 缓存读写分开计量（`cachedReadTokens` / `cachedWriteTokens`），成本估算要
  区别对待——上例里真实新增 token 只有 6 个，但缓存读了 1.5 万；
- `cost` 是 runtime 直接给的美元金额，不用自己按价目表换算；
- 注意这是 **claude 侧**的实测。codex 侧未在新版本复验，接入前请自己跑
  `probe.ts usage --agent codex` 确认。

如果你被迫用旧版本，降级方案仍然是 turn 数上限 + 墙钟超时。

**方法论提醒**：这条结论在三个月内就翻转了。任何"某能力不支持"的结论都要
标注版本与日期，并在升级后复验——这正是把 `probe.ts` 留在项目里的意义。

## 6. 权限与沙箱档位经标准通道暴露（意外收获）

原本以为要为每个 runtime 写私有配置通道（改配置文件、传特殊参数），实测发现：

- claude 的 permission mode（`default` / `acceptEdits` / `plan` / `dontAsk` /
  `bypassPermissions`）
- codex 的 sandbox 档位（`read-only` / `auto` / `full-access`）

**都作为标准 ACP session modes 返回**（在 `session/new` 的响应 `modes` 字段里），
可以用 `session/set_mode` 切换。

所以权限姿态可以按任务需要标准化设置，不需要碰 runtime 的配置文件。
这大幅简化了 adapter 层。

## 7. 版本对要锁定（小噪音）


实测时 `codex-acp 0.16.0` 与本机 `codex-cli 0.145.0` 存在模型元数据版本错配，
每次回复前会有一行警告：`Model metadata for gpt-5.6-sol not found`。
不影响功能，但说明 **acp 适配器与其背后的 CLI 是两个独立版本，要成对锁定**，
否则升级一边可能出现莫名其妙的行为差异。

---

## 8. 新版本复验数据（2026-07-27）

环境：`@agentclientprotocol/sdk 1.3.0` + `@agentclientprotocol/claude-agent-acp 0.62.0`，
用 [reference/probe.ts](reference/probe.ts) 实跑。

### handshake

```jsonc
{
  "protocolVersion": 1,
  "loadSessionCapability": true,          // 会话恢复仍然可用
  "promptCapabilities": {
    "image": true,                         // 新版支持图片输入
    "embeddedContext": true                // 支持嵌入式上下文
  },
  "authMethods": []                        // 已登录时为空数组，无需 authenticate
}
```

### auth（无头认证 + session modes）

直接 `session/new` 成功，无需 `authenticate`。返回的 `modes.availableModes`
把 claude 的权限档位完整列了出来（这就是 §6 说的"标准通道"）：

| modeId | 名称 | 说明 |
|---|---|---|
| `default` | Default | 标准行为，危险操作会请求许可 |
| `acceptEdits` | Accept Edits | 自动接受文件编辑 |
| `plan` | Plan Mode | 只规划，不实际执行工具 |
| `dontAsk` | Don't Ask | 不请求许可，未预先批准的直接拒绝 |
| `bypassPermissions` | Bypass Permissions | 跳过所有权限检查 |

用 `session/set_mode` 切换即可，无需碰 runtime 配置文件。选型建议：

- 只读分析 → `plan` 或 `default` + `rejectPolicy`
- 常规自动化 → `default` + `allowPolicy`（配隔离 cwd）
- 无人值守批处理 → `acceptEdits`（仍会拦危险操作）
- `bypassPermissions` → 只在完全受控的一次性沙箱容器里用

### usage

见 §5：新版已有完整 token 计量与美元成本。

### 端到端

参考实现（真流式 `runTurn`）在新包上编译通过（TS strict +
`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）并跑通真实对话。
测试是在一个 `CLAUDECODE=1` 的环境里跑的——**这同时验证了 `envRemove`
确实解决了嵌套会话变量问题**（[03-pitfalls #1](03-pitfalls.md)）。
