//! MCP 的 Streamable HTTP 传输（规范 2025-03-26 起，2025-11-25 仍是它）。
//!
//! 单一端点 `/mcp`，POST 收消息、GET 开服务端推流、DELETE 结束会话。
//!
//! 规范里三条**安全要求**，一条都不能省（否则任何网页都能通过 DNS 重绑定
//! 打到用户本机的这个端口，而这个端口能删工作流、能起运行）：
//!
//! 1. 校验 `Origin` —— 挡 DNS 重绑定
//! 2. 只绑 127.0.0.1，不绑 0.0.0.0
//! 3. 鉴权
//!
//! 第 3 条的形态要迁就客户端：Claude Code 能带自定义头
//! （`--header "Authorization: Bearer …"`），Codex 只认「从环境变量读 bearer」
//! 或 OAuth。要一键接入就不能要求用户先去设环境变量 ——
//! 所以令牌也接受放在路径里（`/mcp/<token>`），两种都认。

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::{Value, json};

use crate::protocol::{McpContext, SUPPORTED_PROTOCOL_VERSIONS, handle_message};

/// 默认端口。5177 是开发桥接，往后排一个。
pub const DEFAULT_PORT: u16 = 5178;

/// 同时处理请求的线程数。
///
/// 慢请求（`supervisor_ask` 要连 ACP adapter，超时 180 秒）会占住一个线程
/// 好几分钟，所以要比 CPU 核数宽裕得多 —— 这些线程大部分时间在等 I/O。
const WORKER_COUNT: usize = 8;

/// 会话最多闲置多久。
///
/// 客户端退出时**不一定**发 DELETE（崩溃、拔网线、直接 kill）。
/// 不清理的话这张表只增不减，而它是用来判断「这个 session 还认不认」的。
const SESSION_IDLE_SECS: u64 = 3600;

pub struct ServerHandle {
    pub port: u16,
    pub token: String,
    stop: Arc<AtomicBool>,
}

impl ServerHandle {
    /// 一键接入时写进客户端配置的那个地址。
    ///
    /// 令牌在路径里：Codex 的 `mcp add --url` 不支持自定义头，
    /// 而要求用户先 export 一个环境变量就谈不上「一键」了。
    #[must_use]
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp/{}", self.port, self.token)
    }

    /// 不带令牌的端点。用 `Authorization: Bearer` 头的客户端连这个。
    #[must_use]
    pub fn plain_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// 会话表：id → 最后活动时间（进程启动以来的秒数）。
type Sessions = Arc<Mutex<HashMap<String, u64>>>;

/// 起服务。**只绑 127.0.0.1**。
///
/// # Errors
/// 端口被占用时返回 Err —— 调用方该换一个端口再试，
/// 而不是让用户对着一个「MCP 没反应」自己猜。
pub fn serve(
    port: u16,
    token: String,
    db_path: std::path::PathBuf,
    data_dir: std::path::PathBuf,
) -> Result<ServerHandle, String> {
    let address = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&address)
        .map_err(|error| format!("MCP 无法监听 {address}：{error}"))?;

    // 端口传 0 时由系统分配，得问回来真实端口 —— 测试要用
    let port = server
        .server_addr()
        .to_ip()
        .map_or(port, |addr| addr.port());

    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let supervisor = Arc::new(Supervisor::new(db_path.clone()));

    for _ in 0..WORKER_COUNT {
        let server = Arc::clone(&server);
        let stop = Arc::clone(&stop);
        let sessions = Arc::clone(&sessions);
        let supervisor = Arc::clone(&supervisor);
        let token = token.clone();
        let db_path = db_path.clone();
        let data_dir = data_dir.clone();

        std::thread::spawn(move || {
            // 每个线程一份自己的数据库连接：共用一把 Mutex 的话，
            // 一个慢请求整段都握着锁，线程池救不了任何东西
            let store = match Store::open(&db_path) {
                Ok(store) => Mutex::new(store),
                Err(error) => {
                    eprintln!("[aiwf-mcp] 打不开数据库：{error}");
                    return;
                }
            };

            while let Ok(request) = server.recv() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let ctx = McpContext {
                    store: &store,
                    supervisor: &supervisor,
                    data_dir: &data_dir,
                };
                handle(request, &ctx, &token, &sessions);
            }
        });
    }

    Ok(ServerHandle { port, token, stop })
}

/// 生成一个令牌。
///
/// 走 `/dev/urandom`，不用时间戳做种：时间戳可预测，而这个令牌是
/// 「本机上除了这个应用之外谁都不该知道」的那一份。
#[must_use]
pub fn generate_token() -> String {
    let mut bytes = [0_u8; 24];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        // 拿不到熵源时不能退回一个可猜的值。宁可让调用方看到一个
        // 明显不对的令牌去查，也不能给一个「看起来正常但能被算出来」的
        return String::new();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn handle(mut request: tiny_http::Request, ctx: &McpContext<'_>, token: &str, sessions: &Sessions) {
    let url = request.url().to_string();
    let method = request.method().clone();

    // **先把请求体读干净**，再做任何检查。
    //
    // 早退的分支（令牌不对、路径不对、会话失效）如果不读 body 就直接应答，
    // 连接里还剩着没消费的字节，客户端那边看到的是一个读不出状态行的
    // 半截响应 —— 症状是「偶尔连不上」，而且只在带 body 的请求上出现。
    let mut body = String::new();
    let 读到了 = request.as_reader().read_to_string(&mut body).is_ok();

    // ── 1. Origin 校验。规范的 MUST：挡 DNS 重绑定 ──
    //
    // 原生客户端（Claude Code / Codex）根本不发 Origin，那是正常的；
    // 带 Origin 的一定是浏览器，那时只认本机来源
    if header(&request, "origin").is_some_and(|origin| !is_local_origin(&origin)) {
        respond(
            request,
            403,
            None,
            &json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32600, "message": "Origin 不被允许" }
            }),
        );
        return;
    }

    // ── 2. 鉴权。令牌可以在路径里，也可以在 Authorization 头里 ──
    let (path, path_token) = split_token(&url);
    let authorized = token.is_empty()
        || path_token.as_deref() == Some(token)
        || header(&request, "authorization")
            .and_then(|value| {
                value
                    .strip_prefix("Bearer ")
                    .or_else(|| value.strip_prefix("bearer "))
                    .map(str::to_string)
            })
            .as_deref()
            == Some(token);

    if !authorized {
        respond(
            request,
            401,
            None,
            &json!({
                "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32600, "message": "缺少或错误的访问令牌" }
            }),
        );
        return;
    }

    if path != "/mcp" {
        respond(
            request,
            404,
            None,
            &json!({
                "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32600, "message": "MCP 端点是 /mcp" }
            }),
        );
        return;
    }

    // ── 3. 协议版本头。规范：不认识的版本必须 400 ──
    if let Some(version) = header(&request, "mcp-protocol-version")
        .filter(|version| !SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str()))
    {
        respond(
            request,
            400,
            None,
            &json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": {
                        "code": -32600,
                    "message": format!(
                        "不支持的协议版本 {version}。支持：{}",
                        SUPPORTED_PROTOCOL_VERSIONS.join("、")
                    ),
                }
            }),
        );
        return;
    }

    let session_header = header(&request, "mcp-session-id");
    sweep_sessions(sessions);

    // 认不出来的会话 id 回 404 —— 规范要求客户端据此重新 initialize。
    // 回 200 的话它会一直用一个我们其实没在跟踪的会话
    if let Some(id) = &session_header {
        if !sessions.lock().is_ok_and(|map| map.contains_key(id)) {
            respond(
                request,
                404,
                None,
                &json!({
                    "jsonrpc": "2.0", "id": Value::Null,
                    "error": { "code": -32600, "message": "会话已失效，请重新 initialize" }
                }),
            );
            return;
        }
        touch_session(sessions, id);
    }

    match method {
        tiny_http::Method::Post => handle_post(request, ctx, sessions, &body, 读到了),

        // 服务端不主动往客户端推消息，所以不开这条流。
        // 规范明说这时该回 405，客户端会照常工作
        tiny_http::Method::Get => respond_empty(request, 405),

        tiny_http::Method::Delete => {
            if let (Some(id), Ok(mut map)) = (session_header, sessions.lock()) {
                map.remove(&id);
            }
            respond_empty(request, 204);
        }

        _ => respond_empty(request, 405),
    }
}

fn handle_post(
    request: tiny_http::Request,
    ctx: &McpContext<'_>,
    sessions: &Sessions,
    body: &str,
    读到了: bool,
) {
    if !读到了 {
        respond(
            request,
            400,
            None,
            &json!({
                "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32700, "message": "请求体读不出来" }
            }),
        );
        return;
    }

    let Ok(message) = serde_json::from_str::<Value>(body) else {
        respond(
            request,
            400,
            None,
            &json!({
                "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32700, "message": "请求体不是合法 JSON" }
            }),
        );
        return;
    };

    // 批量消息：2025-03-26 支持，2025-06-18 起移除。仍然收 ——
    // 装着旧版客户端的机器不该因为这个连不上
    let responses: Vec<Value> = match &message {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| handle_message(ctx, item))
            .collect(),
        single => handle_message(ctx, single).into_iter().collect(),
    };

    // initialize 的响应要带上新会话 id
    let new_session = is_initialize(&message).then(|| {
        let id = crate::http::generate_token();
        touch_session(sessions, &id);
        id
    });

    if responses.is_empty() {
        // 通知与响应没有回复体。规范：202 Accepted，空 body
        respond_empty_with_session(request, 202, new_session.as_deref());
        return;
    }

    let payload = if message.is_array() {
        Value::Array(responses)
    } else {
        responses.into_iter().next().unwrap_or(Value::Null)
    };
    respond(request, 200, new_session.as_deref(), &payload);
}

fn is_initialize(message: &Value) -> bool {
    let one = |value: &Value| value.get("method").and_then(Value::as_str) == Some("initialize");
    match message {
        Value::Array(items) => items.iter().any(one),
        single => one(single),
    }
}

/// 只有本机来源算数。
///
/// 端口不比：MCP Inspector 之类的调试工具端口是随机的，
/// 而它们同样跑在本机上。挡的是**远程网页**，不是本机的另一个端口。
fn is_local_origin(origin: &str) -> bool {
    let host = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin);
    let host = host.split('/').next().unwrap_or(host);
    let host = host.rsplit_once(':').map_or(host, |(head, _)| head);

    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// `/mcp/<token>` 拆成 `("/mcp", Some(token))`。
fn split_token(url: &str) -> (String, Option<String>) {
    // 查询串不参与：令牌放 query 里会被更多地方记进日志
    let path = url.split('?').next().unwrap_or(url);
    match path.strip_prefix("/mcp/") {
        Some(rest) if !rest.is_empty() && !rest.contains('/') => {
            ("/mcp".to_string(), Some(rest.to_string()))
        }
        _ => (path.trim_end_matches('/').to_string(), None),
    }
}

fn header(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond(request: tiny_http::Request, status: u16, session: Option<&str>, payload: &Value) {
    let text = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string());
    let mut response = tiny_http::Response::from_string(text).with_status_code(status);
    for h in headers(session) {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn respond_empty(request: tiny_http::Request, status: u16) {
    respond_empty_with_session(request, status, None);
}

fn respond_empty_with_session(request: tiny_http::Request, status: u16, session: Option<&str>) {
    let mut response = tiny_http::Response::empty(status);
    for h in headers(session) {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

/// 响应头。
///
/// **没有 CORS 头**，这是有意的：加一个 `Access-Control-Allow-Origin: *`
/// 会把上面那道 Origin 校验彻底作废。客户端是原生进程，不需要 CORS。
fn headers(session: Option<&str>) -> Vec<tiny_http::Header> {
    let mut list = vec![("Content-Type", "application/json; charset=utf-8")];
    if session.is_some() {
        list.push(("Mcp-Session-Id", ""));
    }

    list.into_iter()
        .filter_map(|(name, value)| {
            let value = if name == "Mcp-Session-Id" {
                session.unwrap_or_default()
            } else {
                value
            };
            tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
        })
        .collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn touch_session(sessions: &Sessions, id: &str) {
    if let Ok(mut map) = sessions.lock() {
        map.insert(id.to_string(), now_secs());
    }
}

/// 清掉闲置太久的会话。
///
/// 没有后台定时器，就在每次有人碰这张表时收拾一下 ——
/// 与确认队列的过期清理是同一个办法。
fn sweep_sessions(sessions: &Sessions) {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = now_secs();
    // 每分钟最多扫一次：每个请求都全表遍历一遍是白花的
    if now.saturating_sub(LAST.load(Ordering::Relaxed)) < 60 {
        return;
    }
    LAST.store(now, Ordering::Relaxed);

    if let Ok(mut map) = sessions.lock() {
        map.retain(|_, last| now.saturating_sub(*last) < SESSION_IDLE_SECS);
    }
}
