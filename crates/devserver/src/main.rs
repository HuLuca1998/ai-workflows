//! 开发用 HTTP 桥接：让浏览器里的 Web 形态连上真实引擎。
//!
//! **只用于本地开发与端到端测试**：没有鉴权，只绑 127.0.0.1。
//! 生产的 Web 形态（M6）要走 tRPC + SSE + 会话鉴权，不是这个。
//!
//! 它存在的理由是测试：桌面壳的 WKWebView 没法用浏览器工具驱动，
//! 而「UI 点下去引擎真的动了」这件事必须能被自动化验证。
//! 命令实现共用 `aiwf-core-api`，所以测的就是桌面版跑的那套逻辑。

use std::sync::{Arc, Mutex};

use aiwf_core_api as api;
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::{Value, json};

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

    // 先开一次：建表与迁移在这里做完，工作线程各自开连接时就只是连上去。
    // 让 16 个线程同时跑迁移会撞锁
    // open_workspace 而不是 open：这一次是初始化工作区（迁移 + 内置数据），
    // 下面每个工作线程只是再开一条连接
    match Store::open_workspace(&path) {
        Ok(store) => {
            // 孤儿扫描只在执行宿主启动时做（devserver 拥有 Supervisor）。
            // aiwf-mcp 共库时不扫 —— 它会误伤这里正在跑的运行
            if let Err(error) = store.mark_orphan_runs() {
                eprintln!("孤儿运行扫描失败（不影响启动）：{error}");
            }
        }
        Err(error) => {
            eprintln!("无法打开数据库 {db_path}：{error}");
            std::process::exit(1);
        }
    }
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

    // 固定大小的工作线程池。
    //
    // 串行处理的话，一个慢请求会堵死整个后端 —— 而慢请求很日常：
    // supervisor.ask 和 AI 节点都要连 ACP adapter，超时是 180 秒。
    // 症状是界面**整个卡死**：列表转圈不出、切页也没反应，
    // DevTools 里所有请求 stalled、0 B transferred。
    //
    // 用固定线程池而不是「每请求一线程」：后者在一个失控的客户端面前
    // 会开出成千上万个线程，每个都要一份栈。
    let server = Arc::new(server);
    let supervisor = Arc::new(supervisor);
    let data_dir = Arc::new(data_dir);

    // 每个线程一份**自己的**数据库连接。
    //
    // 共用一个 Mutex<Store> 的话，线程池救不了任何东西：慢请求整段
    // 都握着那把锁，别的线程照样排队。存储是 SQLite WAL，
    // 本来就支持多连接并发读 —— 写由 SQLite 自己串行化。
    // 引擎里每个运行一个线程一份连接，用的也是这个办法。
    let mut workers = Vec::with_capacity(WORKER_COUNT);
    for index in 0..WORKER_COUNT {
        let server = Arc::clone(&server);
        let supervisor = Arc::clone(&supervisor);
        let data_dir = Arc::clone(&data_dir);
        let db = db_path.clone();

        workers.push(std::thread::spawn(move || {
            let store = match Store::open(std::path::Path::new(&db)) {
                Ok(store) => Mutex::new(store),
                Err(error) => {
                    eprintln!("线程 {index} 打不开数据库：{error}");
                    return;
                }
            };

            // recv 是线程安全的：tiny_http 内部用一个共享队列，
            // 多个线程同时收，谁先拿到谁处理
            while let Ok(request) = server.recv() {
                handle(request, &store, &supervisor, &data_dir);
            }
        }));
    }

    for worker in workers {
        let _ = worker.join();
    }
}

/// 同时处理请求的线程数。
///
/// 慢请求（连 ACP adapter）能占住一个线程好几分钟，
/// 所以要比「CPU 核数」宽裕得多 —— 这些线程大部分时间在等 I/O。
const WORKER_COUNT: usize = 16;

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

    let (status, payload) = match aiwf_core_api::dispatch::dispatch(
        &command, &input, store, supervisor, data_dir,
    ) {
        Ok(value) => (200, value),
        // 整个结构体序列化，不手拼字段 —— 手拼那版漏了 hint，
        // 于是「接下来该干什么」在引擎里填好了却到不了界面
        Err(error) => (
            400,
            serde_json::to_value(&error).unwrap_or_else(
                |_| json!({ "code": "INTERNAL", "message": "错误序列化失败", "retriable": false }),
            ),
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
