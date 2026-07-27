//! 脚本节点的执行。
//!
//! 三件必须真做对的事：**超时要真的杀掉进程**、**输出要有上限**、
//! **失败要能指出该查哪里**。任何一件做假，用户第一次遇到跑飞的脚本时就会发现。

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 单个流的输出上限。超过就截断并标记 —— 一个跑飞的 Agent 刷几百 MB 日志是真会发生的。
const MAX_OUTPUT_BYTES: usize = 1_000_000;

/// 进程收尾后，最多再等这么久把管道读完。
///
/// 正常情况下进程一退管道立刻 EOF，这个等待是 0。它存在只为一种情况：
/// 脚本留下的后代进程还攥着写端，而杀进程组那一刀没砍中。
const DRAIN_GRACE: Duration = Duration::from_millis(300);

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

    let mut command = Command::new(&request.interpreter);
    command
        .arg("-c")
        .arg(&request.script)
        .current_dir(&request.workdir)
        .envs(request.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 自成进程组：超时时才能一次杀掉脚本起的所有后代。
    //
    // 只杀直接子进程（那个 shell）的话，`sleep 30 &` 这种后台进程会继承
    // stdout 写端继续活着，读管道的线程永远等不到 EOF ——
    // 超时设 400ms，实测卡住 30 秒。
    //
    // `process_group(0)` 是安全 API（Rust 1.64+）：0 表示新建一个组，
    // 组 id 就是子进程的 pid。workspace 级 forbid unsafe，用不了 setsid。
    command.process_group(0);

    let mut child = command.spawn().map_err(|source| ExecError::Spawn {
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
    let out_buf = drain(out_pipe);
    let err_buf = drain(err_pipe);

    let status = wait_with_timeout(&mut child, request.timeout);

    // 无论超时还是正常结束，都要确保后代进程不再攥着管道。
    // 脚本自己秒退但留了个后台进程时，不收这一刀就会在下面 recv 上等到天荒地老
    kill_process_group(&child);

    // 给读线程一点时间把剩下的读完，然后**直接取走已读到的部分**。
    //
    // 这里刻意不等 EOF：脚本留下的后代进程会攥着写端不放，
    // 而 kill 那一刀的语法在 BSD 与 GNU 之间有出入，未必砍得中。
    // 已经读到手的输出照样有用，比整个引擎卡住强。
    std::thread::sleep(DRAIN_GRACE);
    let (stdout, out_truncated) = take(&out_buf);
    let (stderr, err_truncated) = take(&err_buf);

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

/// 等进程结束，超时就杀掉整个进程组。
///
/// 返回 None 表示超时。杀完还要 wait 一次回收僵尸进程。
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            kill_process_group(child);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 杀掉脚本所在的整个进程组。
///
/// 子进程用 `process_group(0)` 自成一组，组 id 等于它的 pid，
/// 所以「杀这个组」就是给 kill 传负的 pid。
///
/// 借外部命令而不是 libc::killpg，是因为 workspace 级 forbid unsafe。
/// 两种写法都试：BSD 的 kill 认 `-KILL -123`，GNU 的要 `-s KILL -- -123`，
/// 而这两种系统我们都要跑（开发在 macOS，CI 在 Linux）。
///
/// 幂等：组里已经没进程了 kill 返回非零，无所谓。
fn kill_process_group(child: &Child) {
    let pid = child.id();
    if pid == 0 {
        return;
    }
    let group = format!("-{pid}");

    let posix = Command::new("kill")
        .args(["-s", "KILL", "--", &group])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if !posix.is_ok_and(|status| status.success()) {
        let _ = Command::new("kill")
            .args(["-KILL", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// 读线程收集到的东西。用共享缓冲区而不是 channel：
/// channel 只在 EOF 后发一次，而我们需要「随时取走目前读到的部分」——
/// 被后代进程攥住的管道永远不会 EOF。
type Collected = Arc<Mutex<(Vec<u8>, bool)>>;

/// 起一个线程把管道读干净，边读边往共享缓冲区里追加。
fn drain<R: Read + Send + 'static>(mut reader: R) -> Collected {
    let collected: Collected = Arc::new(Mutex::new((Vec::new(), false)));
    let sink = collected.clone();

    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let Ok(mut slot) = sink.lock() else { break };
                    let (bytes, truncated) = &mut *slot;
                    if bytes.len() < MAX_OUTPUT_BYTES {
                        let room = MAX_OUTPUT_BYTES - bytes.len();
                        bytes.extend_from_slice(&buffer[..n.min(room)]);
                        if n > room {
                            *truncated = true;
                        }
                    } else {
                        // 已经满了，但仍要继续读干净，否则子进程会阻塞在写上
                        *truncated = true;
                    }
                }
            }
        }
    });

    collected
}

/// 取走目前读到的内容。读线程可能还在跑，那不影响 —— 它只会往后追加。
fn take(collected: &Collected) -> (String, bool) {
    collected.lock().map_or_else(
        |_| (String::new(), true),
        |slot| {
            let (bytes, truncated) = &*slot;
            (String::from_utf8_lossy(bytes).into_owned(), *truncated)
        },
    )
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
