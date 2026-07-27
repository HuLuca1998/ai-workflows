//! 脚本节点的执行。
//!
//! 三件必须真做对的事：**超时要真的杀掉进程**、**输出要有上限**、
//! **失败要能指出该查哪里**。任何一件做假，用户第一次遇到跑飞的脚本时就会发现。

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 单个流的输出上限。超过就截断并标记 —— 一个跑飞的 Agent 刷几百 MB 日志是真会发生的。
const MAX_OUTPUT_BYTES: usize = 1_000_000;

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("工作目录不存在或不可用：{path}")]
    Workdir { path: String },
    #[error("无法启动解释器 {interpreter}：{source}")]
    Spawn {
        interpreter: String,
        source: std::io::Error,
    },
    #[error("读取脚本输出失败：{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ExecError>;

pub struct ScriptRequest {
    pub interpreter: String,
    pub script: String,
    pub workdir: PathBuf,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    /// 与节点定义一致：text | json | lines
    pub output_parse: String,
}

#[derive(Debug)]
pub enum ExecOutcome {
    Completed {
        code: i32,
        stdout: String,
        stderr: String,
        /// output_parse 要求结构化时的解析结果。
        parsed: Option<serde_json::Value>,
        /// 解析失败的原因。**不算脚本失败** —— 该查的是 outputParse 配置，不是脚本。
        parse_error: Option<String>,
        truncated: bool,
        duration: Duration,
    },
    TimedOut {
        stdout: String,
        stderr: String,
        timeout: Duration,
    },
}

pub fn run_script(request: ScriptRequest) -> Result<ExecOutcome> {
    if !request.workdir.is_dir() {
        return Err(ExecError::Workdir {
            path: request.workdir.display().to_string(),
        });
    }

    let started = Instant::now();

    let mut child = Command::new(&request.interpreter)
        .arg("-c")
        .arg(&request.script)
        .current_dir(&request.workdir)
        .envs(request.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|source| ExecError::Spawn {
            interpreter: request.interpreter.clone(),
            source,
        })?;

    // stdout / stderr 必须并发读：只读一个的话，另一个填满管道缓冲区就会死锁，
    // 而这个死锁只在输出量大的时候出现 —— 正是最难查的那类问题。
    let (Some(out_pipe), Some(err_pipe)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err(ExecError::Io(std::io::Error::other(
            "无法获取子进程的输出管道",
        )));
    };
    let (out_rx, out_handle) = drain(out_pipe);
    let (err_rx, err_handle) = drain(err_pipe);

    let status = wait_with_timeout(&mut child, request.timeout);

    let (stdout, out_truncated) = out_rx.recv().unwrap_or_default();
    let (stderr, err_truncated) = err_rx.recv().unwrap_or_default();
    let _ = out_handle.join();
    let _ = err_handle.join();

    let Some(status) = status else {
        return Ok(ExecOutcome::TimedOut {
            stdout,
            stderr,
            timeout: request.timeout,
        });
    };

    let (parsed, parse_error) = parse_output(&request.output_parse, &stdout);

    Ok(ExecOutcome::Completed {
        // 被信号杀死时没有退出码，用 -1 表示「非正常结束」
        code: status.code().unwrap_or(-1),
        stdout,
        stderr,
        parsed,
        parse_error,
        truncated: out_truncated || err_truncated,
        duration: started.elapsed(),
    })
}

/// 等进程结束，超时就杀掉。
///
/// 返回 None 表示超时。杀完还要 wait 一次回收僵尸进程。
fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 后台线程把一个管道读干净，带上限。
fn drain<R: Read + Send + 'static>(
    mut reader: R,
) -> (mpsc::Receiver<(String, bool)>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let mut collected: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if collected.len() < MAX_OUTPUT_BYTES {
                        let room = MAX_OUTPUT_BYTES - collected.len();
                        collected.extend_from_slice(&buffer[..n.min(room)]);
                        if n > room {
                            truncated = true;
                        }
                    } else {
                        // 已经满了，但仍要继续读干净，否则子进程会阻塞在写上
                        truncated = true;
                    }
                }
            }
        }
        let _ = tx.send((String::from_utf8_lossy(&collected).into_owned(), truncated));
    });
    (rx, handle)
}

fn parse_output(mode: &str, stdout: &str) -> (Option<serde_json::Value>, Option<String>) {
    match mode {
        "json" => match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
            Ok(value) => (Some(value), None),
            Err(error) => (
                None,
                Some(format!(
                    "输出不是合法 JSON：{error}。检查节点的「输出解析」设置"
                )),
            ),
        },
        "lines" => {
            let lines: Vec<serde_json::Value> = stdout
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::Value::String(line.to_string()))
                .collect();
            (Some(serde_json::Value::Array(lines)), None)
        }
        _ => (None, None),
    }
}
