//! 一个慢请求不能堵死整个后端。
//!
//! 症状是界面**整个卡死**：提示词库转圈不出、切页也没反应，
//! DevTools 里所有请求都 stalled、0 B transferred。
//!
//! 而真实触发条件很日常：跑一个 AI 节点。它连 ACP adapter，
//! 超时是 180 秒 —— 单线程串行处理的话，那三分钟里整个应用是死的。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// 给每个测试一个独立的序号。同一个端口起两个 server 会撞。
static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// 起好的 devserver。析构时保证收割进程 ——
/// 只调 kill 不调 wait 会留下僵尸，而测试断言失败时那条路径最容易漏掉。
struct Server {
    child: std::process::Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 起一个 devserver，返回端口。
///
/// `allow(zombie_processes)`：进程由 [`Server`] 的 Drop 收割
/// （kill + wait 都在那里），但 clippy 的分析不跨结构体，
/// 看不到那一步。
#[allow(clippy::zombie_processes)]
///
/// 工作目录里放一个**会卡住的假 adapter**：真实场景里 supervisor.ask
/// 与 AI 节点都会去连它，超时是 180 秒。没有它的话
/// supervisor_ask 立刻返回「adapter 没装」，测不出串行的问题。
fn spawn_server() -> Server {
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("aiwf-dev-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("test.sqlite");
    let _ = std::fs::remove_file(&db);

    // adapter_installed 找的是这个相对路径
    let bin_dir = dir.join("services/acp-sidecar/node_modules/.bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let fake = bin_dir.join("claude-agent-acp");
    std::fs::write(&fake, "#!/bin/sh\nsleep 300\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // 端口从进程 id + 序号派生：同一个进程里的多个测试也要错开
    let port = 15_000 + (std::process::id() % 5_000) as u16 * 2 + seq;

    let exe = std::path::Path::new(env!("CARGO_BIN_EXE_aiwf-devserver"));
    let child = std::process::Command::new(exe)
        .arg("--port")
        .arg(port.to_string())
        .arg("--db")
        .arg(&db)
        // cwd 指向临时目录，让 adapter_installed 找到那个会卡住的假 adapter
        .current_dir(&dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("起 devserver");

    // 等它监听起来
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Server { child, port };
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("devserver 没起来");
}

/// 发一个 IPC 请求，返回响应体。
fn post(port: u16, command: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    // 不发 Connection: close —— tiny_http 对它的处理会让响应体读不出来。
    // 改成读到响应头结束就够：这里只关心「有没有及时回」
    let request = format!(
        "POST /ipc/{command} HTTP/1.1\r\nHost: localhost\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).unwrap();

    let mut buffer = [0_u8; 4096];
    let read = stream.read(&mut buffer).unwrap_or(0);
    String::from_utf8_lossy(&buffer[..read]).to_string()
}

#[test]
fn 一个慢请求不挡住其他请求() {
    let server = spawn_server();
    let port = server.port;

    // 起一个会卡住的请求：不存在的 adapter 会让 supervisor.ask 等到超时。
    // 这里用 run_start 起一个 AI 节点更接近真实场景，但那要先建工作流；
    // supervisor_ask 更直接 —— 它同样会去连 adapter
    let slow = std::thread::spawn(move || {
        post(port, "supervisor_ask", r#"{"question":"卡住我"}"#);
    });

    // 给慢请求一点时间真的开始
    std::thread::sleep(Duration::from_millis(400));

    // 与此同时来一个普通的读请求。串行处理的话它会一直排队
    let started = Instant::now();
    let response = post(port, "workflow_list", "{}");
    let elapsed = started.elapsed();

    assert!(
        response.contains("200 OK"),
        "读请求应当正常返回，实际：{}",
        response.lines().next().unwrap_or("")
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "读请求等了 {elapsed:?} —— 被慢请求堵住了"
    );

    // 先关服务再 join：慢请求要等 adapter 超时才返回，
    // 而进程一关它的连接立刻断，join 就不用干等
    drop(server);
    let _ = slow.join();
}

#[test]
fn 多个请求可以同时在跑() {
    let server = spawn_server();
    let port = server.port;

    let started = Instant::now();
    let handles: Vec<_> = (0..8)
        .map(|_| std::thread::spawn(move || post(port, "workflow_list", "{}")))
        .collect();

    for handle in handles {
        let response = handle.join().unwrap();
        assert!(response.contains("200 OK"), "并发请求失败：{response}");
    }

    // 8 个读请求串行也很快，这条主要保证它们不会互相报错
    assert!(started.elapsed() < Duration::from_secs(10));
}
