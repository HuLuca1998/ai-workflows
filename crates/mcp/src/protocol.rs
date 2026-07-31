//! MCP 的 JSON-RPC 层。
//!
//! 与传输无关：`handle_message` 收一条消息、给一条响应，
//! stdio 和 Streamable HTTP 都接在它上面。
//!
//! 协议版本按客户端要的回。写死一个版本的话，装着旧版 Claude Code
//! 的机器会在握手时就断开，而症状是「加了 server 但工具列表是空的」。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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

/// 对外报数的唯一出口：契约派生的 + 内建 ask_user。
///
/// 各处自己算 `catalog::tools().len()` 的话，内建那 1 个必然被漏掉 ——
/// 设置页写 50、`tools/list` 回 51，读的人以为哪里坏了。
#[must_use]
pub fn tool_count() -> usize {
    catalog::tools().len() + 1
}

fn tools_list() -> Vec<Value> {
    let mut tools: Vec<Value> = catalog::tools()
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
        .collect();
    tools.push(ask_user_entry());
    tools
}

/// 内建工具：agent 向用户提问，挂起等回答。
///
/// **不在契约派生清单里** —— 它不是某个 Core API 命令的镜像：
/// `dispatch` 从进门就持库锁到返回，一个要挂着等用户回答的调用放进去，
/// 用户提交答案的那条 `mcp_answer_ask` 会被同一把锁挡在门外，死锁到超时。
/// 所以由这一层特判：入队、放锁、轮询，答案原样带回。
pub const ASK_USER_TOOL: &str = "ask_user";

/// 队列的 TTL 是三分钟（`CONFIRM_TTL_SECS`），过期由每次轮询顺手清理。
/// 这里的上限只是兜底 —— 万一过期机制没把它标掉，也不能永远挂着。
const ASK_WAIT_MAX: Duration = Duration::from_secs(190);
const ASK_POLL_INTERVAL: Duration = Duration::from_millis(500);

fn ask_user_entry() -> Value {
    json!({
        "name": ASK_USER_TOOL,
        "title": "向用户提问",
        "description": "向正在用这个应用的用户提一个问题，等他回答后把选择原样带回。\
            kind 四种：choice（选一个）/ multiChoice（选几个）/ form（补几段输入，用 fields 声明）/ \
            confirm（是/否，答案是 selected: yes|no）。这次调用会挂起直到用户回答，最长三分钟。\
            outcome 为 declined 表示用户拒绝回答 —— 别换个说法再问同一件事；\
            no_answer 表示没人在电脑前，按你的最优判断继续或稍后再问。",
        "inputSchema": ask_spec_schema(),
        "annotations": {
            "title": "向用户提问",
            // 它不改用户的数据，但一次调用会打断用户。标成只读/幂等的话，
            // 客户端会把失败的调用自动重试 —— 用户被同一个问题反复砸
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": false,
        },
    })
}

/// 入参 schema 直接用契约生成物 —— 手写第二份的结局是漂移，
/// 而漂移的样子是「schema 说有的字段，界面渲染不出来」。
fn ask_spec_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let mut schema: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/generated/ask-spec.schema.json"
        ))
        .unwrap_or_else(|_| json!({ "type": "object", "properties": {} }));
        // `$schema` 留着会让部分客户端拒绝加载整份清单
        if let Some(object) = schema.as_object_mut() {
            object.remove("$schema");
        }
        schema
    })
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

    // 内建工具在契约清单之外，先于它分派
    if name == ASK_USER_TOOL {
        return ask_user(ctx, &input);
    }

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

/// 同时挂着等回答的提问数。
///
/// HTTP 层一共 `WORKER_COUNT = 8` 个工作线程，一次 ask_user 最长占 190 秒。
/// 不设上限的话，8 条并发提问就让整个 MCP 端点三分钟不响应任何请求 ——
/// 包括 tools/list 和别的客户端。`idempotentHint: false` 挡的是自动重试，
/// 挡不住 agent 主动并发提问。
static ASK_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const ASK_MAX_IN_FLIGHT: usize = 4;

/// 计数的 RAII 守卫 —— ask_user 的返回路径有六条，手动减必漏。
struct AskSlot;
impl Drop for AskSlot {
    fn drop(&mut self) {
        ASK_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 向用户提问，挂起到有答案。
///
/// 等待期间**不持库锁** —— 用户提交答案的那条调用要拿同一把锁。
/// 入队与每次轮询各自短暂拿锁，中间放开。
fn ask_user(ctx: &McpContext<'_>, input: &Value) -> Value {
    if ASK_IN_FLIGHT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= ASK_MAX_IN_FLIGHT {
        ASK_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        return error_result(format!(
            "同时挂起的提问已有 {ASK_MAX_IN_FLIGHT} 条。把要问的合并成一个问题，\
             或等用户回答了前面的再问"
        ));
    }
    let _slot = AskSlot;

    let id = {
        let Ok(store) = ctx.store.lock() else {
            return error_result("数据库锁已损坏，需要重启应用".to_string());
        };
        match aiwf_core_api::mcp_ask_user(&store, input.to_string()) {
            Ok(id) => id,
            Err(error) => return error_result(format!("[{}] {}", error.code, error.message)),
        }
    };

    let deadline = Instant::now() + ASK_WAIT_MAX;
    loop {
        std::thread::sleep(ASK_POLL_INTERVAL);

        let result = {
            let Ok(store) = ctx.store.lock() else {
                return error_result("数据库锁已损坏，需要重启应用".to_string());
            };
            // 每次轮询顺手清理过期 —— TTL 到了它会把这条标成 expired
            aiwf_core_api::mcp_ask_result(&store, id.clone())
        };

        let result = match result {
            Ok(result) => result,
            Err(error) => {
                // 查不到这一条了（多半是 workspace_reset 清了表）—— 没什么可等的。
                // 判据对应 StoreError::NotFound 的文案「找不到 {kind} {id}」，
                // kind 由 mcp_ask_result 定为「提问」。
                // 其余错误（SQLITE_BUSY 之类）是暂时的：问题还挂在用户屏幕上，
                // 现在放弃的话，他两秒后提交的答案就没有人读了
                if error.message.contains("找不到 提问") {
                    return error_result(format!("[{}] {}", error.code, error.message));
                }
                eprintln!("[mcp] 轮询提问 {id} 出错（继续等）：{}", error.message);
                if Instant::now() >= deadline {
                    return ask_outcome(json!({
                        "outcome": "no_answer",
                        "note": "等待超时，没有等到回答。按你的最优判断继续，或稍后再问",
                    }));
                }
                continue;
            }
        };

        match result.status.as_str() {
            "pending" => {}
            // 回答与拒绝都不是错误（isError 会让部分客户端中断对话）——
            // 它们是用户的决定，agent 要读着它接着干活
            "approved" => {
                let answer = result
                    .answer_json
                    .as_deref()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .unwrap_or(Value::Null);
                return ask_outcome(json!({
                    "outcome": "answered",
                    "answer": answer,
                }));
            }
            "rejected" => {
                // 刻意不带 answer 字段：空对象会被 agent 当成「用户什么都没选」，
                // 而那与「用户拒绝回答」是两件事
                return ask_outcome(json!({
                    "outcome": "declined",
                    "note": "用户拒绝回答这个问题。别换个说法再问同一件事 —— 按你的最优判断继续",
                }));
            }
            // expired 与任何认不出的状态都按「没人回答」处理：
            // 猜一个具体含义再据此行动，比承认不知道更糟
            _ => {
                return ask_outcome(json!({
                    "outcome": "no_answer",
                    "note": "三分钟没人回答，可能用户不在电脑前。按你的最优判断继续，或稍后再问",
                }));
            }
        }

        if Instant::now() >= deadline {
            return ask_outcome(json!({
                "outcome": "no_answer",
                "note": "等待超时，没有等到回答。按你的最优判断继续，或稍后再问",
            }));
        }
    }
}

/// 提问的结果。与普通工具一样给两份：文本给只读 text 的客户端，
/// `structuredContent` 给认结构的。
fn ask_outcome(value: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": pretty(&value) }],
        "structuredContent": value,
        "isError": false,
    })
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
