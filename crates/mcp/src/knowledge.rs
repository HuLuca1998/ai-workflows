//! 系统知识：MCP 的 resources 与 prompts。
//!
//! 工具回答的是「我能做什么」，资源回答的是「这个系统是什么」。
//! 只给工具的话，Agent 得靠工具名去猜节点类型叫什么、端口叫什么、
//! 一条工作流该长什么样 —— 猜出来的图连不上线，它再试一次，
//! 几轮之后开始编造不存在的节点类型。
//!
//! 静态资源来自契约生成物（编译期读进来），动态资源走
//! `aiwf_core_api::dispatch`，与界面读的是同一份数据。

use std::sync::Mutex;

use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::{Value, json};

const META: &str = include_str!("../../../packages/contracts/generated/contracts.meta.json");
const NODE_CATALOG: &str = include_str!("../../../packages/contracts/generated/node-catalog.json");
const NODE_CONFIGS: &str =
    include_str!("../../../packages/contracts/generated/node-configs.schema.json");

#[derive(Debug, Clone)]
pub struct Resource {
    pub uri: &'static str,
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub mime_type: &'static str,
}

/// 全部资源。**顺序即阅读顺序**：Agent 多半从上往下读，
/// 所以「这是什么」在最前，「现在有什么」在最后。
#[must_use]
pub fn resources() -> Vec<Resource> {
    vec![
        Resource {
            uri: "aiwf://guide/overview",
            name: "overview",
            title: "这个系统是什么",
            description: "AI Workflows 的形态、每一屏能干什么、草稿与版本的区别。先读这个。",
            mime_type: "text/markdown",
        },
        Resource {
            uri: "aiwf://guide/build-and-run",
            name: "build-and-run",
            title: "从零设计一条工作流并跑起来",
            description: "按步骤给出该调哪个工具、按什么顺序、每一步要检查什么。",
            mime_type: "text/markdown",
        },
        Resource {
            uri: "aiwf://guide/read-run-data",
            name: "read-run-data",
            title: "怎么读一次运行的完整数据",
            description: "事件流九类事件、节点进度、产物、可解释性证据分别从哪来。",
            mime_type: "text/markdown",
        },
        Resource {
            uri: "aiwf://catalog/nodes",
            name: "nodes",
            title: "节点目录",
            description: "16 种节点类型：用途、输入输出端口、配置字段（中文标签、必填、默认值）。",
            mime_type: "application/json",
        },
        Resource {
            uri: "aiwf://catalog/node-configs",
            name: "node-configs",
            title: "节点配置 JSON Schema",
            description: "每种节点配置的完整 Schema，写 setConfig 之前照着填。",
            mime_type: "application/json",
        },
        Resource {
            uri: "aiwf://catalog/contracts",
            name: "contracts",
            title: "契约元数据",
            description: "事件类型、运行与节点状态机、Patch 操作名、Core API 方法表。",
            mime_type: "application/json",
        },
        Resource {
            uri: "aiwf://workspace/inventory",
            name: "inventory",
            title: "当前工作区有什么",
            description: "已登记的 Agent 角色、提示词、模型、记忆、工作流 —— 实时读取。",
            mime_type: "application/json",
        },
    ]
}

/// 读一份资源。返回 `(mime, 内容)`。
///
/// # Errors
/// URI 不认识时返回 Err，文案里带上可用的清单 —— Agent 拼错 URI 时
/// 只说「找不到」会让它接着猜。
pub fn read(
    uri: &str,
    store: &Mutex<Store>,
    supervisor: &Supervisor,
    data_dir: &std::path::Path,
) -> Result<(&'static str, String), String> {
    match uri {
        "aiwf://guide/overview" => Ok(("text/markdown", OVERVIEW.to_string())),
        "aiwf://guide/build-and-run" => Ok(("text/markdown", BUILD_AND_RUN.to_string())),
        "aiwf://guide/read-run-data" => Ok(("text/markdown", READ_RUN_DATA.to_string())),
        "aiwf://catalog/nodes" => Ok(("application/json", node_catalog())),
        "aiwf://catalog/node-configs" => Ok(("application/json", NODE_CONFIGS.to_string())),
        "aiwf://catalog/contracts" => Ok(("application/json", META.to_string())),
        "aiwf://workspace/inventory" => Ok((
            "application/json",
            inventory(store, supervisor, data_dir).to_string(),
        )),
        other => Err(format!(
            "没有 {other} 这份资源。可用的：{}",
            resources()
                .iter()
                .map(|r| r.uri)
                .collect::<Vec<_>>()
                .join("、")
        )),
    }
}

/// 节点目录：把端口与配置 Schema 拼成一份「照着就能填」的东西。
///
/// 两份生成物分开读一次要两个来回，而 Agent 需要的是它们的**交集**：
/// 「这个节点有哪些端口、必填哪几个字段、字段的中文名是什么」。
fn node_catalog() -> String {
    let catalog: Value = serde_json::from_str(NODE_CATALOG).unwrap_or(Value::Null);
    let configs: Value = serde_json::from_str(NODE_CONFIGS).unwrap_or(Value::Null);

    let Some(entries) = catalog.as_object() else {
        return catalog.to_string();
    };

    let mut out = serde_json::Map::new();
    for (node_type, entry) in entries {
        let schema = configs.get(node_type).cloned().unwrap_or(Value::Null);
        let mut merged = entry.clone();
        if let Some(object) = merged.as_object_mut() {
            object.insert("configFields".to_string(), describe_fields(&schema));
        }
        out.insert(node_type.clone(), merged);
    }

    json!({
        "说明": "每种节点的用途、端口与配置字段。连线的 port 必须来自这里的 ports；\
                 条件分支的输出端口由 dynamicOutputs 声明的字段推导。",
        "nodes": Value::Object(out),
    })
    .to_string()
}

/// 从配置 Schema 抽出「表单需要知道的一切」的精简版。
///
/// 直接把整份 Schema 丢过去也行，但那是 27 KB，而 Agent 真正要的是
/// 「哪些必填、中文叫什么、能填什么值」。两样都给：这里是速查，
/// `aiwf://catalog/node-configs` 是全文。
fn describe_fields(schema: &Value) -> Value {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return Value::Array(Vec::new());
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let fields: Vec<Value> = props
        .iter()
        .map(|(key, field)| {
            // `.describe()` 的第一行是中文标签，其余行是提示（约定见 fields.ts）
            let described = field.get("description").and_then(Value::as_str);
            let mut lines = described.unwrap_or_default().splitn(2, '\n');
            let label = lines.next().unwrap_or_default();
            let hint = lines.next().unwrap_or_default();

            let mut item = json!({
                "key": key,
                "label": label,
                "required": required.contains(&key.as_str()),
            });
            if !hint.is_empty() {
                item["hint"] = json!(hint);
            }
            if let Some(options) = field.get("enum") {
                item["options"] = options.clone();
            }
            if let Some(default) = field.get("default") {
                item["default"] = default.clone();
            }
            if let Some(kind) = field.get("type") {
                item["type"] = kind.clone();
            }
            item
        })
        .collect();

    Value::Array(fields)
}

/// 当前工作区里有什么。Agent 设计工作流前要先知道能引用哪些角色与模型。
fn inventory(store: &Mutex<Store>, supervisor: &Supervisor, data_dir: &std::path::Path) -> Value {
    let 取 = |command: &str, input: Value| -> Value {
        aiwf_core_api::dispatch::dispatch(command, &input, store, supervisor, data_dir)
            .unwrap_or_else(|error| json!({ "错误": error.message }))
    };

    json!({
        "说明": "AI 节点的 agentProfileId 必须来自 agents 里的 id；\
                 模型引用必须来自 models 里已启用的条目。都是实时读的。",
        "workflows": 取("workflow_list", json!({ "limit": 50 })),
        "agents": 取("agent_list", json!({ "limit": 50 })),
        "prompts": 取("prompt_list", json!({ "limit": 50 })),
        "models": 取("model_list", json!({ "enabledOnly": true, "limit": 50 })),
        "memories": 取("memory_list", json!({ "limit": 50 })),
        "settings": 取("workspace_settings", json!({})),
        "stats": 取("workspace_stats", json!({})),
    })
}

// ── 指南正文 ────────────────────────────────────────────────────────────────

const OVERVIEW: &str = r#"# AI Workflows

一个本地优先的 AI 工作流编排工具。用户在画布上搭出由节点组成的流程，
然后运行它；每次运行的全过程以事件流记录下来，可回放、可解释。

你现在通过 MCP 连着它。你能读它的全部状态，也能改工作流、起运行 ——
具体哪些写操作需要用户先确认，取决于「设置与环境」里的权限档。

## 界面上有哪几屏

| 屏 | 能干什么 |
| --- | --- |
| 工作流（首页） | 全部工作流的列表，新建、导入、搜索、按状态筛选 |
| 画布编辑器 | 拖节点、连线、配置、保存草稿、发布版本、发起运行 |
| 执行记录 | 每次运行的事件流、产物、对话；失败时可重试 / 回到审批点 / 重跑 / 导出诊断包 |
| 记忆 | 会被注入后续每一次 AI 调用的长期上下文，可停用或删除 |
| Agent 角色 | Agent 的目标、人设、可用工具、权限与模型 |
| 提示词库 | 分段的提示词模板与变量，按版本保存 |
| 模型 | 已登记的模型与它们的运行时、上下文窗口、能力 |
| 设置与环境 | 依赖工具的健康检查与权限策略 |

## 两个必须分清的概念

- **草稿**（rev，单调递增）：可变的编辑现场。改它不影响正在跑的东西。
  `workflow_patch` 改的就是它，每次成功 rev 加一。
- **版本**（v，不可变快照，带 config_hash）：`workflow_publish` 发布出来的。
  运行永远引用某个版本或某个草稿修订 —— 所以改草稿不会影响运行中的版本。

## 写入的唯一形态

**结构化 Patch**。`workflow_patch` 只接受 `addNode` / `connect` / `setConfig`
这类操作，刻意没有「整份回写」——那会绕过版本守卫与 Diff，
写坏了就无法解释和回滚。

每次 patch 都要带 `baseRevision`：与当前 rev 不符会返回 `REVISION_CONFLICT`，
那时要重新 `workflow_get` 再基于新 rev 重来。

## 安全边界

- Secret 只以 `keychain://` 引用出现，明文在存储层就被拒绝
- 事件、日志、产物预览一律经过脱敏
- 节点的能力（读写文件 / 执行命令 / 网络 / 记忆）由引擎强制，提示词无法越权
"#;

const BUILD_AND_RUN: &str = r#"# 从零设计一条工作流并跑起来

按这个顺序走。每一步都有可检查的产出，别跳。

## 0. 先看清楚现状

1. 读 `aiwf://catalog/nodes` —— 知道有哪 16 种节点、各自的端口叫什么
2. 读 `aiwf://workspace/inventory` —— 知道能引用哪些 Agent 角色和模型

**AI 节点的 `agentProfileId` 必须是 inventory 里真实存在的 id。**
编一个的话，图能存进去，但 Dry Run 会报「角色不存在」。

## 1. 建工作流

```
workflow_create { name: "..." }        → { id, rev }
```

## 2. 加节点、连线

```
workflow_patch {
  id, baseRevision: <当前 rev>,
  operations: [
    { op: "addNode", nodeId: "entry", type: "entry", title: "入口",
      position: {x: 40, y: 34}, config: { trigger: "manual", inputSchema: {...} } },
    ...
    { op: "connect", edgeId: "e1",
      source: { nodeId: "entry", port: "success" },
      target: { nodeId: "read_issue", port: "input" } }
  ]
}
→ { rev, diff, validation }
```

要点：

- **一次 patch 可以带很多操作**，要么全成要么全不成。分很多次发，
  中间任何一次失败都会留下半张图
- `position` 是画布坐标，横向排开每个 250、纵向每行 150 左右
- 连线的 `port` 必须来自节点目录里的 `ports`。写错的报错是 `UNKNOWN_PORT`
- 每种节点的必填字段看 `configFields` 里 `required: true` 的那些
- **脚本里的 `${…}` 不要再自己套引号**。引擎替进去的值已经加过 shell 引号，
  再套一层会得到 `"'1'"` —— 命令收到的是带引号的字面量，
  而报错（比如 `invalid issue format`）离原因隔着一层引号。
  写 `gh issue view ${input.issue}`，不是 `gh issue view "${input.issue}"`

## 3. 校验

```
workflow_validate { id }   → { ok, issues }
```

`ok: false` 时逐条看 `issues`：`level: "error"` 必须修，`warning` 可以留。
`patch` 的返回值里已经带了同一份 validation，所以多数时候不必单独调。

## 4. Dry Run —— 跑之前先查依赖

```
run_dry_run { workflowId, draftRev: <rev> }   → { report }
```

它会告诉你：解释器在不在、git 在不在、ACP adapter 装没装、工作目录能不能写。
**这一步失败就别起运行** —— 起了也是当场失败，还多一条脏记录。

## 5. 发布版本（可选但推荐）

```
workflow_publish { id, rev }   → { versionId, version, configHash }
```

草稿也能跑（`draftRev`），但版本是不可变快照，运行记录指过去更可靠。

## 6. 起运行

```
run_start { workflowId, versionId, inputsJson: "{\"issue\":\"12\"}" }  → runId
```

`inputsJson` 的形状由入口节点的 `inputSchema` 决定 —— 少一个必填项会在
preflight 阶段失败。

## 7. 盯着它

```
run_get { runId }                          → 状态、当前节点
run_events { runId, fromSeq: 0, limit: 200 } → 完整事件流
```

`seq` 从 1 开始连续，没有缺口。轮询时带上上次读到的 `fromSeq` 往后拿。

遇到 `waiting_approval`：运行挂在一个审批节点上，要
`approval_decide { runId, nodeId, decision: "approved" }` 才会继续。
这是引擎强制的暂停点，绕不过去。

## 8. 出问题了

| 状态 | 怎么办 |
| --- | --- |
| `failed` | `run_events` 找 `node.failed`，看 summary 与产物；改配置后 `run_start` 重来 |
| 想改审批时的选择 | `run_rewind_to_approval { runId }` —— 会开一条新运行，从那个审批点起 |
| 卡住了 | `run_cancel { runId }`，在下一个节点边界生效 |
| 要带走现场 | `run_diagnostics { runId }` 导出诊断包（已脱敏） |
"#;

const READ_RUN_DATA: &str = r#"# 怎么读一次运行的完整数据

**运行状态只有一份真源：事件流。** 不存在第二张状态表 ——
对话视图、节点进度、产物列表、可解释性证据，全部是同一条流的不同投影。

## 事件流

```
run_events { runId, fromSeq: 0, limit: 500 }
→ { events: [{ seq, kind, nodeId, nodeLabel, attempt, actor, status,
               summary, payloadRef, artifactRefs, sensitivity, at }], total }
```

`(runId, seq)` 唯一且由存储分配，seq 连续无缺口 —— 有缺口就是 bug。
`summary` 超过 2000 字符会被拒收，所以大内容一律走产物 + `payloadRef`。

九类事件（完整清单见 `aiwf://catalog/contracts` 的 `eventTypes`）：

| 类 | 回答什么问题 |
| --- | --- |
| `run.*` | 这次运行的生命周期：创建、preflight、开始、暂停、结束 |
| `node.*` | 每个节点：排队、开始、等待、重试、成功 / 失败 / 跳过、输出 |
| `conversation.*` | AI 节点与模型之间说了什么 |
| `reasoning.*` | 推理摘要 |
| `tool.*` | Agent 调了哪些工具、结果如何 |
| `script.*` | 脚本节点的 stdout / stderr / 退出码 |
| `approval.*` | 谁在什么时候批准了什么 |
| `artifact.*` | 产出了哪些文件、有没有被截断 |
| `system.*` | 检查点、环境快照、注入了哪些记忆、用了哪个模型与提示词、脱敏、权限授予与拒绝 |

## 可解释性：「为什么它这么做」

这几条 `system.*` 事件就是答案，不用去别处找：

- `system.memory_injected` —— 这一步注入了哪些记忆
- `system.prompt_resolved` —— 用的是哪条提示词的哪个版本
- `system.model_resolved` / `system.model_downgraded` —— 实际用了哪个模型，有没有降级
- `system.permission_granted` / `system.permission_denied` —— 申请了什么、给没给
- `system.checkpoint_saved` —— 每个节点完成后的 Scope 快照，重启后从这里接上

## 产物

```
run_artifacts { runId }                              → 文件清单
run_artifact_content { runId, path, maxBytes }       → 内容（已脱敏、可能截断）
```

产物内容在返回前会过一遍 Redactor —— 脚本里 echo 出来的密钥不会原样送出来。

## 一次运行完整地读一遍

1. `run_get` 拿状态与耗时
2. `run_events` 从 seq 0 拉到底，按 `kind` 分类
3. `run_artifacts` 拿产出清单，需要细看的用 `run_artifact_content`
4. 想知道「为什么」就找上面那几条 `system.*`
"#;

// ── Prompts ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PromptArg {
    pub name: &'static str,
    pub description: &'static str,
    pub required: bool,
}

#[derive(Debug, Clone)]
pub struct PromptTemplate {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub arguments: &'static [PromptArg],
}

#[must_use]
pub fn prompts() -> Vec<PromptTemplate> {
    vec![
        PromptTemplate {
            name: "design_workflow",
            title: "设计一条工作流",
            description: "把一句话的目标变成一条搭好、校验通过、可运行的工作流。",
            arguments: &[
                PromptArg {
                    name: "goal",
                    description: "想让这条工作流干什么，一两句话",
                    required: true,
                },
                PromptArg {
                    name: "name",
                    description: "工作流名字，不给就自己起一个",
                    required: false,
                },
            ],
        },
        PromptTemplate {
            name: "diagnose_run",
            title: "分析一次运行",
            description: "读完整事件流与产物，说清这次运行发生了什么、哪一步出了问题。",
            arguments: &[PromptArg {
                name: "runId",
                description: "要分析的运行 id",
                required: true,
            }],
        },
    ]
}

/// 展开一条提示词模板。
///
/// # Errors
/// 模板名不认识时返回 Err。
pub fn render_prompt(name: &str, args: &Value) -> Result<(String, String), String> {
    let arg = |key: &str| -> String {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    match name {
        "design_workflow" => {
            let goal = arg("goal");
            let 名字 = arg("name");
            let 名字段 = if 名字.is_empty() {
                "工作流的名字你自己起一个，能一眼看出用途。".to_string()
            } else {
                format!("工作流叫「{名字}」。")
            };
            Ok((
                "设计一条工作流".to_string(),
                format!(
                    "目标：{goal}\n\n{名字段}\n\n\
                     动手前先读这三份资源：\n\
                     - `aiwf://guide/build-and-run`（该按什么顺序调哪个工具）\n\
                     - `aiwf://catalog/nodes`（有哪些节点、端口叫什么、哪些字段必填）\n\
                     - `aiwf://workspace/inventory`（能引用哪些 Agent 角色和模型）\n\n\
                     然后：建工作流 → 一次 patch 把节点和连线都加上 → 看返回的 validation → \
                     Dry Run → 发布 → 起运行 → 读事件流确认真的跑通了。\n\n\
                     三条硬要求：\n\
                     1. AI 节点的 agentProfileId 必须来自 inventory，不要编\n\
                     2. 连线的 port 必须来自节点目录，不要猜\n\
                     3. Dry Run 没过就别起运行 —— 起了也是当场失败，还多一条脏记录\n\n\
                     每一步把工具返回的关键信息说出来，别只说「已完成」。"
                ),
            ))
        }
        "diagnose_run" => {
            let run_id = arg("runId");
            Ok((
                "分析一次运行".to_string(),
                format!(
                    "分析运行 {run_id}。\n\n\
                     先读 `aiwf://guide/read-run-data`，再按它说的做：\n\
                     1. `run_get` 拿状态与耗时\n\
                     2. `run_events` 从 seq 0 拉到底 —— **拉完**，别只看前 50 条\n\
                     3. `run_artifacts` 看产出，需要细看的用 `run_artifact_content`\n\n\
                     回答这几个问题：\n\
                     - 这次运行做了什么？按节点顺序讲一遍\n\
                     - 每个 AI 节点用了哪个模型、哪条提示词、注入了哪些记忆？\
                       （看 `system.model_resolved` / `system.prompt_resolved` / \
                       `system.memory_injected`）\n\
                     - 有失败或重试吗？根因是什么？\n\
                     - 事件流完整吗？seq 有没有缺口，每个 started 有没有配对的结束事件\n\n\
                     结论要有据可查：说「第 3 个节点失败」就带上那条事件的 seq。"
                ),
            ))
        }
        other => Err(format!(
            "没有 {other} 这条提示词。可用的：{}",
            prompts()
                .iter()
                .map(|p| p.name)
                .collect::<Vec<_>>()
                .join("、")
        )),
    }
}
