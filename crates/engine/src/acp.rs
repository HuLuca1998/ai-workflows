//! ACP 客户端：与 agent adapter 说 JSON-RPC over stdio。
//!
//! 协议形状取自实测（见 docs/adr/0002）：
//!
//! ```text
//! → initialize   ← protocolVersion + agentCapabilities
//! → session/new  ← sessionId + modes（权限档位，不是模型列表）
//! → session/prompt
//!                ← 通知 session/update（流式文本、工具调用）
//!                ← stopReason
//! ```
//!
//! 「ACP 握手只返回协议能力与 session modes，不返回可用模型」——
//! 所以模型要在「模型」页登记，这条在图纸里写着，实测也确认了。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("无法启动 adapter {command}：{source}")]
    Spawn {
        command: String,
        source: std::io::Error,
    },
    #[error("adapter 的协议版本是 {got}，本引擎要的是 {want}。adapter 与 CLI 版本要成对锁定")]
    ProtocolVersion { got: i64, want: i64 },
    #[error("等 adapter 响应超时（{0:?}）")]
    Timeout(Duration),
    #[error("adapter 进程已退出或连接断开")]
    Disconnected,
    #[error("adapter 报错：{0}")]
    Remote(String),
    #[error("adapter 的响应不合协议：{0}")]
    Malformed(String),
    #[error("写入 adapter 失败：{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, AcpError>;

/// 本引擎支持的协议版本。adapter 报别的版本就拒绝连接 ——
/// 「适配器与 CLI 版本要成对锁定，避免出现模型元数据错配」。
pub const PROTOCOL_VERSION: i64 = 1;

/// 一次会话。`modes` 是权限档位，不是模型。
#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub current_mode: String,
    pub modes: Vec<SessionMode>,
}

#[derive(Debug, Clone)]
pub struct SessionMode {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// 会话过程中的增量更新。界面的对话视图与事件流都由它们喂养。
#[derive(Debug, Clone)]
pub enum SessionUpdate<'a> {
    /// Agent 的流式文本。
    AgentText { text: &'a str },
    /// 推理摘要（有的 adapter 会单独给）。
    Reasoning { text: &'a str },
    /// 工具调用。图纸对话视图里「工具活动 · 6 次读取」的数字来自这里。
    ///
    /// `id` 是必须的：ACP 的首帧（`tool_call`）带标题，
    /// 更新帧（`tool_call_update`）**只带 id 与状态**。
    /// 不把 id 交出去的话，上层拿到的完成帧是一条「（completed）」，
    /// 说不出完成的是哪一次调用。
    ToolCall {
        id: &'a str,
        title: &'a str,
        status: &'a str,
    },
    /// 其余类型原样带过去，界面可以按需展示而不必改这里。
    Other { kind: &'a str, raw: &'a Value },
}

/// 一轮提示词的结束方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOutcome {
    EndTurn,
    MaxTokens,
    Refusal,
    Cancelled,
    Other,
}

impl PromptOutcome {
    fn parse(reason: &str) -> Self {
        match reason {
            "end_turn" => Self::EndTurn,
            "max_tokens" => Self::MaxTokens,
            "refusal" => Self::Refusal,
            "cancelled" => Self::Cancelled,
            _ => Self::Other,
        }
    }
}

/// 从 adapter 收到的一条消息：要么是某个请求的应答，要么是通知。
enum Incoming {
    Response {
        id: i64,
        result: Result<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// Agent 回头问客户端的请求（有 method **也有** id）。
    ///
    /// 不区分它、当成通知吞掉的话，agent 会一直等我们应答，而我们
    /// 一直等它的回答 —— 双方互等到超时。症状是主管 AI 转圈几十秒
    /// 然后报超时，而两边的日志都看不出谁在等谁。
    Request {
        id: i64,
        method: String,
        params: Value,
    },
}

/// 一个要接给 agent 的 MCP server。
///
/// 只做 HTTP：这个应用的系统 MCP 是进程内的 HTTP 服务，没有 stdio 形态。
/// 两个 adapter 都声明了 `mcpCapabilities.http`（实测 codex-acp 1.1.7
/// 与 claude-agent-acp 都是 true）——不支持的 agent 会拿到一个空列表，
/// 那时它仍然能跑，只是没有工具。
#[derive(Debug, Clone)]
pub struct McpHttpServer {
    pub name: String,
    pub url: String,
    /// 请求头。系统 MCP 的令牌走 `Authorization: Bearer`。
    pub headers: Vec<(String, String)>,
}

pub struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    incoming: Receiver<Incoming>,
    next_id: i64,
    timeout: Duration,
    protocol_version: i64,
    capabilities: Value,
}

impl AcpClient {
    /// 启动 adapter 并握手。
    ///
    /// `env_remove` 是要从环境里清掉的变量：应用可能从某个 agent 会话的
    /// 终端里启动，继承了宿主的嵌套标记，不清掉的话 adapter 会误判
    /// 自己运行在另一个 agent 内部而拒绝服务。
    pub fn connect(
        command: &str,
        args: &[String],
        env_remove: &[String],
        timeout: Duration,
    ) -> Result<Self> {
        // 走 tooling：adapter 是 node 脚本，起它要找得到 node，
        // 而打包版继承的 PATH 里没有。探测那边说「已就绪」、这边
        // spawn 报 No such file or directory，是同一个根因的两种表现
        let mut builder = crate::tooling::command(command);
        builder
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for key in env_remove {
            builder.env_remove(key);
        }
        // 自成进程组：adapter 可能再起子进程，收尾时要能一次杀干净
        builder.process_group(0);

        let mut child = builder.spawn().map_err(|source| AcpError::Spawn {
            command: command.to_string(),
            source,
        })?;

        let stdin = child.stdin.take().ok_or(AcpError::Disconnected)?;
        let stdout = child.stdout.take().ok_or(AcpError::Disconnected)?;
        // stderr 单独排空：不读的话管道填满后 adapter 会阻塞在写上
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr)
                    .lines()
                    .map_while(std::result::Result::ok)
                {
                    if !line.trim().is_empty() {
                        eprintln!("[acp] {line}");
                    }
                }
            });
        }

        let incoming = spawn_reader(stdout);

        let mut client = Self {
            child,
            stdin,
            incoming,
            next_id: 1,
            timeout,
            protocol_version: 0,
            capabilities: Value::Null,
        };

        let handshake = client.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
            }),
        )?;

        let version = handshake
            .get("protocolVersion")
            .and_then(Value::as_i64)
            .ok_or_else(|| AcpError::Malformed("握手没有 protocolVersion".to_string()))?;
        if version != PROTOCOL_VERSION {
            return Err(AcpError::ProtocolVersion {
                got: version,
                want: PROTOCOL_VERSION,
            });
        }

        client.protocol_version = version;
        client.capabilities = handshake
            .get("agentCapabilities")
            .cloned()
            .unwrap_or(Value::Null);
        Ok(client)
    }

    pub fn protocol_version(&self) -> i64 {
        self.protocol_version
    }

    pub fn capabilities(&self) -> &Value {
        &self.capabilities
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 新建会话。`cwd` 是 agent 的工作目录 —— 它读写文件都在这里面。
    pub fn new_session(&mut self, cwd: &str) -> Result<Session> {
        self.new_session_with_mcp(cwd, &[])
    }

    /// 新建会话，并把这些 MCP server 接给 agent。
    ///
    /// 这是「让 AI 真的能操作这个系统」的那一环：不接的话，AI 节点与
    /// 主管 AI 都只能凭提示词里的文字描述工作 —— 它们读不到当前有哪些
    /// 工作流、改不动草稿、也看不到自己上一步跑出了什么。
    ///
    /// agent 不支持 http 传输时不发这一段：发过去多半会让 `session/new`
    /// 直接失败，而那比「没有工具」糟得多。
    pub fn new_session_with_mcp(
        &mut self,
        cwd: &str,
        servers: &[McpHttpServer],
    ) -> Result<Session> {
        let supports_http = self
            .capabilities
            .get("mcpCapabilities")
            .and_then(|caps| caps.get("http"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mcp_servers: Vec<Value> = if supports_http {
            servers
                .iter()
                .map(|server| {
                    json!({
                        "type": "http",
                        "name": server.name,
                        "url": server.url,
                        "headers": server.headers.iter().map(|(name, value)| json!({
                            "name": name, "value": value,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect()
        } else {
            Vec::new()
        };

        let result = self.request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": mcp_servers }),
        )?;

        let id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| AcpError::Malformed("session/new 没有 sessionId".to_string()))?
            .to_string();

        let modes_node = result.get("modes");
        let current_mode = modes_node
            .and_then(|m| m.get("currentModeId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let modes = modes_node
            .and_then(|m| m.get("availableModes"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| SessionMode {
                        id: text(item, "id"),
                        name: text(item, "name"),
                        description: text(item, "description"),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(Session {
            id,
            current_mode,
            modes,
        })
    }

    /// 发一轮提示词。流式更新通过 `on_update` 回调交出去 ——
    /// 攒完再返回的话，界面就看不到 agent 正在做什么了。
    pub fn prompt(
        &mut self,
        session_id: &str,
        text: &str,
        mut on_update: impl FnMut(SessionUpdate<'_>),
    ) -> Result<PromptOutcome> {
        let id = self.send(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
        )?;

        loop {
            match self.incoming.recv_timeout(self.timeout) {
                Ok(Incoming::Notification { method, params }) => {
                    if method == "session/update" {
                        dispatch_update(&params, &mut on_update);
                    }
                }
                Ok(Incoming::Request { id, method, params }) => {
                    self.answer_reverse_call(id, &method, &params)?;
                }
                Ok(Incoming::Response {
                    id: got,
                    result: Ok(value),
                }) if got == id => {
                    let reason = value
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("other");
                    return Ok(PromptOutcome::parse(reason));
                }
                Ok(Incoming::Response {
                    result: Err(error), ..
                }) => return Err(error),
                // 别的请求的应答：这一版是串行调用，不该出现，忽略
                Ok(Incoming::Response { .. }) => {}
                Err(RecvTimeoutError::Timeout) => return Err(AcpError::Timeout(self.timeout)),
                Err(RecvTimeoutError::Disconnected) => return Err(AcpError::Disconnected),
            }
        }
    }

    /// 取消当前这一轮。adapter 会把已经开始的工具调用收尾后停下。
    pub fn cancel(&mut self, session_id: &str) -> Result<()> {
        self.request("session/cancel", json!({ "sessionId": session_id }))?;
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.send(method, params)?;
        loop {
            match self.incoming.recv_timeout(self.timeout) {
                Ok(Incoming::Response { id: got, result }) if got == id => return result,
                // 反向请求在这条路径上也可能来（建会话时问权限），同样要应答 ——
                // 只在 prompt 里处理的话，卡的就是 session/new
                Ok(Incoming::Request {
                    id: ask,
                    method: ask_method,
                    params: ask_params,
                }) => self.answer_reverse_call(ask, &ask_method, &ask_params)?,
                // 握手与建会话期间也会来通知（available_commands_update 等），跳过
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => return Err(AcpError::Timeout(self.timeout)),
                Err(RecvTimeoutError::Disconnected) => return Err(AcpError::Disconnected),
            }
        }
    }

    /// 应答 agent 的反向请求。
    ///
    /// **权限一律拒绝**：主管 AI 的界面上写着「本次会话授予：
    /// workflow:read / workflow:write-draft / memory:read，发布与运行未授权」——
    /// 在这里默认允许的话那句话就是假的。AI 的改动走 DraftStore.propose()
    /// 出 Diff、用户确认，不走 agent 自己申请权限这条路。
    ///
    /// **不认识的方法回 JSON-RPC 的「方法不存在」**：我们握手时声明了
    /// 不支持 fs 与 terminal，但 adapter 版本一变就可能问点别的。
    /// 回一句「不支持」它就能换个做法；不回话它只会等到超时。
    fn answer_reverse_call(&mut self, id: i64, method: &str, params: &Value) -> Result<()> {
        let payload = if method == "session/request_permission" {
            // 选项 ID 由 agent 给，得从里面挑一个拒绝类的 —— 自己编一个
            // 它不认识的 optionId，等于没回答
            let option = params
                .get("options")
                .and_then(Value::as_array)
                .and_then(|options| {
                    options
                        .iter()
                        .find(|option| {
                            option
                                .get("kind")
                                .and_then(Value::as_str)
                                .is_some_and(|kind| kind.starts_with("reject"))
                        })
                        .or_else(|| options.last())
                })
                .and_then(|option| option.get("optionId"))
                .and_then(Value::as_str)
                .map(str::to_string);

            match option {
                Some(option_id) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "selected", "optionId": option_id } },
                }),
                // 一个选项都没给：那就说这轮取消，别让它干等
                None => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "cancelled" } },
                }),
            }
        } else {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("客户端不支持 {method}") },
            })
        };

        let line = serde_json::to_string(&payload)
            .map_err(|error| AcpError::Malformed(error.to_string()))?;
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn send(&mut self, method: &str, params: Value) -> Result<i64> {
        let id = self.next_id;
        self.next_id += 1;

        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| AcpError::Malformed(error.to_string()))?;

        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(id)
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        // adapter 可能起了子进程，杀整个进程组而不只是它自己
        let pid = self.child.id();
        if pid > 0 {
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
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 后台线程按行读 stdout，解析成应答或通知。
///
/// 用 channel 而不是直接读：请求方要能带超时地等，
/// 而 BufRead 的读没有超时。
fn spawn_reader(stdout: std::process::ChildStdout) -> Receiver<Incoming> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let sent = if let Some(method) = message.get("method").and_then(Value::as_str) {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                // 有 id 的是请求，要应答；没有的才是通知
                match message.get("id").and_then(Value::as_i64) {
                    Some(id) => tx.send(Incoming::Request {
                        id,
                        method: method.to_string(),
                        params,
                    }),
                    None => tx.send(Incoming::Notification {
                        method: method.to_string(),
                        params,
                    }),
                }
            } else if let Some(id) = message.get("id").and_then(Value::as_i64) {
                let result = if let Some(error) = message.get("error") {
                    Err(AcpError::Remote(
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("未知错误")
                            .to_string(),
                    ))
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                tx.send(Incoming::Response { id, result })
            } else {
                continue;
            };

            if sent.is_err() {
                break; // 接收端已经走了
            }
        }
    });
    rx
}

/// 把一条 session/update 通知翻译成 `SessionUpdate` 交给回调。
fn dispatch_update(params: &Value, on_update: &mut impl FnMut(SessionUpdate<'_>)) {
    let Some(update) = params.get("update") else {
        return;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match kind {
        "agent_message_chunk" => {
            if let Some(text) = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
            {
                on_update(SessionUpdate::AgentText { text });
            }
        }
        "agent_thought_chunk" => {
            if let Some(text) = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
            {
                on_update(SessionUpdate::Reasoning { text });
            }
        }
        "tool_call" | "tool_call_update" => {
            on_update(SessionUpdate::ToolCall {
                id: update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                title: update.get("title").and_then(Value::as_str).unwrap_or(""),
                status: update.get("status").and_then(Value::as_str).unwrap_or(""),
            });
        }
        other => on_update(SessionUpdate::Other {
            kind: other,
            raw: update,
        }),
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// adapter 注册表。与 `services/acp-sidecar/src/runtime.ts` 对应 ——
/// 那边是单一真源，这里的测试守住两边不脱节。
pub fn adapter_command(runtime: &str) -> Option<(&'static str, Vec<String>)> {
    match runtime {
        "acp.claude" => Some(("claude-agent-acp", vec![])),
        "acp.codex" => Some(("codex-acp", vec![])),
        _ => None,
    }
}

/// spawn 前要清掉的环境变量。
pub fn env_to_remove(runtime: &str) -> Vec<String> {
    let keys: &[&str] = match runtime {
        "acp.claude" => &[
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SSE_PORT",
        ],
        "acp.codex" => &["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"],
        _ => &[],
    };
    keys.iter().map(|k| (*k).to_string()).collect()
}

/// 运行时清单：给 Dry Run 用，告诉用户哪些 adapter 装了、哪些没装。
pub fn known_runtimes() -> Vec<&'static str> {
    vec!["acp.claude", "acp.codex"]
}

/// adapter 装没装。查的是 node_modules/.bin 与 PATH。
///
/// 那条 `services/…` 是**相对当前工作目录**的，只有从仓库根启动时才成立
/// （`pnpm tauri dev` 就是这么起的）。打包版的 cwd 是 `/`，这一步必然落空，
/// 它靠的是下面的 PATH —— 而 PATH 得走 [`crate::tooling`] 那份，
/// 不然 launchd 给的四条系统目录里什么都找不到。
pub fn adapter_installed(runtime: &str) -> Option<String> {
    let (command, _) = adapter_command(runtime)?;

    // 项目本地优先：pnpm 装的 adapter 在 node_modules/.bin 下，不在 PATH 里
    let local = std::path::Path::new("services/acp-sidecar/node_modules/.bin").join(command);
    if local.is_file() {
        return Some(local.display().to_string());
    }

    crate::tooling::which(command).map(|path| path.display().to_string())
}

/// 用于 `HashMap` 形式的能力查询，供 executor 判断是否具备结构化输出等。
pub fn capability_flags(capabilities: &Value) -> HashMap<String, bool> {
    let mut flags = HashMap::new();
    if let Some(prompt) = capabilities
        .get("promptCapabilities")
        .and_then(Value::as_object)
    {
        for (key, value) in prompt {
            flags.insert(key.clone(), value.as_bool().unwrap_or(false));
        }
    }
    flags
}

/// 主管 AI 的 ACP 会话池。
///
/// **一条主管对话对应一条活着的 ACP 会话。** 每问一句就
/// `connect` + `session/new` 的话，agent 手上永远是一张白纸 ——
/// 用户问「那第二个方案呢」，它根本不知道第一个是什么，
/// 我们只能把历史重新拼进 prompt。那不是对话，
/// 是每次重新做一次自我介绍，而且每问一句还要起一个 adapter 进程。
///
/// 池子里放的是**活的子进程**，所以有两件事必须做：
///
/// - **会死**：adapter 会因为升级、被杀、自己崩而退出。一条死会话留在池里的话，
///   用户之后每问一句都失败，而他不知道该怎么办 —— 关掉抽屉重开也没用。
///   所以一轮失败之后丢掉重建，再试一次
/// - **要回收**：用户问完一句就去干别的了，一个常驻的 node 进程在那儿
///   占着内存与登录态。空闲超过 `idle` 就收走
///
/// 锁是整池一把：主管 AI 是单用户交互，同时只会有一条对话在跑，
/// 而**同一条对话本来就不该并发**（两轮 prompt 交错发给同一个 session，
/// agent 那边的上下文会乱掉）。
pub struct SessionPool {
    live: std::sync::Mutex<HashMap<String, Live>>,
    idle: Duration,
}

struct Live {
    client: AcpClient,
    session_id: String,
    last_used: std::time::Instant,
}

/// 主管 AI 的会话空闲多久就收掉。
///
/// 十分钟：用户问完一句去改工作流、跑一次运行，回来接着问是常事，
/// 那期间不该把进程杀掉让他重新等一次握手；但也不能真的常驻 ——
/// 一个闲着的 node 进程占着内存与登录态。
const SUPERVISOR_IDLE: Duration = Duration::from_secs(600);

impl SessionPool {
    #[must_use]
    pub fn new(idle: Duration) -> Self {
        Self {
            live: std::sync::Mutex::new(HashMap::new()),
            idle,
        }
    }

    /// 整个进程共用的那一个池。
    ///
    /// 是全局的，而且**应该**是全局的：池子里放的是活的子进程，
    /// 同一个 App 里存在两个池就意味着同一条对话可能对上两个 adapter，
    /// 而其中一个永远没人回收。桌面壳与 MCP 那两条调用路径
    /// （`supervisor_ask` 的两个入口）必须落在同一个池上。
    pub fn shared() -> &'static Self {
        static SHARED: std::sync::OnceLock<SessionPool> = std::sync::OnceLock::new();
        SHARED.get_or_init(|| Self::new(SUPERVISOR_IDLE))
    }

    /// 在 `key` 这条对话上跑一轮。会话不在或者已经死了就用 `建` 新建一条。
    ///
    /// `建` 拿的是 `&self` 之外的东西（adapter 命令、cwd、MCP 配置），
    /// 由调用方闭包带进来 —— 池子不该知道主管 AI 是怎么配的。
    pub fn prompt(
        &self,
        key: &str,
        建: impl Fn() -> Result<(AcpClient, String)>,
        text: &str,
        mut on_update: impl FnMut(SessionUpdate<'_>),
    ) -> Result<PromptOutcome> {
        let mut live = self.live.lock().map_err(|_| AcpError::Disconnected)?;

        // 先清掉放太久的：借这次调用顺手做，不额外起一个收割线程 ——
        // 那个线程的生命周期又要跟着 App 管一遍
        let idle = self.idle;
        live.retain(|_, session| session.last_used.elapsed() < idle);

        if !live.contains_key(key) {
            let (client, session_id) = 建()?;
            live.insert(
                key.to_string(),
                Live {
                    client,
                    session_id,
                    last_used: std::time::Instant::now(),
                },
            );
        }

        let 结果 = {
            let session = live.get_mut(key).ok_or(AcpError::Disconnected)?;
            let id = session.session_id.clone();
            session.last_used = std::time::Instant::now();
            session.client.prompt(&id, text, &mut on_update)
        };

        match 结果 {
            Ok(outcome) => Ok(outcome),
            // 失败多半是进程没了。丢掉重建再试一次 ——
            // 把「adapter 昨天半夜被升级了」这种事报给用户没有意义，
            // 他能做的也只是再点一次
            Err(_) => {
                live.remove(key);
                let (mut client, session_id) = 建()?;
                let outcome = client.prompt(&session_id, text, &mut on_update);
                // 新会话照样放回池里：这一轮可能还是失败（adapter 真的坏了），
                // 但下一轮不该再为此多起一个进程
                live.insert(
                    key.to_string(),
                    Live {
                        client,
                        session_id,
                        last_used: std::time::Instant::now(),
                    },
                );
                outcome
            }
        }
    }

    /// 把一条会话改挂到新的 key 下。
    ///
    /// 主管对话的第一句是在**还没有会话 id 的时候**发出去的 ——
    /// id 要等答完之后落库才拿得到。不改挂的话，第二句带着真实 id 进来
    /// 会认不出上一条，于是又建一条：复用等于没做。
    pub fn rekey(&self, from: &str, to: &str) {
        if from == to {
            return;
        }
        if let Ok(mut live) = self.live.lock()
            && let Some(session) = live.remove(from)
        {
            live.insert(to.to_string(), session);
        }
    }

    /// 池子里现在活着几条。
    #[must_use]
    pub fn live_count(&self) -> usize {
        self.live.lock().map(|live| live.len()).unwrap_or(0)
    }

    /// 收掉空闲太久的会话。
    ///
    /// `prompt` 每次也会顺手做一遍，这个方法是给「一直没人说话」的情况用的。
    pub fn reap_idle(&self) {
        if let Ok(mut live) = self.live.lock() {
            let idle = self.idle;
            live.retain(|_, session| session.last_used.elapsed() < idle);
        }
    }

    /// 全部关掉。App 退出时走这条，不然会留下一堆孤儿 adapter 进程。
    pub fn shutdown(&self) {
        if let Ok(mut live) = self.live.lock() {
            live.clear();
        }
    }

    /// 测试脚手架：把某条会话的进程弄死，用来验证「死了会自己重建」。
    #[doc(hidden)]
    pub fn kill_for_test(&self, key: &str) {
        if let Ok(mut live) = self.live.lock() {
            live.remove(key);
        }
    }

    /// 测试脚手架：某条会话背后是哪个进程。
    ///
    /// 「复用了同一条会话」最硬的证据是 pid 没变 —— session id 靠不住，
    /// 两个各自新起的 adapter 进程完全可能给出一样的 id。
    #[doc(hidden)]
    #[must_use]
    pub fn pid_for_test(&self, key: &str) -> Option<u32> {
        self.live
            .lock()
            .ok()
            .and_then(|live| live.get(key).map(|s| s.client.pid()))
    }
}
