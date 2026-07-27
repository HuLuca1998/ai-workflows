//! 开发用 HTTP 桥接：让浏览器里的 Web 形态连上真实引擎。
//!
//! **只用于本地开发与端到端测试**：没有鉴权，只绑 127.0.0.1。
//! 生产的 Web 形态（M6）要走 tRPC + SSE + 会话鉴权，不是这个。
//!
//! 它存在的理由是测试：桌面壳的 WKWebView 没法用浏览器工具驱动，
//! 而「UI 点下去引擎真的动了」这件事必须能被自动化验证。
//! 命令实现共用 `aiwf-core-api`，所以测的就是桌面版跑的那套逻辑。

use std::sync::Mutex;

use aiwf_core_api as api;
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::{Value, json};

mod dispatch;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = arg(&args, "--port").unwrap_or_else(|| "5177".to_string());
    let db_path = arg(&args, "--db").unwrap_or_else(|| {
        std::env::temp_dir()
            .join("aiwf-devserver")
            .join("aiwf.sqlite")
            .display()
            .to_string()
    });

    let path = std::path::PathBuf::from(&db_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let store = match Store::open(&path) {
        Ok(store) => Mutex::new(store),
        Err(error) => {
            eprintln!("无法打开数据库 {db_path}：{error}");
            std::process::exit(1);
        }
    };
    // 默认运行目录跟着数据库走：一个测试库对应一份运行数据，互不干扰
    let data_dir = path
        .parent()
        .map_or_else(std::env::temp_dir, std::path::Path::to_path_buf);
    let supervisor = Supervisor::new(path);

    let address = format!("127.0.0.1:{port}");
    let server = match tiny_http::Server::http(&address) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("无法监听 {address}：{error}");
            std::process::exit(1);
        }
    };

    println!("aiwf devserver 已启动");
    println!("  地址：http://{address}");
    println!("  数据库：{db_path}");
    println!("  命令：{} 个", api::COMMANDS.len());

    for request in server.incoming_requests() {
        handle(request, &store, &supervisor, &data_dir);
    }
}

fn handle(
    mut request: tiny_http::Request,
    store: &Mutex<Store>,
    supervisor: &Supervisor,
    data_dir: &std::path::Path,
) {
    // 浏览器从 5173 打过来，开发期放行跨域
    let cors: Vec<tiny_http::Header> = [
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Allow-Headers", "content-type"),
        header("Access-Control-Allow-Methods", "POST, OPTIONS"),
        header("Content-Type", "application/json; charset=utf-8"),
    ]
    .into_iter()
    .flatten()
    .collect();

    if request.method() == &tiny_http::Method::Options {
        let mut response = tiny_http::Response::empty(204);
        for h in cors {
            response.add_header(h);
        }
        let _ = request.respond(response);
        return;
    }

    let url = request.url().to_string();
    let command = url.strip_prefix("/ipc/").unwrap_or("").to_string();

    let mut body = String::new();
    let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
    let input: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));

    let (status, payload) = match dispatch::dispatch(&command, &input, store, supervisor, data_dir)
    {
        Ok(value) => (200, value),
        Err(error) => (
            400,
            json!({
                "code": error.code,
                "message": error.message,
                "retriable": error.retriable,
            }),
        ),
    };

    let text = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string());
    let mut response = tiny_http::Response::from_string(text).with_status_code(status);
    for h in cors {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

/// 构造响应头。名与值都是本文件里的字面量，解析不会失败；
/// 真失败了也只是少一个头，不值得让整个服务崩掉。
fn header(name: &str, value: &str) -> Option<tiny_http::Header> {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    let index = args.iter().position(|a| a == flag)?;
    args.get(index + 1).cloned()
}
