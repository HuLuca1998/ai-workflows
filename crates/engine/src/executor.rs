//! 节点执行器：把节点配置真的变成副作用。
//!
//! 一条铁律：**没实现的节点类型明确报「尚未实现」，绝不假装成功**。
//! 假装成功会让用户以为工作流跑通了，然后在下游拿到空数据时才发现，
//! 那时错误离原因已经很远。

use std::path::PathBuf;
use std::time::Duration;

use crate::acp::{AcpClient, SessionUpdate, adapter_command, adapter_installed, env_to_remove};
use crate::artifacts::{ArtifactKind, ArtifactStore};
use crate::exec::{ExecOutcome, ScriptRequest, run_script};
use crate::graph::GraphNode;
use crate::interp::{Scope, interpolate, interpolate_with, shell_quote};
use crate::runner::NodeOutcome;
use crate::worktree::{WorktreeRequest, create_worktree};

#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("节点 {node} 的配置缺少必填项 {field}")]
    MissingConfig { node: String, field: String },
    #[error("执行失败：{0}")]
    Exec(#[from] crate::exec::ExecError),
}

pub type Result<T> = std::result::Result<T, ExecutorError>;

pub struct NodeExecutor {
    /// 运行的默认工作目录。worktree 节点会为后续节点改写它。
    workdir: PathBuf,
    /// worktree 落地的父目录。
    worktree_parent: PathBuf,
    artifacts: ArtifactStore,
    run_id: String,
    /// 覆盖 ACP adapter 的命令。测试用 mock，生产走注册表。
    acp_override: Option<(String, Vec<String>)>,
    /**
     * 会注入 AI 节点的记忆快照。
     *
     * 执行器**不碰数据库** —— 上层取好了传进来。这样它既能单测，
     * 也不会在执行中途因为记忆被改而拿到前后不一致的两份。
     */
    memories: Vec<(String, String)>,
    /// 实际注入了哪几条。上层据此写 system.memory_injected 事件。
    injected: std::sync::Mutex<Vec<String>>,
}

impl NodeExecutor {
    pub fn new(workdir: PathBuf) -> Self {
        let worktree_parent = workdir.join(crate::worktree::ENGINE_WORKTREE_DIR);
        let artifacts = ArtifactStore::new(workdir.join(".aiwf-artifacts"));
        Self {
            workdir,
            worktree_parent,
            artifacts,
            run_id: "run".to_string(),
            acp_override: None,
            memories: Vec::new(),
            injected: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// 传入会注入 AI 节点的记忆。
    ///
    /// 只影响 AI 节点：脚本节点拿记忆没有意义，而拼进环境变量反而会泄露。
    #[must_use]
    pub fn with_memories(mut self, memories: &[(String, String)]) -> Self {
        self.memories = memories.to_vec();
        self
    }

    /// 这次执行实际注入了哪几条记忆。
    ///
    /// 「记忆注入可在事件中溯源」是 M4 的出口标准之一：记忆会改变 AI 的行为，
    /// 用户看到出乎意料的结果时第一个要问的就是「它凭什么这么干」。
    pub fn injected_memory_keys(&self) -> Vec<String> {
        self.injected
            .lock()
            .map(|keys| keys.clone())
            .unwrap_or_default()
    }

    /// 指定 ACP adapter 的命令。测试用它挂 mock；
    /// 生产不调，走 `adapter_command` 的注册表。
    #[must_use]
    pub fn with_acp_command(mut self, command: &str, args: &[String]) -> Self {
        self.acp_override = Some((command.to_string(), args.to_vec()));
        self
    }

    /// 产物按运行分目录，得知道自己在跑哪个运行。
    #[must_use]
    pub fn with_run_id(mut self, run_id: &str) -> Self {
        self.run_id = run_id.to_string();
        self
    }

    /// 产物落在应用数据目录下，与工作目录分开：
    /// 用户可能把工作目录指向自己的仓库，产物写进去会污染工作区。
    #[must_use]
    pub fn with_artifact_root(mut self, root: PathBuf) -> Self {
        self.artifacts = ArtifactStore::new(root);
        self
    }

    pub fn artifacts(&self) -> &ArtifactStore {
        &self.artifacts
    }

    pub fn workdir(&self) -> &PathBuf {
        &self.workdir
    }

    pub fn execute(&self, node: &GraphNode, scope: &mut Scope) -> Result<NodeOutcome> {
        match node.node_type.as_str() {
            "entry" | "end" | "notify" => Ok(NodeOutcome::Succeeded {
                port: "success".to_string(),
            }),

            // 审批是引擎强制的暂停点，执行器不做决定
            "approval" => Ok(NodeOutcome::NeedsApproval),

            "script.shell" => self.run_shell(node, scope),
            "git.worktree" => self.run_worktree(node, scope),

            "ai.analyze" | "ai.execute" | "ai.review" | "ai.decide" => self.run_ai(node, scope),

            other => Ok(NodeOutcome::Failed {
                message: format!("节点类型 {other} 尚未实现。这个节点不会被执行，运行到此为止"),
            }),
        }
    }

    fn run_shell(&self, node: &GraphNode, scope: &mut Scope) -> Result<NodeOutcome> {
        let script_raw = self.require_str(node, "script")?;
        // 插值结果直接进 bash -c：不转义的话，启动参数里一个 `; rm -rf ~`
        // 就是另一条命令。工作流作者写脚本本来就有这个权限，
        // 但只拥有「运行」能力的人不该借参数拿到它
        let script = match interpolate_with(&script_raw, scope, shell_quote) {
            Ok(script) => script,
            // 未解析的引用绝不能带进 shell：`rm -rf ${input.nope}/x` 会真的执行
            Err(error) => {
                return Ok(NodeOutcome::Failed {
                    message: error.to_string(),
                });
            }
        };

        let timeout_ms = node
            .config
            .get("timeoutMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(300_000);

        let outcome = run_script(ScriptRequest {
            interpreter: node
                .config
                .get("interpreter")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("zsh")
                .to_string(),
            script,
            workdir: self.workdir.clone(),
            env: scope.env_vars(),
            timeout: Duration::from_millis(timeout_ms),
            output_parse: node
                .config
                .get("outputParse")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("text")
                .to_string(),
        })?;

        match outcome {
            ExecOutcome::TimedOut { timeout, .. } => Ok(NodeOutcome::Failed {
                message: format!("脚本超时，已在 {}ms 后中断", timeout.as_millis()),
            }),

            ExecOutcome::Completed {
                code,
                stdout,
                stderr,
                parsed,
                parse_error,
                truncated,
                ..
            } => {
                // 落产物必须在判断成败**之前**：脚本失败时最需要看日志，
                // 而失败分支提前 return 的话，恰恰是这时候没有日志可看
                self.save_output(&node.id, "stdout.log", &stdout);
                self.save_output(&node.id, "stderr.log", &stderr);

                if code != 0 {
                    return Ok(NodeOutcome::Failed {
                        message: format!(
                            "脚本以退出码 {code} 结束{}",
                            first_line(&stderr).map_or(String::new(), |line| format!("：{line}"))
                        ),
                    });
                }

                // 输出进 scope，下游节点才能引用 ${节点.success.stdout}
                scope.set_node_output(
                    &node.id,
                    "success",
                    serde_json::json!({
                        "stdout": stdout,
                        "stderr": stderr,
                        "parsed": parsed,
                        "parseError": parse_error,
                        "truncated": truncated,
                    }),
                );

                Ok(NodeOutcome::Succeeded {
                    port: "success".to_string(),
                })
            }
        }
    }

    fn run_worktree(&self, node: &GraphNode, scope: &mut Scope) -> Result<NodeOutcome> {
        let resolve = |field: &str, fallback: &str| -> std::result::Result<String, String> {
            let raw = node
                .config
                .get(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or(fallback);
            interpolate(raw, scope).map_err(|e| e.to_string())
        };

        let (repo_root, base_branch, branch) = match (
            resolve("repoRoot", ""),
            resolve("baseBranch", "main"),
            resolve("branchTemplate", "aiwf/${run.id}"),
        ) {
            (Ok(repo), Ok(base), Ok(branch)) => (repo, base, branch),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
                return Ok(NodeOutcome::Failed { message: e });
            }
        };

        if repo_root.is_empty() {
            return Err(ExecutorError::MissingConfig {
                node: node.id.clone(),
                field: "repoRoot".to_string(),
            });
        }

        match create_worktree(WorktreeRequest {
            repo_root: PathBuf::from(&repo_root),
            base_branch,
            branch,
            parent_dir: self.worktree_parent.clone(),
        }) {
            Ok(result) => {
                scope.set_node_output(
                    &node.id,
                    "success",
                    serde_json::json!({
                        "path": result.path.display().to_string(),
                        "branch": result.branch,
                    }),
                );
                Ok(NodeOutcome::Succeeded {
                    port: "success".to_string(),
                })
            }
            Err(error) => Ok(NodeOutcome::Failed {
                message: error.to_string(),
            }),
        }
    }

    /// 落一个输出产物。空输出不写文件 ——
    /// 一堆 0 字节的 stdout.log 只会让产物列表变噪音。
    ///
    /// 写失败不让节点失败：脚本已经成功跑完了，因为存不下日志而
    /// 判它失败，会让用户去查一个根本没出问题的脚本。
    fn save_output(&self, node_id: &str, name: &str, content: &str) {
        if content.is_empty() {
            return;
        }
        let _ = self.artifacts.save(
            &self.run_id,
            node_id,
            ArtifactKind::Log,
            name,
            content.as_bytes(),
        );
    }

    /// 跑一个 AI 节点：起 adapter → 建会话 → 发提示词 → 收流式回答。
    ///
    /// 会话是**一次性**的：每个节点起一个 adapter 进程，跑完就收掉。
    /// 复用会话能省启动时间，但也让「这个节点看到了什么上下文」
    /// 变得说不清 —— 而可解释性是这个产品的核心。
    fn run_ai(&self, node: &GraphNode, scope: &mut Scope) -> Result<NodeOutcome> {
        let instruction_raw = self.require_str(node, "instruction")?;
        let instruction = match interpolate(&instruction_raw, scope) {
            Ok(text) => text,
            // 把 `${input.nope}` 原样发过去，agent 会当成字面量去理解，
            // 得到的分析基于一个根本不存在的东西
            Err(error) => {
                return Ok(NodeOutcome::Failed {
                    message: error.to_string(),
                });
            }
        };

        // 记忆拼在指令前面。没有记忆时不留空段 ——
        // 一句「已知的长期上下文：」后面什么都没有，
        // 模型会以为上下文被截断了
        let instruction = if self.memories.is_empty() {
            instruction
        } else {
            let mut prefixed = String::from("已知的长期上下文：\n");
            for (key, value) in &self.memories {
                prefixed.push_str(&format!("- {key}：{value}\n"));
            }
            prefixed.push('\n');
            prefixed.push_str(&instruction);

            if let Ok(mut injected) = self.injected.lock() {
                injected.clear();
                injected.extend(self.memories.iter().map(|(key, _)| key.clone()));
            }
            prefixed
        };

        let runtime = node
            .config
            .get("runtime")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("acp.claude");

        let (command, args) = match &self.acp_override {
            Some((command, args)) => (command.clone(), args.clone()),
            None => match adapter_command(runtime) {
                Some((command, args)) => match adapter_installed(runtime) {
                    Some(path) => (path, args),
                    None => {
                        return Ok(NodeOutcome::Failed {
                            message: format!(
                                "{runtime} 的 adapter（{command}）没有安装。\
                                 装上它才能跑 AI 节点：pnpm --filter @aiwf/acp-sidecar add {command}"
                            ),
                        });
                    }
                },
                None => {
                    return Ok(NodeOutcome::Failed {
                        message: format!("不认识的 runtime {runtime}"),
                    });
                }
            },
        };

        let timeout_ms = node
            .config
            .get("timeoutMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(900_000);

        let mut client = match AcpClient::connect(
            &command,
            &args,
            &env_to_remove(runtime),
            Duration::from_millis(timeout_ms),
        ) {
            Ok(client) => client,
            Err(error) => {
                return Ok(NodeOutcome::Failed {
                    message: format!("连不上 adapter：{error}"),
                });
            }
        };

        let session = match client.new_session(&self.workdir.display().to_string()) {
            Ok(session) => session,
            Err(error) => {
                return Ok(NodeOutcome::Failed {
                    message: format!("建会话失败：{error}"),
                });
            }
        };

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls = 0_u32;

        let outcome = client.prompt(&session.id, &instruction, |update| match update {
            SessionUpdate::AgentText { text: chunk } => text.push_str(chunk),
            SessionUpdate::Reasoning { text: chunk } => reasoning.push_str(chunk),
            SessionUpdate::ToolCall { .. } => tool_calls += 1,
            SessionUpdate::Other { .. } => {}
        });

        match outcome {
            Ok(stop) => {
                // 回答落产物：几十 KB 的分析不该进事件表
                self.save_output(&node.id, "agent.md", &text);
                if !reasoning.is_empty() {
                    self.save_output(&node.id, "reasoning.md", &reasoning);
                }

                scope.set_node_output(
                    &node.id,
                    "success",
                    serde_json::json!({
                        "text": text,
                        "reasoning": reasoning,
                        "toolCalls": tool_calls,
                        "stopReason": format!("{stop:?}"),
                        "sessionId": session.id,
                        "mode": session.current_mode,
                    }),
                );

                Ok(NodeOutcome::Succeeded {
                    port: "success".to_string(),
                })
            }
            Err(error) => Ok(NodeOutcome::Failed {
                message: format!("AI 节点失败：{error}"),
            }),
        }
    }

    fn require_str(&self, node: &GraphNode, field: &str) -> Result<String> {
        node.config
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ExecutorError::MissingConfig {
                node: node.id.clone(),
                field: field.to_string(),
            })
    }
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}
