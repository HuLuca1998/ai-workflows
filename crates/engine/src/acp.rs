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
    /// 这条会话能调的配置项：模型、推理深度、权限档……
    ///
    /// **模型清单从这里来，不从 `models.availableModels`** —— 后者只有
    /// codex 有（claude 侧完全没这个字段），而 `configOptions` 两端同构。
    pub config_options: Vec<ConfigOption>,
}

/// 一个会话配置项。形状两端一致（实测）。
#[derive(Debug, Clone)]
pub struct ConfigOption {
    /// **两端不一样**：推理深度在 codex 上是 `reasoning_effort`、
    /// claude 上是 `effort`。所以代码里认的是下面那个 `category`。
    pub id: String,
    /// 语义类别。`mode` / `model` / `thought_level` 三项**两端完全一致**，
    /// 这是整个 runtime 抽象层的锚点 —— 有了它就不需要 id 映射表，
    /// 而映射表是要跟着 adapter 版本维护的，漏一条就是静默失效。
    pub category: String,
    pub current_value: String,
    /// 可选值。设一个不在里面的，agent 会拒（实测两端都拒）。
    pub options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone)]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub description: String,
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
    /// session id → 那条会话当前的配置项。
    ///
    /// 存在 client 上而不是只给调用方，是因为 `set_config_by_category`
    /// 要按 category 反查 `configId`，而调用方手上通常只有 session id。
    config_options: HashMap<String, Vec<ConfigOption>>,
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
            config_options: HashMap::new(),
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

        let config_options = parse_config_options(&result);
        // 记在 client 上：`set_config_by_category` 要按 category 找 configId，
        // 而调用方手上只有 session id
        self.config_options
            .insert(id.clone(), config_options.clone());

        Ok(Session {
            id,
            current_mode,
            modes,
            config_options,
        })
    }

    /// 按**语义类别**设一个会话配置项，返回 agent 回读确认的值。
    ///
    /// 这是设模型与推理深度的唯一入口。三件事都是实测出来的
    /// （`docs/acp/transcripts/{codex,claude}-model.jsonl`）：
    ///
    /// - **`session/new` 的 params 里带 `model` 是没用的** —— 两端都静默忽略，
    ///   不报错也不采纳。照直觉那么写，测试会全绿而模型从没被切过；
    /// - 参数名是 **`configId`**，不是 `optionId`；
    /// - 响应回**全量** `configOptions`，所以「设了是否生效」当场能回读，
    ///   不必再查一次。
    ///
    /// **按 `category` 而不是 `id` 找**：id 两端不一样
    /// （`reasoning_effort` / `effort`），category 一样（`thought_level`）。
    ///
    /// agent 没暴露这一类时返回空串**而不是报错**：那时用它自己的默认值就好，
    /// 而报错会让装了老 adapter 的用户连节点都跑不起来。
    ///
    /// # Errors
    /// agent 拒绝这个值（不在候选里）时把拒绝原样传上去 ——
    /// 吞掉的话，上层那段「被拒就降级」永远走不到，而用户以为模型换了。
    pub fn set_config_by_category(
        &mut self,
        session_id: &str,
        category: &str,
        value: &str,
    ) -> Result<String> {
        let Some(config_id) = self
            .config_options
            .get(session_id)
            .and_then(|options| options.iter().find(|option| option.category == category))
            .map(|option| option.id.clone())
        else {
            return Ok(String::new());
        };

        let result = self.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
        )?;

        // 响应里的全量 configOptions 吃回来：下一次设别的项要用它找 configId，
        // 而且回读的值就是「agent 确认过的」那个
        let updated = parse_config_options(&result);
        let 回读 = updated
            .iter()
            .find(|option| option.category == category)
            .map(|option| option.current_value.clone())
            .unwrap_or_else(|| value.to_string());
        if !updated.is_empty() {
            self.config_options.insert(session_id.to_string(), updated);
        }
        Ok(回读)
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

/// 杀掉一整个进程组。adapter 可能起了子进程，只杀它自己会留下孙子。
///
/// 抽出来是因为 `SessionPool::shutdown` 也要用：**它不能依赖 Drop**——
/// 唯一的调用点是 App 退出，那之后进程立刻结束，
/// 正被别的线程持有的那条 `Live` 的 Drop 永远不会跑。
pub(crate) fn kill_process_group(pid: u32) {
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

impl Drop for AcpClient {
    fn drop(&mut self) {
        kill_process_group(self.child.id());
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

/// 从 `session/new` 或 `session/set_config_option` 的响应里取配置项。
///
/// 两处的形状一样（后者回全量），所以共用这一份。
fn parse_config_options(result: &Value) -> Vec<ConfigOption> {
    result
        .get("configOptions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| ConfigOption {
                    id: text(item, "id"),
                    category: text(item, "category"),
                    current_value: text(item, "currentValue"),
                    options: item
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|choices| {
                            choices
                                .iter()
                                .map(|choice| ConfigChoice {
                                    value: text(choice, "value"),
                                    name: text(choice, "name"),
                                    description: text(choice, "description"),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
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
    /// key → 那条会话的槽位。
    ///
    /// 槽位是 `Arc<Mutex<..>>` 而不是直接放 `Live`：整轮 ACP 对话要跑
    /// 十几分钟，握着整张表那么久的话，`shutdown()` 也得排在后面 ——
    /// 用户在主管 AI 说话时按 ⌘Q，退出回调阻塞在锁上，窗口关了而进程不退。
    /// 他会强杀，于是 adapter 子进程一个都没被 kill：**正是 shutdown
    /// 要防的那件事，在最可能发生的时刻失效**。
    ///
    /// 按槽位上锁之后，外层那把锁只在「取槽位」的一瞬间持有。
    /// 顺带两条不同的对话也能并发了。
    live: std::sync::Mutex<HashMap<String, Slot>>,
    /// 这个池起过的每一个 adapter 进程。
    ///
    /// `shutdown()` 按它直接杀，**不依赖 Drop**：唯一的调用点是
    /// App 退出，那之后进程立刻结束 —— 正被别的线程持有的那条 `Live`
    /// 的 Drop 永远不会跑。只 `live.clear()` 的话，等于把
    /// 「看得见的卡死」换成了「看不见的孤儿 node 进程」，
    /// 而 adapter 是 `process_group(0)` 起的，收不到 App 的退出信号。
    spawned: std::sync::Mutex<Vec<u32>>,
    idle: Duration,
}

/// 一条会话的槽位。`None` 表示「占了位但还没建起来」。
type Slot = std::sync::Arc<std::sync::Mutex<Option<Live>>>;

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
            spawned: std::sync::Mutex::new(Vec::new()),
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
        // 外层锁只在这一瞬间持有：取到自己那个槽位就放开，
        // 整轮对话锁的是槽位而不是整张表
        let slot = {
            let mut live = self.live.lock().map_err(|_| AcpError::Disconnected)?;

            // 先清掉放太久的：借这次调用顺手做，不额外起一个收割线程 ——
            // 那个线程的生命周期又要跟着 App 管一遍。
            // 正在用的槽位锁着，`try_lock` 拿不到就跳过它
            self.reap_locked(&mut live);

            live.entry(key.to_string()).or_default().clone()
        };

        let mut held = slot.lock().map_err(|_| AcpError::Disconnected)?;

        if held.is_none() {
            let (client, session_id) = 建()?;
            self.remember(client.pid());
            *held = Some(Live {
                client,
                session_id,
                last_used: std::time::Instant::now(),
            });
        }

        let 结果 = {
            let session = held.as_mut().ok_or(AcpError::Disconnected)?;
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
                *held = None;
                let (mut client, session_id) = 建()?;
                self.remember(client.pid());
                let outcome = client.prompt(&session_id, text, &mut on_update);
                // 新会话照样放回池里：这一轮可能还是失败（adapter 真的坏了），
                // 但下一轮不该再为此多起一个进程
                *held = Some(Live {
                    client,
                    session_id,
                    last_used: std::time::Instant::now(),
                });
                outcome
            }
        }
    }

    /// 收掉空闲太久的槽位。调用方已经持有外层锁。
    ///
    /// **正在用的槽位跳过**：`try_lock` 拿不到就说明有人在对话，
    /// 而那条会话按定义不是空闲的。
    fn reap_locked(&self, live: &mut HashMap<String, Slot>) {
        let idle = self.idle;
        live.retain(|_, slot| match slot.try_lock() {
            Ok(held) => held
                .as_ref()
                .is_none_or(|session| session.last_used.elapsed() < idle),
            // 有人正在对话 —— 那条按定义不是空闲的，留着
            Err(std::sync::TryLockError::WouldBlock) => true,
            // 锁中毒说明持锁的线程 panic 过。留着的话它永远回收不掉、
            // 也永远重建不了（`prompt` 会在 lock 处直接 Disconnected），
            // 而 live_count 还看不见它。丢掉，下次访问重建一条
            Err(std::sync::TryLockError::Poisoned(_)) => false,
        });
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
        self.live
            .lock()
            .map(|live| {
                // 只数真的建起来了的：占了位还没建的槽位不算一条会话
                live.values()
                    .filter(|slot| slot.lock().is_ok_and(|held| held.is_some()))
                    .count()
            })
            .unwrap_or(0)
    }

    /// 收掉空闲太久的会话。
    ///
    /// `prompt` 每次也会顺手做一遍，这个方法是给「一直没人说话」的情况用的。
    pub fn reap_idle(&self) {
        if let Ok(mut live) = self.live.lock() {
            self.reap_locked(&mut live);
        }
    }

    /// 全部关掉。App 退出时走这条，不然会留下一堆孤儿 adapter 进程。
    ///
    /// **立刻返回**，不等正在进行的那轮对话讲完 —— 用户按 ⌘Q 时
    /// 不该被一个还在说话的 agent 拖住。
    ///
    /// 按记下来的 pid 主动杀，**不依赖 Drop**：唯一的调用点是 App 退出，
    /// 那之后进程立刻结束，正被别的线程持有的那条 `Live` 的 Drop
    /// 永远不会跑。只清表的话，等于把「看得见的卡死」换成了
    /// 「看不见的孤儿 node 进程」—— adapter 是 `process_group(0)` 起的，
    /// 收不到 App 的退出信号。
    pub fn shutdown(&self) {
        // 先杀进程：拿不到 live 锁（有人正在对话）时这一步照样要做
        if let Ok(mut spawned) = self.spawned.lock() {
            for pid in spawned.drain(..) {
                kill_process_group(pid);
            }
        }
        if let Ok(mut live) = self.live.lock() {
            live.clear();
        }
    }

    /// 记下一个刚起的 adapter 进程，供 `shutdown` 收尾。
    fn remember(&self, pid: u32) {
        if let Ok(mut spawned) = self.spawned.lock() {
            spawned.push(pid);
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
        let slot = self.live.lock().ok()?.get(key)?.clone();
        let held = slot.lock().ok()?;
        held.as_ref().map(|session| session.client.pid())
    }

    /// 这个池起过的所有 adapter 进程。
    ///
    /// 与 [`Self::pid_for_test`] 的区别是它**不碰槽位锁** ——
    /// 正在对话的那条槽位是锁着的，而「正在对话时 shutdown
    /// 有没有把进程收走」恰恰是最要紧的那个场景。
    #[doc(hidden)]
    #[must_use]
    pub fn spawned_pids_for_test(&self) -> Vec<u32> {
        self.spawned.lock().map(|p| p.clone()).unwrap_or_default()
    }
}
