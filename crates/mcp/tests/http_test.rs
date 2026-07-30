//! Streamable HTTP 传输：真起一个服务，用真的 TCP 打进去。
//!
//! 规范里的三条安全要求（Origin 校验、只绑 127.0.0.1、鉴权）
//! 是这份文件的重点。少一条，任何网页都能通过 DNS 重绑定打到
//! 用户本机这个端口 —— 而这个端口能删工作流、能起运行。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;

use aiwf_mcp::http;
use serde_json::{Value, json};

struct 服务 {
    handle: http::ServerHandle,
    /// 库的路径。要在测试里扮演「用户在应用里点了同意」，
    /// 就得能自己开一条连接去改那条确认记录 —— 确认通道
    /// 刻意不对 MCP 开放（`DELIBERATELY_HIDDEN`）
    db: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn 起一个() -> 服务 {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("aiwf.sqlite");
    // 先开一次把表建起来：多个工作线程同时跑迁移会撞锁
    aiwf_store::Store::open(&db).unwrap();

    let handle = http::serve(
        0,
        aiwf_core_api::mcp_config::generate_token(),
        db.clone(),
        dir.path().to_path_buf(),
    )
    .expect("MCP 起不来");

    服务 {
        handle,
        db,
        _dir: dir,
    }
}

struct 应答 {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl 应答 {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// 手写 HTTP 客户端。引一个 HTTP 库只为了发几个请求不值当，
/// 而且手写这版能精确控制头 —— 这里测的正是「头不对时会怎样」。
fn 请求(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> 应答 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连不上");
    let body = body.unwrap_or("");

    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    request.push_str("Connection: close\r\n\r\n");
    request.push_str(body);

    stream.write_all(request.as_bytes()).unwrap();
    stream.flush().unwrap();

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line).unwrap();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);

    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(": ") {
            headers.push((name.to_string(), value.to_string()));
        }
    }

    // tiny_http 对大响应用 chunked 编码（工具清单有 25 KB），
    // 真的 HTTP 客户端自然会解，这里手写的这个也得会 —— 不解的话
    // 症状是「小响应都对、大响应解不出 JSON」
    let 分块 = headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked"));

    let body = if 分块 {
        读分块(&mut reader)
    } else {
        let mut raw = String::new();
        let _ = reader.read_to_string(&mut raw);
        raw
    };

    应答 {
        status,
        headers,
        body,
    }
}

fn 读分块(reader: &mut BufReader<TcpStream>) -> String {
    let mut out = Vec::new();
    loop {
        let mut size_line = String::new();
        if reader.read_line(&mut size_line).is_err() {
            break;
        }
        // 分块大小是十六进制，后面可能跟着扩展参数（`;name=value`）
        let size =
            usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0").trim(), 16)
                .unwrap_or(0);
        if size == 0 {
            break;
        }
        let mut chunk = vec![0_u8; size];
        if reader.read_exact(&mut chunk).is_err() {
            break;
        }
        out.extend_from_slice(&chunk);
        // 每块后面跟一个 CRLF
        let mut crlf = [0_u8; 2];
        let _ = reader.read_exact(&mut crlf);
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn 发消息(port: u16, path: &str, message: &Value) -> 应答 {
    请求(
        port,
        "POST",
        path,
        &[
            ("Content-Type", "application/json"),
            ("Accept", "application/json, text/event-stream"),
        ],
        Some(&message.to_string()),
    )
}

fn 初始化(port: u16, path: &str) -> 应答 {
    发消息(
        port,
        path,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "测试", "version": "0" },
            },
        }),
    )
}

// ── 安全 ────────────────────────────────────────────────────────────────────

#[test]
fn 没有令牌打不进来() {
    let 服务 = 起一个();
    let 应答 = 初始化(服务.handle.port, "/mcp");
    assert_eq!(应答.status, 401, "不带令牌必须被拒");
}

#[test]
fn 令牌错了也打不进来() {
    let 服务 = 起一个();
    // 路径里只放 ASCII —— HTTP 的 request-target 不允许裸 UTF-8
    let 应答 = 初始化(服务.handle.port, "/mcp/not-the-token");
    assert_eq!(应答.status, 401);
}

#[test]
fn 令牌放路径里能进() {
    // Codex 的 `mcp add --url` 不支持自定义头，一键接入靠这条路
    let 服务 = 起一个();
    let 应答 = 初始化(服务.handle.port, &format!("/mcp/{}", 服务.handle.token));
    assert_eq!(应答.status, 200);
    assert_eq!(应答.json()["result"]["serverInfo"]["name"], json!("aiwf"));
}

#[test]
fn 令牌放_authorization_头里也能进() {
    // Claude Code 走这条：`claude mcp add --transport http … --header "Authorization: …"`
    let 服务 = 起一个();
    let 应答 = 请求(
        服务.handle.port,
        "POST",
        "/mcp",
        &[
            ("Content-Type", "application/json"),
            ("Authorization", &format!("Bearer {}", 服务.handle.token)),
        ],
        Some(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string()),
    );
    assert_eq!(应答.status, 200);
}

#[test]
fn 外站_origin_一律拒绝() {
    // DNS 重绑定：恶意网页把自己的域名解析到 127.0.0.1，
    // 然后从浏览器里直接打这个端口。挡它的就是这一条
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);

    for origin in [
        "https://evil.example.com",
        "http://attacker.test:8080",
        "http://127.0.0.1.evil.com",
        "http://localhost.evil.com",
    ] {
        let 应答 = 请求(
            服务.handle.port,
            "POST",
            &path,
            &[("Content-Type", "application/json"), ("Origin", origin)],
            Some(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string()),
        );
        assert_eq!(应答.status, 403, "Origin {origin} 必须被拒");
    }
}

#[test]
fn 本机_origin_放行() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);

    for origin in [
        "http://localhost:5173",
        "http://127.0.0.1:6274",
        "http://[::1]:1",
    ] {
        let 应答 = 请求(
            服务.handle.port,
            "POST",
            &path,
            &[("Content-Type", "application/json"), ("Origin", origin)],
            Some(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string()),
        );
        assert_eq!(应答.status, 200, "Origin {origin} 是本机的，该放行");
    }
}

#[test]
fn 不加_cors_头() {
    // 加一个 `Access-Control-Allow-Origin: *` 会让上面那条 Origin 校验作废。
    // 客户端是原生进程，不需要 CORS
    let 服务 = 起一个();
    let 应答 = 初始化(服务.handle.port, &format!("/mcp/{}", 服务.handle.token));
    assert!(应答.header("access-control-allow-origin").is_none());
}

// ── 协议 ────────────────────────────────────────────────────────────────────

#[test]
fn 协议版本按客户端要的回() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);

    for version in ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] {
        let 应答 = 发消息(
            服务.handle.port,
            &path,
            &json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": version, "capabilities": {} },
            }),
        );
        assert_eq!(
            应答.json()["result"]["protocolVersion"],
            json!(version),
            "客户端要 {version}，就该回 {version}"
        );
    }
}

#[test]
fn 不认识的协议版本回我们最偏好的那个() {
    // 写死一个版本的话，装着旧版客户端的机器会在握手时断开，
    // 而症状是「加了 server 但工具列表是空的」
    let 服务 = 起一个();
    let 应答 = 发消息(
        服务.handle.port,
        &format!("/mcp/{}", 服务.handle.token),
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "1999-01-01", "capabilities": {} },
        }),
    );
    assert_eq!(应答.status, 200);
    assert_eq!(
        应答.json()["result"]["protocolVersion"],
        json!("2025-11-25")
    );
}

#[test]
fn 协议版本头不认识时回_400() {
    let 服务 = 起一个();
    let 应答 = 请求(
        服务.handle.port,
        "POST",
        &format!("/mcp/{}", 服务.handle.token),
        &[
            ("Content-Type", "application/json"),
            ("MCP-Protocol-Version", "2019-01-01"),
        ],
        Some(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string()),
    );
    assert_eq!(应答.status, 400);
}

#[test]
fn initialize_回一个会话_id() {
    let 服务 = 起一个();
    let 应答 = 初始化(服务.handle.port, &format!("/mcp/{}", 服务.handle.token));
    let id = 应答
        .header("mcp-session-id")
        .expect("initialize 该带会话 id");
    assert!(!id.is_empty());
}

#[test]
fn 认不出的会话_id_回_404() {
    // 规范要求客户端据此重新 initialize。回 200 的话它会一直用一个
    // 我们其实没在跟踪的会话
    let 服务 = 起一个();
    let 应答 = 请求(
        服务.handle.port,
        "POST",
        &format!("/mcp/{}", 服务.handle.token),
        &[
            ("Content-Type", "application/json"),
            // 头值必须是 ASCII
            ("Mcp-Session-Id", "never-issued"),
        ],
        Some(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string()),
    );
    assert_eq!(应答.status, 404);
}

#[test]
fn 会话建立后能一直用_delete_能结束它() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    let id = 初始化(服务.handle.port, &path)
        .header("mcp-session-id")
        .unwrap()
        .to_string();

    let 带会话 = |method: &str| {
        请求(
            服务.handle.port,
            method,
            &path,
            &[
                ("Content-Type", "application/json"),
                ("Mcp-Session-Id", &id),
            ],
            Some(&json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }).to_string()),
        )
    };

    assert_eq!(带会话("POST").status, 200, "刚建的会话该能用");
    assert_eq!(带会话("DELETE").status, 204, "DELETE 结束会话");
    assert_eq!(带会话("POST").status, 404, "结束之后就不认了");
}

#[test]
fn 通知没有响应体_回_202() {
    // 规范：JSON-RPC 通知（没有 id）必须回 202 且没有 body。
    // 回一个 JSON-RPC 响应会让客户端认为协议出错
    let 服务 = 起一个();
    let 应答 = 发消息(
        服务.handle.port,
        &format!("/mcp/{}", 服务.handle.token),
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    );
    assert_eq!(应答.status, 202);
    assert!(应答.body.trim().is_empty(), "202 不该有 body");
}

#[test]
fn get_回_405_而不是挂着() {
    // 服务端不主动推消息。规范明说这时该回 405，客户端会照常工作；
    // 挂着不回会让客户端一直等一条永远不来的流
    let 服务 = 起一个();
    let 应答 = 请求(
        服务.handle.port,
        "GET",
        &format!("/mcp/{}", 服务.handle.token),
        &[("Accept", "text/event-stream")],
        None,
    );
    assert_eq!(应答.status, 405);
}

#[test]
fn 请求体不是_json_时回_400_而不是崩掉() {
    let 服务 = 起一个();
    let 应答 = 请求(
        服务.handle.port,
        "POST",
        &format!("/mcp/{}", 服务.handle.token),
        &[("Content-Type", "application/json")],
        Some("{这不是 JSON"),
    );
    assert_eq!(应答.status, 400);
    assert_eq!(应答.json()["error"]["code"], json!(-32700));
}

#[test]
fn 别的路径回_404() {
    let 服务 = 起一个();
    let 应答 = 请求(
        服务.handle.port,
        "POST",
        "/somewhere-else",
        &[("Authorization", &format!("Bearer {}", 服务.handle.token))],
        Some("{}"),
    );
    assert_eq!(应答.status, 404);
}

// ── 能力 ────────────────────────────────────────────────────────────────────

#[test]
fn 工具清单不是空的_且带着注解() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    );
    let tools = 应答.json()["result"]["tools"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "解析不出工具清单。status={} headers={:?} body 前 300 字节={}",
                应答.status,
                应答.headers,
                应答.body.chars().take(300).collect::<String>()
            )
        });

    assert!(tools.len() >= 40, "只暴露了 {} 个工具，太少了", tools.len());

    let list = tools
        .iter()
        .find(|t| t["name"] == json!("workflow_list"))
        .expect("workflow_list 该在");
    assert_eq!(list["annotations"]["readOnlyHint"], json!(true));
    assert_eq!(list["inputSchema"]["type"], json!("object"));
}

#[test]
fn 资源能读出来_而且不是空壳() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 清单 = 发消息(
        服务.handle.port,
        &path,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" }),
    );
    let resources = 清单.json()["result"]["resources"]
        .as_array()
        .cloned()
        .unwrap();
    assert!(resources.len() >= 6);

    for resource in resources {
        let uri = resource["uri"].as_str().unwrap().to_string();
        let 应答 = 发消息(
            服务.handle.port,
            &path,
            &json!({
                "jsonrpc": "2.0", "id": 3, "method": "resources/read",
                "params": { "uri": uri },
            }),
        );
        let text = 应答.json()["result"]["contents"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(
            text.len() > 200,
            "{uri} 只有 {} 字节 —— 空壳资源比没有更糟，\
             Agent 会以为自己已经了解了这个系统",
            text.len()
        );
    }
}

#[test]
fn 提示词模板展开后带着可照做的步骤() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "prompts/get",
            "params": { "name": "design_workflow", "arguments": { "goal": "修 issue" } },
        }),
    );
    let text = 应答.json()["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap()
        .to_string();

    assert!(text.contains("修 issue"), "目标要拼进去");
    assert!(text.contains("aiwf://catalog/nodes"), "要指路到节点目录");
    assert!(text.contains("Dry Run"), "要提醒先做依赖检查");
}

#[test]
fn 只读工具直接能调() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "workflow_list", "arguments": {} },
        }),
    );
    let result = &应答.json()["result"];
    assert_eq!(result["isError"], json!(false), "{result}");
    assert_eq!(result["structuredContent"]["total"], json!(0));
}

#[test]
fn 写操作在默认权限档下要先确认() {
    // 默认是 review_every_change。这条同时验证了两件事：
    // 写操作被挡住了，而且被挡的那次**进了待确认队列**——
    // 只挡不入队的话用户永远等不到那个确认弹层
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "workflow_create", "arguments": { "name": "试试" } },
        }),
    );
    let result = &应答.json()["result"];
    assert_eq!(result["isError"], json!(true));
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("确认"), "要说清在等什么：{text}");

    // 待确认队列里真的多了一条
    let 队列 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "workflow_list", "arguments": {} },
        }),
    );
    assert_eq!(
        队列.json()["result"]["structuredContent"]["total"],
        json!(0),
        "没确认之前不该真的建出来"
    );
}

#[test]
fn 确认通道自己调不到() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "mcp_decide_confirm", "arguments": { "id": "x", "approved": true } },
        }),
    );
    let result = &应答.json()["result"];
    assert_eq!(result["isError"], json!(true));
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("不对 MCP 开放"),
        "要说清为什么，不然下一个人会以为是漏了：{text}"
    );
}

#[test]
fn 工具调用失败时把_hint_一起带出去() {
    // hint 是「接下来该干什么」。丢掉它，Agent 就只知道「失败了」，
    // 然后原样再试一次
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "workflow_get", "arguments": { "id": "查无此流" } },
        }),
    );
    let result = &应答.json()["result"];
    assert_eq!(result["isError"], json!(true));
}

#[test]
fn 调一个不存在的工具时指路到_tools_list() {
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 应答 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "workflow_summon", "arguments": {} },
        }),
    );
    let text = 应答.json()["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(text.contains("tools/list"), "{text}");
}

#[test]
fn 用户批准之后再调一次就真的执行了() {
    // 这条通道原本在第三步断掉：`call_tool` 每次都无条件重跑 gate_for，
    // 而**没有任何一处代码读 status = 'approved'**。
    // 于是默认档下 40 多个写工具一个都用不了 —— 用户点了「批准」，
    // 卡片消失，agent 再调一次仍然被挡，而且又入队一条新的。
    //
    // 上一条测试只断言「被挡住 + 进了队列」，从不批准、也不再调一次，
    // 正好把断掉的那一步盖住了。
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 建工作流 = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "workflow_create", "arguments": { "name": "批准之后才该出现" } },
    });

    // 第一次：被挡下并入队
    let 第一次 = 发消息(服务.handle.port, &path, &建工作流);
    assert_eq!(第一次.json()["result"]["isError"], json!(true));

    // 用户在应用里点「同意」—— 确认通道刻意不对 MCP 开放，
    // 所以这里自己开一条连接扮演那一步
    {
        let store = aiwf_store::Store::open(&服务.db).unwrap();
        let 待办 = store.pending_confirmations().unwrap();
        assert_eq!(待办.len(), 1, "第一次调用没进待确认队列");
        aiwf_core_api::mcp_decide_confirm(&store, 待办[0].id.clone(), true).unwrap();
    }

    // 第二次：同样的入参，这次该真的建出来
    let 第二次 = 发消息(服务.handle.port, &path, &建工作流);
    let result = &第二次.json()["result"];
    assert_eq!(
        result["isError"],
        json!(false),
        "批准之后仍然被挡：{result}"
    );

    let 列表 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "workflow_list", "arguments": {} },
        }),
    );
    assert_eq!(
        列表.json()["result"]["structuredContent"]["total"],
        json!(1),
        "批准之后工作流还是没建出来"
    );

    let store = aiwf_store::Store::open(&服务.db).unwrap();
    assert!(
        store.pending_confirmations().unwrap().is_empty(),
        "认领之后队列该空了 —— 不然用户会被同一个弹层反复砸"
    );
}

#[test]
fn 一次批准只换一次执行() {
    // 防重放：拿着一条旧批准把同一个写操作重复做任意多次，
    // 而用户以为自己只批准了一次
    let 服务 = 起一个();
    let path = format!("/mcp/{}", 服务.handle.token);
    初始化(服务.handle.port, &path);

    let 建工作流 = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "workflow_create", "arguments": { "name": "只该有一个" } },
    });

    发消息(服务.handle.port, &path, &建工作流);
    {
        let store = aiwf_store::Store::open(&服务.db).unwrap();
        let 待办 = store.pending_confirmations().unwrap();
        aiwf_core_api::mcp_decide_confirm(&store, 待办[0].id.clone(), true).unwrap();
    }

    发消息(服务.handle.port, &path, &建工作流); // 认领掉那条批准
    let 第三次 = 发消息(服务.handle.port, &path, &建工作流); // 该重新要确认了
    assert_eq!(
        第三次.json()["result"]["isError"],
        json!(true),
        "同一条批准被用了第二次"
    );

    let 列表 = 发消息(
        服务.handle.port,
        &path,
        &json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "workflow_list", "arguments": {} },
        }),
    );
    assert_eq!(
        列表.json()["result"]["structuredContent"]["total"],
        json!(1)
    );
}
