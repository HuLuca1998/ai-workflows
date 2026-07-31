# 跨 runtime 抽象层：差异清单与接口设计

**结论先说**：ACP 的**协议**是一致的，两个 runtime 的**语义**不一致。
一致的部分不需要抽象；不一致的部分**必须**抽象，否则同一份代码在两端
是两种行为——而且不报错。

数据来源：2026-07-31 对 `claude-agent-acp 0.63.0` 与 `codex-acp 1.1.7`
各跑一遍探针，往返记录在 [transcripts/](transcripts/README.md)。

> 为什么这次跑了 claude —— CLAUDE.md 的规矩是「测试与试验优先 codex」，
> 理由是嵌套会话 / 登录态 / 配额会与开发环境撞车。这次跑它是因为
> **「协议是否一致」这个问题不跑两端就答不了**，而
> [03-pitfalls #1](03-pitfalls.md) 的 `envRemove` 已经解决了嵌套问题
> （探针照做了）。日常测试仍然一律用 codex。

---

## 一、一致的部分（不需要抽象）

这些两端逐字相同，可以直接依赖：

| | 两端一致的值 |
|---|---|
| `protocolVersion` | `1` |
| 传输 | JSON-RPC 2.0 over stdio，ndjson |
| 核心方法 | `initialize` / `session/new` / `session/prompt` / `session/cancel` / `session/load` |
| `loadSession` capability | `true` |
| `promptCapabilities` | `image: true`、`embeddedContext: true` |
| `auth.logout` | 都声明 |
| 反向调用 | 都只用 `session/request_permission`（本仓库未声明 fs / terminal） |
| **多轮上下文** | **都自带**：第二轮只发用户原话，暗号与长度约束都还记得 |
| `stopReason` | `end_turn` / `cancelled` 语义相同 |
| `session/list` `set_mode` `close` `resume` | 都可用 |

**最要紧的一致**：`multi-turn` 场景在两端结论相同——
[06 规则 1、2](06-repo-rules.md)（一条对话一条会话、系统提示词只发一次）
**不是 codex 特有的做法，是可以放心依赖的协议行为**。

---

## 二、不一致的部分（必须抽象）

### 差异 1 · 权限档的语义完全不同 ⚠️ 最危险

| | claude 0.63.0 | codex 1.1.7 |
|---|---|---|
| 可选档 | `auto` / `default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`（6） | `read-only` / `agent` / `agent-full-access`（3） |
| **默认档** | **`default`** —— 危险操作会问 | **`agent`** —— 读写文件、跑命令，**不问** |
| 默认档下建一个文件 | **请求权限 1 次**，拒绝后文件没建 ✅ | **请求权限 0 次**，文件直接建了 ❌ |

**同一份客户端裁决代码，在 claude 上是一道真防线，在 codex 上完全没被调用过。**

这条差异解释了一件事：如果有人只用 claude 测过权限，会看到一切正常。
而本仓库的首选 runtime 是 codex（`preferred_acp_runtime()`），
**部署时跑在没有防线的那一侧**（[07 H-6](07-violations.md)）。

档位名**没有任何交集**，硬编码任何一个都会在另一端静默失效。

### 差异 2 · 模型清单在两个不同的地方

| | claude | codex |
|---|---|---|
| `session/new` 顶层有 `models` | ❌ **没有** | ✅ 有，25 个 |
| `configOptions` 里有 `model` 项 | ✅ 有（`default` / `opus[1m]` / `claude-fable-5[1m]` / `sonnet` / `haiku`） | ✅ 有（5 个模型族） |

只读 `models` 的实现，在 claude 上会拿到空清单；
只读 `configOptions` 的实现，在 codex 上会丢掉「模型 × 推理强度」的组合
（codex 的 `models.availableModels` 是二者的笛卡尔积，如 `gpt-5.6-sol[high]`）。

**但真要取清单，答案是只读 `configOptions`** —— 见下面差异 3 的
`category`：它把「模型」与「强度」拆成两个正交的维度，而 `models`
给的是二者的笛卡尔积。要在界面上做成两个下拉（模型一个、强度一个，
Claude Code 自己的输入框底部就是这么做的），正交的那份才是对的形状；
笛卡尔积那份 25 条平铺在一个下拉里，反而要再拆一次。

### 差异 3 · configOption 的 id 不一样 —— 但 `category` 一样

| 概念 | claude 的 `id` | codex 的 `id` | 两端的 `category` |
|---|---|---|---|
| 权限档 | `mode` | `mode` | `mode` ✅ |
| 模型 | `model` | `model` | `model` ✅ |
| **推理强度** | **`effort`** | **`reasoning_effort`** | **`thought_level`** ✅ |
| **快速模式** | **`fast`** | **`fast-mode`** | — |
| 规划模式 | （在 `mode` 里，`plan` 档） | **`collaboration_mode`**（`default` / `plan`） | — |
| 子 agent | **`agent`** | — | — |

**别按 `id` 建映射表 —— 按 `category` 取。** 我们真正要的三项
（权限档 / 模型 / 推理强度）在两端的 `category` 上完全一致，
`id` 的差异按 category 取就自动吃掉了；而映射表是要跟着
adapter 版本维护的，漏一条就是静默失效。

```rust
// ✓ 两端通用，新 runtime 接进来也不用改
fn by_category<'a>(session: &'a Value, category: &str) -> Option<&'a Value> {
    session.get("configOptions")?.as_array()?
        .iter().find(|o| o["category"] == category)
}
```

**「规划模式」这一项尤其阴险**：claude 把它做成一个权限档（`mode=plan`），
codex 做成一个独立配置项（`collaboration_mode=plan`）。
同一个用户意图，两端要走两条不同的路。这一项没有共同的 `category`，
是真的要分支 —— 与上面三项不同。

### 差异 4 · usage 字段集不同，`cost` 只有一端有

| 字段 | claude | codex |
|---|---|---|
| `inputTokens` / `outputTokens` / `cachedReadTokens` / `totalTokens` | ✅ | ✅ |
| `cachedWriteTokens` | ✅ | ❌ |
| `thoughtTokens` | ❌ | ✅ |
| **`cost`**（`{amount, currency}`） | ✅ **在 `usage_update` 通知里** | ❌ **完全没有** |

claude 实测：`{"used":28715,"size":1000000,"cost":{"amount":0.157499,"currency":"USD"}}`。

所以「显示这次花了多少钱」**只能对 claude 做**。对 codex 要么不显示，
要么自己按价目表估——**别让界面在两端说不一样可信度的话**。

### 差异 5 · 能力清单的细微出入

| | claude | codex |
|---|---|---|
| `sessionCapabilities` | + **`fork`** | 无 fork |
| `mcpCapabilities.sse` | **`true`** | `false` |
| `mcpCapabilities.acp` | 未声明 | `false` |
| `authMethods`（已登录时） | `[]` | `[api-key, chat-gpt]` |
| `_meta` 位置 | `agentCapabilities._meta.claudeCode.promptQueueing` | 顶层 `_meta.steering.supported` |

**注意 `sessionCapabilities` 的子项是空对象 `{}` 而不是布尔**：

```rust
// ✗ 永远是 false —— 值是 {}，不是 true
caps["sessionCapabilities"]["close"].as_bool().unwrap_or(false)
// ✓ 判键存不存在
caps["sessionCapabilities"].get("close").is_some()
```

### 差异 6 · 事件流的丰俭

| 事件 | claude | codex |
|---|---|---|
| `agent_thought_chunk` | 这批场景里 **0 次** | 14 次 |
| `session_info_update` | 1 次 | 35 次 |
| `usage_update` | 22 次（**带 cost**） | 18 次 |

界面不能假设「一定会有思考过程」——那样在 claude 上会留一块永远空着的区域。

### 差异 7 · `session/list` 的规模差了 30 倍

| | claude | codex |
|---|---|---|
| 返回条数 | **766** | 25 |
| 每条字段 | `sessionId` / `cwd` / `updatedAt`（**无 title**） | `sessionId` / `cwd` / `title` / `updatedAt` |

两端都返回**本机全部会话、跨项目**。claude 不带 title 所以泄漏面小一些，
但 `cwd` 同样暴露用户在做什么项目。
用它必须按 cwd 过滤 + 分页（[06 规则 22](06-repo-rules.md)）。

---

## 三、抽象层设计

### 分层

```
        应用概念（permissionPreset / 模型 / 成本）
                    ↑ 只认这一层
        ┌───────────────────────────────┐
        │   RuntimeProfile（本页的产出）  │  ← 差异吃在这里
        └───────────────────────────────┘
                    ↑ 统一的 ACP 调用
        AcpClient（acp.rs，协议本身，两端通用）
                    ↑ JSON-RPC over stdio
        claude-agent-acp        codex-acp
```

**上层永远不该出现 `"read-only"` 或 `"acceptEdits"` 这样的字面量。**
出现了就说明差异漏到了上层。

### 接口草案（Rust）

> 设计草案，**尚未实现**。落地时对照 [07-violations](07-violations.md)
> 的 H-6 / H-8 / O-1 一起做。

```rust
/// 一个 runtime 的语义画像。差异全部收敛在这里。
pub struct RuntimeProfile {
    pub runtime: &'static str,          // "acp.claude" / "acp.codex"
    /// 应用的三档权限 → 这个 runtime 的 modeId
    mode_map: fn(Preset) -> &'static str,
    /// 推理强度这类配置项在这个 runtime 叫什么
    config_ids: ConfigIds,
    /// 这个 runtime 报不报成本
    pub reports_cost: bool,
}

pub struct ConfigIds {
    pub mode: &'static str,             // 两端都是 "mode"
    pub model: &'static str,            // 两端都是 "model"
    pub effort: &'static str,           // claude "effort" / codex "reasoning_effort"
    pub fast: &'static str,             // claude "fast"   / codex "fast-mode"
    pub plan_mode: PlanMode,            // claude 是一个档，codex 是独立配置项
}

pub enum PlanMode {
    /// claude：切到 mode=plan
    ViaMode(&'static str),
    /// codex：设 collaboration_mode=plan
    ViaConfig { id: &'static str, value: &'static str },
}
```

**档位映射表**——这张表是整个抽象层的核心，它把
「用户在设置页选的那一档」翻译成两个 runtime 各自认的字符串：

> **2026-07-31 的产品决定改了这张表**：不再对单个节点设权限门槛，
> ACP 一律按最高档跑。**执法层挪到了工作流编排上**——
> 审批节点就是门禁，位置由设计者定（比如「编码完成后、开 PR 前」），
> 谁来批可配（人批或 AI 批），判定按操作实际风险而不是节点类型。
> 详见 [07 H-6](07-violations.md)。
>
> 所以现在这张表**每一档都映射到最高**：
>
> | 应用的 `permissionPreset` | claude modeId | codex modeId |
> |---|---|---|
> | 全部三档 | `bypassPermissions` | `agent-full-access` |
>
> **但映射表这个结构要留着。** 一是这个决定将来可能变（多用户、
> 团队版、跑别人的工作流时），二是**档位仍然要显式设**——
> 见下面第 3 条。

映射表原本的设计（保留，供将来需要分档时参考）：

| 应用的 `permissionPreset` | claude modeId | codex modeId | 语义 |
|---|---|---|---|
| （默认 / 认不出的档） | `plan` | `read-only` | 只读，任何写操作都要问 |
| `workspace_safe` | `default` | `read-only` | 危险操作逐项确认 |
| `trusted_workflow` | `acceptEdits` | `agent` | 自动接受编辑，仍拦危险操作 |
| 最高档 | `bypassPermissions` | `agent-full-access` | 跳过一切检查 |

三条设计决定：

1. **认不出的档按最严处理**——与 `crates/mcp/src/catalog.rs` 的
   `gate_for` 同一条规则。**这条只在分档时适用**；
   当前决定下认不出的档也走最高，那就要在代码里写明白是故意的；
2. 分档时**最高档不该由一个下拉框就能选到**——
   真要开就让它是显式的、说清楚后果的决定。
   当前决定等于「全局开了它」，那就更要满足第 3 条与事件流那条前提；
3. **`session/new` 之后必须立刻 `set_mode`，哪怕算出来的档等于
   runtime 默认档**——这条在任何决定下都成立。
   codex 的默认档是 `agent`，claude 是 `default`，**两端不一样**；
   而且这个默认值**会漂移**（codex 0.16 → 1.1.7 已经改过一次）。
   不显式设，「我们要什么权限」这件事在代码里就没有任何一行表达过。

### 统一的模型清单与模型设置

**读清单：只读 `configOptions`，按 `category` 取。**

```rust
/// 两端同构：模型与强度是两个正交维度，各自一个 select。
pub fn model_choices(session: &Value) -> (Vec<Choice>, Vec<Choice>) {
    (
        by_category(session, "model").map(parse_options).unwrap_or_default(),
        by_category(session, "thought_level").map(parse_options).unwrap_or_default(),
    )
}
```

不走 `models.availableModels`：它只有 codex 有，而且是二者的笛卡尔积
（25 条 = 5 模型 × 5 强度），拿来做界面还要再拆一次。

**写设置：`session/new` 之后调 `session/set_config_option`。**

三件事是实测出来的（`transcripts/{codex,claude}-model.jsonl`）：

| | 实测结果 |
|---|---|
| `session/new` 的 params 里带 `model` | **两端都静默忽略**：不报错、不采纳。照直觉这么实现，测试全绿而模型从没被切过 |
| 参数名 | **`configId`**，不是 `optionId`。写错时报 `configId: expected string, received undefined` |
| 响应 | **回全量 `configOptions`** —— 设了是否生效当场能回读，不必再查一次 |
| 设一个不存在的值 | 两端都拒（codex `-32602`，claude `-32603`）。**校验不必我们自己做，agent 就是校验器** |
| `session/set_model` | codex 有、claude `Method not found`。**且与 `set_config_option` 写同一个状态，后调的覆盖先调的** —— 用不得 |

最后一条是这个探针自己踩出来的：先 `set_config_option(model=terra)`
回读也是 terra，中间又调了一次 `set_model(availableModels[0])`，
真跑一轮时 agent 报的是 `sol`。两个方法不是互补的，是同一个开关的两个把手。

### 「它到底用了哪个模型」——两端拿不到同一种证据

| | codex | claude |
|---|---|---|
| prompt 响应里 `_meta.quota.model_usage[].model` | ✅ **直接报模型名** | ❌ **没有这个字段** |
| `usage_update.size` | 会话水位（`258400`） | 模型上下文窗口（`1000000` / `200000`） |

**别拿 `model_usage` 当跨端方案** —— 它是 codex 私有的，claude 侧照做会写出一条空事件。
`usage_update.size` 也合不了：两端语义根本不同（水位 vs 窗口大小）。

两端唯一都成立的证据是 **`set_config_option` 响应里回读到的 `currentValue`**。
`system.model_resolved` 该写这个值：它是「我们设进去并被 agent 确认过的」，
而不是「数据库里登记的字符串」。

### 统一的 usage

```rust
pub struct TurnUsage {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_read_tokens: u64,
    /// claude 有、codex 没有
    pub cached_write_tokens: Option<u64>,
    /// codex 有、claude 没有
    pub thought_tokens: Option<u64>,
    /// **只有 claude 报**。None 表示「这个 runtime 不报成本」，
    /// 不是「这次没花钱」—— 界面上必须分得开
    pub cost_usd: Option<f64>,
    /// 上下文水位，来自 usage_update 通知（两端都有）
    pub context_used: Option<u64>,
    pub context_size: Option<u64>,
}
```

`Option` 在这里不是「可能忘了填」，是**「这个 runtime 结构性地没有」**。
界面拿到 `None` 要显示「该 runtime 不提供」，而不是 `$0.00`。

### 能力探测

```rust
/// sessionCapabilities 的子项是空对象，判存在性而不是布尔。
pub fn supports(caps: &Value, group: &str, key: &str) -> bool {
    caps.get(group).and_then(|g| g.get(key)).is_some()
}
// supports(caps, "sessionCapabilities", "close")  → 两端都 true
// supports(caps, "sessionCapabilities", "fork")   → claude true / codex false
```

---

## 四、落地顺序

抽象层不必一次做完。按「不做会出事」排：

| 顺序 | 做什么 | 为什么排这里 |
|---|---|---|
| 1 | **档位映射 + `session/new` 后强制 `set_mode`** | 差异 1 是安全问题，而且现在跑在没防线的那侧（[07 H-6](07-violations.md)） |
| 2 | 能力探测改成判键存在性 | 一行的事，现在的写法在两端都返回 false |
| 3 | 统一模型清单 + `set_config_option` | [07 H-8](07-violations.md) 的正解。**清单与写入是一件事**，只做清单等于下拉换了数据源而仍然不生效 |
| 4 | 统一 usage（含 `cost: Option`） | [07 O-1](07-violations.md)，数据已经在手上 |
| ~~5~~ | ~~configOption id 映射~~ | **不用做**：按 `category` 取就吃掉了 id 差异（差异 3） |

**每一步都要在两个 runtime 上各跑一遍探针**，别只测 codex——
这一整页的差异，就是只测一端发现不了的那些。

---

## 五、复验

```bash
# 两端各跑一遍，对比 handshake 与 session/new
for rt in codex claude; do
  PATH="$PWD/node_modules/.bin:$PATH" \
    node docs/acp/reference/transcript-probe.mjs handshake --agent $rt
done
```

版本变了就重跑这一页的所有结论。**codex 的档位名在 0.16 → 1.1.7
之间已经改过一次**（`auto` → `agent`），
说明这些语义差异是会漂移的（[02 §6](02-runtime-findings.md) 的修正）。
