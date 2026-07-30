//! MCP 的 JSON-RPC 层。
//!
//! 与传输无关：`handle_message` 收一条消息、给一条响应，
//! stdio 和 Streamable HTTP 都接在它上面。
//!
//! 协议版本按客户端要的回。写死一个版本的话，装着旧版 Claude Code
//! 的机器会在握手时就断开，而症状是「加了 server 但工具列表是空的」。

use std::sync::Mutex;

use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::{Value, json};

use crate::catalog::{self, WriteGate};
use crate::knowledge;

/// 我们认识的协议版本，**新的在前**。
///
/// 客户端报一个我们认识的就照它回；报一个不认识的就回我们最偏好的那个 ——
/// 规范要求的是「服务端回一个自己支持的版本，客户端自己决定要不要继续」。
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
    &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub const SERVER_NAME: &str = "aiwf";

/// 一次调用要用到的东西。
pub struct McpContext<'a> {
    pub store: &'a Mutex<Store>,
    pub supervisor: &'a Supervisor,
    pub data_dir: &'a std::path::Path,
}

impl McpContext<'_> {
    /// 当前权限档。读不到就按最严的算 ——
    /// 数据库读不出来时放行写操作是最糟的默认值。
    fn permission_preset(&self) -> String {
        self.store
            .lock()
            .ok()
            .and_then(|store| store.workspace_settings().ok()?.permission_preset)
            .unwrap_or_else(|| "review_every_change".to_string())
    }
}

/// 处理一条 JSON-RPC 消息。返回 None 表示「不该回」——
/// 通知（没有 id 的消息）就是这样，回了反而让客户端认为协议出错。
pub fn handle_message(ctx: &McpContext<'_>, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    // 通知没有 id，也不该有响应
    let id = id?;

    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "tools/list" => Ok(json!({ "tools": tools_list() })),
        "tools/call" => Ok(call_tool(ctx, &params)),
        "resources/list" => Ok(json!({ "resources": resources_list() })),
        "resources/read" => resources_read(ctx, &params),
        "prompts/list" => Ok(json!({ "prompts": prompts_list() })),
        "prompts/get" => prompts_get(&params),
        "ping" => Ok(json!({})),
        // 没实现的能力：回空表而不是报错。报错会让部分客户端
        // 在启动阶段就把整个 server 标成不可用
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "completion/complete" => Ok(json!({ "completion": { "values": [] } })),
        other => Err(json!({ "code": -32601, "message": format!("未知方法：{other}") })),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn initialize(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        SUPPORTED_PROTOCOL_VERSIONS[0]
    };

    json!({
        "protocolVersion": version,
        "capabilities": {
            "tools": { "listChanged": false },
            "resources": { "listChanged": false, "subscribe": false },
            "prompts": { "listChanged": false },
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "title": "AI Workflows",
            "version": env!("CARGO_PKG_VERSION"),
        },
        // 客户端会把它显示在连接成功之后。第一句话就说清「先读什么」，
        // 省掉 Agent 靠工具名去猜系统形态的那几轮
        "instructions": "这是 AI Workflows —— 一个本地优先的 AI 工作流编排工具。\
                         动手前先读资源 aiwf://guide/overview（这个系统是什么）与 \
                         aiwf://guide/build-and-run（设计并跑通一条工作流的步骤）。\
                         要引用 Agent 角色或模型时先读 aiwf://workspace/inventory —— \
                         编一个不存在的 id 会在 Dry Run 阶段才暴露。\
                         写操作是否需要用户先确认，取决于应用里的权限档。",
    })
}

fn tools_list() -> Vec<Value> {
    catalog::tools()
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "title": tool.title,
                "description": tool.description,
                "inputSchema": tool.input_schema,
                "annotations": {
                    "title": tool.title,
                    "readOnlyHint": tool.read_only,
                    "destructiveHint": tool.destructive,
                    // 同样的入参再调一次会不会有额外后果。
                    // 列清单是幂等的，起运行不是 —— 客户端据此决定要不要自动重试
                    "idempotentHint": tool.read_only,
                    "openWorldHint": false,
                },
            })
        })
        .collect()
}

/// 调一个工具。
///
/// 失败时返回 `isError: true` 而不是 JSON-RPC 层的 error：
/// 后者在多数客户端里会直接中断对话，而 isError 的结果仍然进上下文 ——
/// Agent 读得到「哪个字段不对」，然后自己改了再试一次。
fn call_tool(ctx: &McpContext<'_>, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let input = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let Some(tool) = catalog::tool(name) else {
        return error_result(if catalog::DELIBERATELY_HIDDEN.contains(&name) {
            format!(
                "{name} 不对 MCP 开放。确认通道只能由用户在应用里操作 —— \
                 让 Agent 批准自己的写操作等于没有确认"
            )
        } else {
            format!(
                "没有 {name} 这个工具。用 tools/list 看完整清单，\
                 或读 aiwf://guide/build-and-run 看该按什么顺序调"
            )
        });
    };

    // 写操作的确认。挂在权限档上，与节点执行那边同一个开关
    let preset = ctx.permission_preset();
    if catalog::gate_for(tool, &preset) == WriteGate::NeedsConfirm
        // 先问一句：用户是不是已经批准过同样的调用了。
        //
        // 没有这一步的话，那条「提交 → 用户批准 → 再调一次」的通道
        // 在第三步断掉：每次都无条件重新入队，默认档下 40 多个写工具
        // 一个都用不了。用户点了「批准」，卡片消失，而什么都没写 ——
        // 卡上那句「批准后这次写入会走 Core API 的版本守卫与审计」是假的。
        //
        // 认领会**消费掉**那条批准：一次批准换一次执行，
        // 否则 agent 拿着一条旧批准能把同一个写操作重复做任意多次
        && !claim_approved(ctx, tool.name.as_str(), &input)
    {
        return match request_confirmation(ctx, tool.name.as_str(), &input) {
            Ok(()) => error_result(format!(
                "{} 是写操作，已经把它提交给用户确认了。\
                 当前权限档是 {preset} —— 用户在应用里点「同意」之后你再调一次。\
                 需要经常这么做的话，可以让用户在「设置与环境」里把权限档调宽",
                tool.name
            )),
            Err(message) => error_result(message),
        };
    }

    match aiwf_core_api::dispatch::dispatch(
        &tool.name,
        &input,
        ctx.store,
        ctx.supervisor,
        ctx.data_dir,
    ) {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": pretty(&value) }],
            // 结构化输出：认这个字段的客户端不必再解析一遍文本
            "structuredContent": structured(&value),
            "isError": false,
        }),
        Err(error) => {
            let mut message = error.message.clone();
            if let Some(hint) = &error.hint {
                // hint 是「接下来该干什么」。丢掉它，Agent 就只知道
                // 「失败了」，然后原样再试一次
                message.push_str(&format!("\n\n接下来：{hint}"));
            }
            error_result(format!("[{}] {message}", error.code))
        }
    }
}

/// 用户是不是已经批准过同样的调用了。认领到就消费掉那条批准。
///
/// 锁拿不到时按「没批准过」办：那会让这次调用重新入队，用户多点一次；
/// 反过来当成「批准过」就等于在数据库出问题时放行一个写操作。
fn claim_approved(ctx: &McpContext<'_>, tool: &str, input: &Value) -> bool {
    ctx.store
        .lock()
        .ok()
        .and_then(|store| aiwf_core_api::mcp_claim_approved(&store, tool, &input.to_string()).ok())
        .unwrap_or(false)
}

/// 提交一条待确认的写操作。
fn request_confirmation(ctx: &McpContext<'_>, tool: &str, input: &Value) -> Result<(), String> {
    let store = ctx
        .store
        .lock()
        .map_err(|_| "数据库锁已损坏，需要重启应用".to_string())?;
    aiwf_core_api::mcp_request_confirm(&store, tool.to_string(), input.to_string())
        .map(|_| ())
        .map_err(|error| format!("提交确认失败：{}", error.message))
}

fn resources_list() -> Vec<Value> {
    knowledge::resources()
        .into_iter()
        .map(|item| {
            json!({
                "uri": item.uri,
                "name": item.name,
                "title": item.title,
                "description": item.description,
                "mimeType": item.mime_type,
            })
        })
        .collect()
}

fn resources_read(ctx: &McpContext<'_>, params: &Value) -> Result<Value, Value> {
    let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
    match knowledge::read(uri, ctx.store, ctx.supervisor, ctx.data_dir) {
        Ok((mime, text)) => Ok(json!({
            "contents": [{ "uri": uri, "mimeType": mime, "text": text }],
        })),
        // 资源找不到走 JSON-RPC 的 error：与工具不同，
        // 这里没有「让 Agent 读到错误再改一次」的余地 —— URI 是我们自己列的
        Err(message) => Err(json!({ "code": -32602, "message": message })),
    }
}

fn prompts_list() -> Vec<Value> {
    knowledge::prompts()
        .into_iter()
        .map(|item| {
            json!({
                "name": item.name,
                "title": item.title,
                "description": item.description,
                "arguments": item.arguments.iter().map(|arg| json!({
                    "name": arg.name,
                    "description": arg.description,
                    "required": arg.required,
                })).collect::<Vec<_>>(),
            })
        })
        .collect()
}

fn prompts_get(params: &Value) -> Result<Value, Value> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match knowledge::render_prompt(name, &args) {
        Ok((description, text)) => Ok(json!({
            "description": description,
            "messages": [{
                "role": "user",
                "content": { "type": "text", "text": text },
            }],
        })),
        Err(message) => Err(json!({ "code": -32602, "message": message })),
    }
}

fn error_result(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

/// 给人（与模型）看的文本形式。
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// `structuredContent` 必须是对象。裸的字符串或数字要包一层，
/// 否则认这个字段的客户端会把整个响应判为不合协议。
fn structured(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({ "result": value })
    }
}
