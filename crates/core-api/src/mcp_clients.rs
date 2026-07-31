//! 一键把本地 ACP 客户端接进系统 MCP。
//!
//! 两个客户端的接法不一样，差异不是风格问题：
//!
//! | | 令牌怎么带 | 为什么 |
//! | --- | --- | --- |
//! | Claude Code | `--header "Authorization: Bearer …"` | 它支持自定义头 |
//! | Codex | 令牌在 URL 路径里 | `codex mcp add --url` 只认「从环境变量读 bearer」或 OAuth，<br>而要求用户先 export 一个变量就谈不上「一键」 |
//!
//! 走各自的 CLI 而不是直接改配置文件：`~/.claude.json` 与
//! `~/.codex/config.toml` 的格式是它们自己的事，手写一份解析器
//! 意味着它们改一次格式我们就悄悄写坏一次用户的配置。

/// 在两个客户端里都用这个名字。
///
/// 不一致的话，用户在两边看到的工具前缀不同
/// （Claude Code 是 `mcp__aiwf__workflow_list`），换个客户端就得重学一遍。
pub const SERVER_NAME: &str = "aiwf";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    Claude,
    Codex,
}

impl Client {
    #[must_use]
    pub fn cli(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    /// 从 runtime 名（`acp.claude` / `acp.codex`）认出来。
    #[must_use]
    pub fn from_runtime(runtime: &str) -> Option<Self> {
        match runtime {
            "acp.claude" => Some(Self::Claude),
            "acp.codex" => Some(Self::Codex),
            _ => None,
        }
    }

    /// 装没装。查的是 PATH —— 而打包版继承的那份里几乎什么都没有，
    /// 所以走 tooling 那份（见 `aiwf_engine::tooling`）。
    #[must_use]
    pub fn installed(self) -> bool {
        aiwf_engine::tooling::which(self.cli()).is_some()
    }
}

/// 一条要执行的命令。**拆出来是为了能测**——
/// 直接在函数里 spawn 的话，「命令拼对了没」只能靠真的改用户配置来验。
#[derive(Debug, Clone)]
pub struct CliCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl CliCommand {
    /// 给用户看的那一行。接入失败时把它显示出来，用户能自己复制去跑一遍。
    #[must_use]
    pub fn display(&self) -> String {
        let mut out = self.program.clone();
        for arg in &self.args {
            out.push(' ');
            // 带空格的参数要引起来，否则复制出去跑不了
            if arg.contains(' ') || arg.contains('"') {
                out.push_str(&format!("{:?}", arg));
            } else {
                out.push_str(arg);
            }
        }
        out
    }
}

#[must_use]
pub fn install_command(client: Client, port: u16, token: &str) -> CliCommand {
    let args: Vec<String> = match client {
        Client::Claude => vec![
            "mcp".to_string(),
            "add".to_string(),
            "--transport".to_string(),
            "http".to_string(),
            // user 档：跨项目都能用。装在 local 档的话换个目录就没了，
            // 而用户不会知道「工具没了」是因为自己换了工作目录
            "--scope".to_string(),
            "user".to_string(),
            SERVER_NAME.to_string(),
            format!("http://127.0.0.1:{port}/mcp"),
            "--header".to_string(),
            format!("Authorization: Bearer {token}"),
        ],
        Client::Codex => vec![
            "mcp".to_string(),
            "add".to_string(),
            SERVER_NAME.to_string(),
            "--url".to_string(),
            format!("http://127.0.0.1:{port}/mcp/{token}"),
        ],
    };

    CliCommand {
        program: client.cli().to_string(),
        args,
    }
}

/// 先删。同名再 add 会报「already exists」，而用户点第二次「接入」时
/// 看到那句话会以为是自己操作错了。
#[must_use]
pub fn uninstall_command(client: Client) -> CliCommand {
    CliCommand {
        program: client.cli().to_string(),
        args: vec![
            "mcp".to_string(),
            "remove".to_string(),
            SERVER_NAME.to_string(),
        ],
    }
}

#[derive(Debug, Clone)]
pub struct ConnectOutcome {
    pub client: Client,
    pub ok: bool,
    /// 给用户看的一句话。失败时说清「接下来该干什么」。
    pub detail: String,
    /// 实际执行的那条命令。失败时用户能自己复制去跑一遍。
    pub command: String,
}

/// 真的把它接进去。
///
/// 端口与令牌由调用方给 —— 这个函数不去读配置文件，
/// 那样它就能在「服务还没起来」时被调用而给出确定的错误。
pub fn connect(client: Client, port: u16, token: &str) -> ConnectOutcome {
    let install = install_command(client, port, token);
    let cmdline = install.display();

    if !client.installed() {
        return ConnectOutcome {
            client,
            ok: false,
            detail: format!(
                "{} 的命令行工具 `{}` 不在 PATH 里。装好之后再点一次；\
                 或者自己跑一遍：{cmdline}",
                client.label(),
                client.cli()
            ),
            command: cmdline,
        };
    }

    // 先删。删不掉多半是因为本来就没有，不算错
    let remove = uninstall_command(client);
    let _ = aiwf_engine::tooling::command(&remove.program)
        .args(&remove.args)
        .output();

    match aiwf_engine::tooling::command(&install.program)
        .args(&install.args)
        .output()
    {
        Ok(out) if out.status.success() => ConnectOutcome {
            client,
            ok: true,
            detail: format!(
                "已接入 {}。在它里面用 /mcp 能看到 {SERVER_NAME}，\
                 工具名形如 mcp__{SERVER_NAME}__workflow_list",
                client.label()
            ),
            command: cmdline,
        },
        Ok(out) => {
            // stderr 常常是空的而真正的原因在 stdout 里，两个都带上
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let reason = [stderr, stdout]
                .into_iter()
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("；");
            ConnectOutcome {
                client,
                ok: false,
                detail: format!(
                    "{} 拒绝了这次注册：{}。可以自己跑一遍看完整输出：{cmdline}",
                    client.label(),
                    if reason.is_empty() {
                        format!("退出码 {:?}", out.status.code())
                    } else {
                        reason
                    }
                ),
                command: cmdline,
            }
        }
        Err(error) => ConnectOutcome {
            client,
            ok: false,
            detail: format!("起不来 `{}`：{error}", client.cli()),
            command: cmdline,
        },
    }
}

/// 这个客户端里已经有 aiwf 这条了吗。
///
/// 问 CLI 而不是自己解析配置文件：`~/.claude.json` 与
/// `~/.codex/config.toml` 的格式是它们自己的事。
///
/// 认不出来时一律当作「没接」——显示成「已接入」而实际上没有，
/// 会让用户对着一个空的工具列表找半天。
#[must_use]
pub fn connected(client: Client) -> bool {
    if !client.installed() {
        return false;
    }
    aiwf_engine::tooling::command(client.cli())
        .args(["mcp", "list"])
        .output()
        .is_ok_and(|out| {
            out.status.success()
                && String::from_utf8_lossy(&out.stdout)
                    .lines()
                    // 名字要在行首那一列 —— 只要 contains 的话，
                    // 一条 URL 里恰好带 aiwf 的别的 server 也会算数
                    .any(|line| line.split_whitespace().next() == Some(SERVER_NAME))
        })
}

/// 把它从客户端里摘掉。
pub fn disconnect(client: Client) -> ConnectOutcome {
    let remove = uninstall_command(client);
    let cmdline = remove.display();

    if !client.installed() {
        return ConnectOutcome {
            client,
            ok: false,
            detail: format!("{} 的命令行工具不在 PATH 里", client.label()),
            command: cmdline,
        };
    }

    match aiwf_engine::tooling::command(&remove.program)
        .args(&remove.args)
        .output()
    {
        Ok(out) if out.status.success() => ConnectOutcome {
            client,
            ok: true,
            detail: format!("已从 {} 里移除", client.label()),
            command: cmdline,
        },
        Ok(out) => ConnectOutcome {
            client,
            ok: false,
            detail: format!(
                "{} 没能移除：{}",
                client.label(),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            command: cmdline,
        },
        Err(error) => ConnectOutcome {
            client,
            ok: false,
            detail: format!("起不来 `{}`：{error}", client.cli()),
            command: cmdline,
        },
    }
}
