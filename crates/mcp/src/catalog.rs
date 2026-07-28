//! MCP 工具清单 —— **由契约派生，不手工维护第二份**。
//!
//! 清单 = 契约里声明的方法 ∩ 引擎真的能分派的命令（`COMMANDS`），
//! 再减去一小撮刻意藏起来的。手写一份的结局是「界面上能做的事，
//! Agent 说它做不到」，而这种缺口只有用户碰上了才会知道。
//!
//! 入参 Schema 直接用 `packages/contracts/generated/core-api.schema.json`——
//! 那是 `pnpm contracts:check` 守着的同一份，界面与 Agent 看到的形状一致。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::Value;

const API_SCHEMA: &str = include_str!("../../../packages/contracts/generated/core-api.schema.json");

/// 刻意不暴露给 Agent 的命令。**两类，各有各的理由。**
///
/// 一、确认通道本身。把 `mcp_decide_confirm` 给 Agent，等于让它批准
/// 自己的写操作 —— 「AI 建议 ≠ 执行」当场作废，而且用户在界面上
/// 看不出发生过这件事。
///
/// 二、`workflow_save_draft`：整份回写。它是留给界面的那条路
/// （界面在本地已经走过一次 applyPatch，Diff 给用户看过了）。
/// 开给 Agent 的话，`workflow_patch` 那套版本守卫与结构化审计
/// 就有了旁路 —— 技术选型 §6 禁的正是这个。Agent 要改图走 `workflow_patch`。
///
/// 其余的都开，包括 `supervisor_ask`（问一个懂这个系统的人）
/// 与所有删除操作 —— 后者由权限档挡着，且描述里写明了「不可逆」。
pub const DELIBERATELY_HIDDEN: &[&str] = &[
    "mcp_request_confirm",
    "mcp_confirm_status",
    "mcp_pending_confirms",
    "mcp_decide_confirm",
    "workflow_save_draft",
];

#[derive(Debug, Clone)]
pub struct McpTool {
    /// MCP 工具名，就是引擎的命令名（`workflow_list`）。
    pub name: String,
    /// 契约里的方法名（`workflow.list`）。错误信息里指回契约用。
    pub method: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub scope: Option<String>,
    pub mutates: bool,
    /// `readOnlyHint`：客户端据此决定要不要额外提示用户。
    pub read_only: bool,
    /// 不可逆。删除与发布属于这一类，客户端会更醒目地提示。
    pub destructive: bool,
}

/// 写操作要不要先让用户点一下。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteGate {
    Allow,
    NeedsConfirm,
}

/// 全部工具，按契约里的顺序。
#[must_use]
pub fn tools() -> &'static [McpTool] {
    static TOOLS: OnceLock<Vec<McpTool>> = OnceLock::new();
    TOOLS.get_or_init(build)
}

#[must_use]
pub fn tool(name: &str) -> Option<&'static McpTool> {
    tools().iter().find(|tool| tool.name == name)
}

fn build() -> Vec<McpTool> {
    let spec: BTreeMap<String, Value> = serde_json::from_str(API_SCHEMA).unwrap_or_default();
    let dispatchable: Vec<&str> = aiwf_core_api::COMMANDS.to_vec();

    let mut out = Vec::new();
    for (method, entry) in &spec {
        let name = command_name(method);
        if !dispatchable.contains(&name.as_str()) || DELIBERATELY_HIDDEN.contains(&name.as_str()) {
            continue;
        }
        // 契约里 `scope: null` 的意思就是「本地专属方法，不对 MCP 开放」。
        // 在这里另立一套判断的话，两边迟早对不上 —— 而对不上的样子是
        // 契约说不开放、清单里却有
        if entry.get("scope").is_none_or(Value::is_null) {
            continue;
        }

        let summary = entry
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mutates = entry
            .get("mutates")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let scope = entry
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_string);

        let mut input_schema = entry
            .get("input")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
        // `$schema` 留着会让部分客户端拒绝加载整份清单
        if let Some(object) = input_schema.as_object_mut() {
            object.remove("$schema");
        }

        let destructive = matches!(
            name.as_str(),
            "workflow_delete"
                | "memory_delete"
                | "prompt_delete"
                | "agent_delete"
                | "model_delete"
                | "workflow_rollback"
                | "workflow_discard_if_empty"
        );

        out.push(McpTool {
            description: describe(&summary, mutates, scope.as_deref(), destructive),
            title: summary,
            method: method.clone(),
            name,
            input_schema,
            scope,
            mutates,
            read_only: !mutates,
            destructive,
        });
    }
    out
}

/// 契约方法名 → 引擎命令名：`workflow.versionGraph` → `workflow_version_graph`。
fn command_name(method: &str) -> String {
    let Some((head, tail)) = method.split_once('.') else {
        return method.to_string();
    };
    let mut out = String::from(head);
    out.push('_');
    for ch in tail.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// 工具描述。**Agent 选工具时只看得到这一段**。
///
/// 只写 summary 的话它分不出「列一下」和「删掉」的区别，
/// 于是会拿 `workflow_delete` 去「清理一下」—— 而那是不可逆的。
fn describe(summary: &str, mutates: bool, scope: Option<&str>, destructive: bool) -> String {
    let mut text = summary.to_string();
    if mutates {
        text.push_str("。这是写操作");
        if destructive {
            text.push_str("，且不可逆");
        }
        text.push_str("；按当前权限档可能需要用户在应用里先确认");
    } else {
        text.push_str("。只读");
    }
    if let Some(scope) = scope {
        text.push_str(&format!("（scope: {scope}）"));
    }
    text
}

/// 这个工具在这个权限档下要不要先确认。
///
/// 档位的含义与节点执行那边一致（功能文档 §7），别在这儿另起一套：
/// 用户在「设置与环境」里调的是同一个开关，两处行为不同会让他无从预期。
///
/// **认不出来的档位按最严处理**：数据库里躺着一个拼错的值、
/// 或者以后加了新档而这里没跟上，都该是「先问用户」。
#[must_use]
pub fn gate_for(tool: &McpTool, preset: &str) -> WriteGate {
    if !tool.mutates {
        return WriteGate::Allow;
    }

    match preset {
        // 全放行。用户明确说了这条工作流可信
        "trusted_workflow" => WriteGate::Allow,

        // 改草稿放行：它可回滚、有 Diff、不碰外部世界。
        // 发布、运行、删除仍要确认 —— 那三件事要么不可逆，要么会真的动起来
        "workspace_safe" => match tool.scope.as_deref() {
            Some("workflow:write-draft" | "memory:write") if !tool.destructive => WriteGate::Allow,
            _ => WriteGate::NeedsConfirm,
        },

        _ => WriteGate::NeedsConfirm,
    }
}
