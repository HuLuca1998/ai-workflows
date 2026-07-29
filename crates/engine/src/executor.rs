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
    /**
     * 权限档（图纸「05 设置与环境」的三档）。
     *
     * 缺省按**最严的一档**办：默认放宽等于替用户做了一个
     * 他不知道自己做过的决定。
     */
    permission_preset: String,
    /// 已经被用户批准过的节点。恢复执行时不该又停在同一个节点上。
    approved_nodes: Vec<String>,
    /**
     * 这次运行所挂 Agent 角色声明的能力。
     *
     * 图纸「05 Agent 角色」写着「权限（引擎强制，Prompt 无法越权）」——
     * 不在这里拦的话那句话是空的：界面上摆着一排权限，
     * 而 Agent 想干什么还是干什么。
     *
     * None 表示这次运行没挂角色（比如直接跑一条脚本工作流）——
     * 那时不拦，否则所有现成的工作流都跑不了。
     */
    capabilities: Option<serde_json::Value>,
    /// 这张图里用到的 Agent 角色，按 id 索引。
    agent_profiles: Vec<AgentProfile>,
    /// 每个 AI 节点实际用了什么。上层据此写可解释性事件。
    resolutions: std::sync::Mutex<Vec<Resolution>>,
}

/// 一个 Agent 角色，解析好的形态。
///
/// **执行器不碰数据库** —— 上层查好了传进来。这样它既能单测，
/// 也不会在执行中途因为角色被改而拿到前后不一致的两份。
#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub role: String,
    pub goal: String,
    pub persona: String,
    pub runtime: String,
    pub model_ref: String,
    pub output_contract: String,
    /// 引擎强制的能力声明（JSON）。图纸「05 Agent 角色」写着
    /// 「权限（引擎强制，Prompt 无法越权）」——就靠它。
    pub capabilities_json: String,
    pub timeout_ms: i64,
}

/// 一个 AI 节点实际用了什么。上层据此写 `system.model_resolved`。
///
/// 「用了哪个模型 / 哪个角色 / 哪条提示词」是运行记录必须回答的问题。
/// 不记下来的话，执行记录里那句「可解释」就只是一个标题。
#[derive(Debug, Clone)]
pub struct Resolution {
    pub node_id: String,
    pub agent_profile_id: String,
    pub agent_name: String,
    pub model_ref: String,
    pub runtime: String,
    /// Agent 真正跑在哪个目录里。
    ///
    /// `ai.execute` 的 `workdirSource` 决定它。这一项要写进事件流 ——
    /// 图纸承诺「Fix Agent 的 cwd 固定为 worktree，不会污染你当前分支」，
    /// 而用户唯一能核对这句话的地方就是运行记录。
    pub workdir: String,
}

/// 节点执行途中要写进事件流的一条。
///
/// **执行器不碰数据库** —— 它把事件交给一个回调，由上层落库。
/// 攒到节点跑完再一起写也行，但 AI 节点要跑好几分钟，那期间
/// 界面上什么都没有；而「对话」这一屏的价值恰恰在于边跑边看。
#[derive(Debug, Clone)]
pub struct NodeEvent {
    /// 契约里的 `RunEventType`，如 `conversation.agent_message`。
    pub kind: &'static str,
    pub node_id: String,
    /// 面向人的一句话。**存储层拒收超过 2000 字符的摘要** ——
    /// 大内容一律走 `payload_ref`。
    pub summary: String,
    /// 全文落在哪个产物里（相对路径，如 `analyze/agent.md`）。
    pub payload_ref: Option<String>,
}

/// 事件回调。不关心事件去哪 —— 测试收进一个 Vec，运行时写进事件表。
pub type EventSink<'a> = dyn Fn(NodeEvent) + 'a;

/// 摘要的长度上限。
///
/// 存储层的硬上限是 2000 字符，但对话流里一条几千字的气泡也没法看。
/// 截到能一眼扫完的长度，全文点 payload_ref 去看。
const SUMMARY_CHARS: usize = 400;

fn 摘要(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= SUMMARY_CHARS {
        return trimmed.to_string();
    }
    format!(
        "{}…",
        trimmed.chars().take(SUMMARY_CHARS).collect::<String>()
    )
}

/// 有副作用因而受权限档管的节点类型。
///
/// transform 只改内存里的数据、分支只看条件 —— 逐项审批它们没有意义，
/// 而每个节点都弹一次的话用户会直接把最严那一档关掉。
const SIDE_EFFECT_NODES: &[&str] = &[
    "script.shell",
    "script.python",
    "git.worktree",
    "git.commit",
    "github.pr",
    "mcp.tool",
];

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
            // 没设过就按最严的办
            permission_preset: "review_every_change".to_string(),
            approved_nodes: Vec::new(),
            capabilities: None,
            agent_profiles: Vec::new(),
            resolutions: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// 这张图里用到的 Agent 角色。
    ///
    /// 不传的话 AI 节点仍能跑（已有的工作流里有一堆没写 agentProfileId 的），
    /// 但节点上写了 id 而这里查不到，就是硬错误 ——
    /// 悄悄按「没有角色」跑下去的话，用户得到的分析是一个没有人设、
    /// 没有输出契约、也没有权限约束的模型给的，而界面上显示的是「审查者」。
    #[must_use]
    pub fn with_agent_profiles(mut self, profiles: &[AgentProfile]) -> Self {
        self.agent_profiles = profiles.to_vec();
        self
    }

    /// 这个节点会用什么 —— **纯函数，执行之前就能问**。
    ///
    /// 与执行后从 `resolutions()` 里读的区别很实在：AI 节点连 adapter
    /// 可能挂上好几分钟，而排查「它卡在哪」的第一个问题就是
    /// 「它到底想连哪个」。等节点跑完再写事件，那条信息永远来不及。
    ///
    /// 非 AI 节点返回 None：给脚本节点写一条「用了哪个模型」是噪声。
    #[must_use]
    pub fn resolution_for(&self, node: &GraphNode, scope: &Scope) -> Option<Resolution> {
        if !node.node_type.starts_with("ai.") {
            return None;
        }
        let profile = self.profile_for(node);
        Some(Resolution {
            node_id: node.id.clone(),
            agent_profile_id: profile.map(|p| p.id.clone()).unwrap_or_default(),
            agent_name: profile.map(|p| p.name.clone()).unwrap_or_default(),
            model_ref: profile.map(|p| p.model_ref.clone()).unwrap_or_default(),
            runtime: self.resolved_runtime(node),
            // 解析不出来时留空 —— 那时节点会当场失败，事件里
            // 写一个编出来的目录比留空糟
            workdir: self
                .resolve_ai_workdir(node, scope)
                .map(|dir| dir.display().to_string())
                .unwrap_or_default(),
        })
    }

    /// AI 节点跑在哪个目录里。
    ///
    /// `workdirSource` 在契约里写着「由引擎强制，Prompt 不能改变安全边界」，
    /// 图纸也写着「Fix Agent 的 cwd 固定为 worktree，不会污染你当前分支」。
    /// 不在这里落地的话，那两句都是空的 —— 而且它们是**安全**声明。
    ///
    /// 只有 `ai.execute` 有这个字段；分析、审查、决策是只读的，
    /// 强制要求上游有 worktree 会让一条纯分析的工作流跑不了。
    ///
    /// # Errors
    /// 声明了 worktree 而上游没有一个 —— 悄悄退回运行工作目录的话，
    /// Agent 会直接在克隆出来的仓库里改，那正是要防的事。
    fn resolve_ai_workdir(
        &self,
        node: &GraphNode,
        scope: &Scope,
    ) -> std::result::Result<PathBuf, String> {
        if node.node_type != "ai.execute" {
            return Ok(self.workdir.clone());
        }
        let source = node
            .config
            .get("workdirSource")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("worktree");

        match source {
            "inherit" => Ok(self.workdir.clone()),
            "declared" => match node
                .config
                .get("workdir")
                .and_then(serde_json::Value::as_str)
            {
                Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
                _ => Err("workdirSource 是「已声明」，但节点没写 workdir".to_string()),
            },
            _ => latest_worktree(scope).map(PathBuf::from).ok_or_else(|| {
                "这个节点的工作目录来源是 worktree，但上游没有一个 git.worktree 节点跑成功过。\
                 要么在它前面接一个 worktree 节点，要么把「工作目录来源」改成「继承」——\
                 直接在仓库里改会污染当前分支"
                    .to_string()
            }),
        }
    }

    /// 每个 AI 节点实际用了什么。上层据此写 `system.model_resolved`。
    pub fn resolutions(&self) -> Vec<Resolution> {
        self.resolutions
            .lock()
            .map(|list| list.clone())
            .unwrap_or_default()
    }

    /// 节点挂着的角色。节点上没写 id 时返回 None。
    fn profile_for(&self, node: &GraphNode) -> Option<&AgentProfile> {
        let id = node.config.get("agentProfileId")?.as_str()?;
        self.agent_profiles.iter().find(|p| p.id == id)
    }

    /// 这个节点最终跑在哪个 runtime 上。
    ///
    /// 角色说了算：节点上的 `runtime` 是 M2 时期的写法（那时还没有角色），
    /// 两处都写着时以界面上用户真正在改的那一栏为准。
    #[must_use]
    pub fn resolved_runtime(&self, node: &GraphNode) -> String {
        if let Some(profile) = self.profile_for(node) {
            if !profile.runtime.is_empty() {
                return profile.runtime.clone();
            }
        }
        node.config
            .get("runtime")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("acp.codex")
            .to_string()
    }

    /// Agent 角色声明的能力。不传表示这次运行没挂角色。
    #[must_use]
    pub fn with_capabilities(mut self, capabilities: &serde_json::Value) -> Self {
        self.capabilities = Some(capabilities.clone());
        self
    }

    /// 这个节点要的能力，角色给了没有。
    ///
    /// 返回 Err 里带的是**面向用户的**说明：「命令执行未授权」比
    /// 「capability denied」有用得多 —— 用户要知道去哪儿改。
    fn check_capability(&self, node: &GraphNode) -> std::result::Result<(), String> {
        // 节点挂着角色时以角色的能力为准 —— 那是用户在「Agent 角色」屏上
        // 逐项设过的东西。运行级的 capabilities 是兜底
        let 角色的 = self
            .profile_for(node)
            .and_then(|profile| serde_json::from_str(&profile.capabilities_json).ok());
        let caps: serde_json::Value = match (角色的, &self.capabilities) {
            (Some(value), _) => value,
            (None, Some(value)) => value.clone(),
            (None, None) => return Ok(()),
        };
        let caps = &caps;
        let level = |key: &str| {
            caps.get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("none")
                .to_string()
        };

        // 用 match guard 而不是嵌 if：每一支就是「哪种节点 + 缺哪项能力」
        match node.node_type.as_str() {
            "script.shell" | "script.python" if level("command") == "none" => {
                Err("这个角色的「命令」权限是「不允许」，跑不了脚本节点。\
                 在「Agent 角色」里改它的权限声明"
                    .to_string())
            }
            "git.worktree" | "git.commit" if level("file") != "read-write" => {
                Err("这个角色的「文件」权限不是「可读写」，动不了工作目录。\
                 在「Agent 角色」里改它的权限声明"
                    .to_string())
            }
            "github.pr" if level("network") == "none" => {
                Err("这个角色的「网络」权限是「禁止」，发不了 PR。\
                 在「Agent 角色」里改它的权限声明"
                    .to_string())
            }
            _ => Ok(()),
        }
    }

    /// 这次运行按哪一档权限执行。
    ///
    /// `review_every_change` 下有副作用的节点会先挂起等审批 ——
    /// 图纸这一档的原话就是「文件写入、命令与外部写操作逐项审批」。
    /// 界面能选而引擎不按档位拦截的话，那是假的安全感，比没有更糟。
    #[must_use]
    pub fn with_permission_preset(mut self, preset: &str) -> Self {
        self.permission_preset = preset.to_string();
        self
    }

    /// 已经被用户批准过的节点。恢复执行时靠它跳过重复的审批。
    #[must_use]
    pub fn with_approved_nodes(mut self, node_ids: &[String]) -> Self {
        self.approved_nodes = node_ids.to_vec();
        self
    }

    /// 这个节点在当前权限档下需不需要先问一句。
    fn needs_permission_approval(&self, node: &GraphNode) -> bool {
        if self.permission_preset != "review_every_change" {
            return false;
        }
        if self.approved_nodes.iter().any(|id| id == &node.id) {
            return false;
        }
        SIDE_EFFECT_NODES.contains(&node.node_type.as_str())
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

    /// 跑一个节点。不需要事件流的调用方用这个。
    pub fn execute(&self, node: &GraphNode, scope: &mut Scope) -> Result<NodeOutcome> {
        self.execute_with_sink(node, scope, &|_| {})
    }

    /// 跑一个节点，途中的对话 / 推理 / 工具调用交给 `sink`。
    ///
    /// 事件通道是**参数**而不是执行器上的一个字段：加成字段就得给
    /// `NodeExecutor` 挂一个生命周期（sink 要借 `&Store`），
    /// 而它在几十处测试里是按值构造的。
    pub fn execute_with_sink(
        &self,
        node: &GraphNode,
        scope: &mut Scope,
        sink: &EventSink<'_>,
    ) -> Result<NodeOutcome> {
        // 权限档先说话。「Review Every Change」这一档的原话是
        //「文件写入、命令与外部写操作逐项审批」—— 引擎不拦的话，
        // 设置屏那三张卡就只是三个好看的卡片
        if self.needs_permission_approval(node) {
            return Ok(NodeOutcome::NeedsApproval);
        }

        // 能力检查在**起进程之前**：拦晚了脚本已经写了文件才报错，
        // 而那时副作用已经发生
        if let Err(message) = self.check_capability(node) {
            return Ok(NodeOutcome::Failed { message });
        }

        match node.node_type.as_str() {
            "entry" | "end" | "notify" => Ok(NodeOutcome::Succeeded {
                port: "success".to_string(),
            }),

            // 审批是引擎强制的暂停点，执行器不做决定
            "approval" => Ok(NodeOutcome::NeedsApproval),

            "script.shell" => self.run_shell(node, scope, sink),
            "git.worktree" => self.run_worktree(node, scope, sink),

            "ai.analyze" | "ai.execute" | "ai.review" | "ai.decide" => {
                self.run_ai(node, scope, sink)
            }

            other => Ok(NodeOutcome::Failed {
                message: format!("节点类型 {other} 尚未实现。这个节点不会被执行，运行到此为止"),
            }),
        }
    }

    fn run_shell(
        &self,
        node: &GraphNode,
        scope: &mut Scope,
        sink: &EventSink<'_>,
    ) -> Result<NodeOutcome> {
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

        let interpreter = node
            .config
            .get("interpreter")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("zsh")
            .to_string();

        // 「这一步到底跑了什么」——插值之后的那一份，不是配置里写的那份。
        // 两者常常差很远（`${input.repo}` 变成一个真实路径），
        // 而排查时要看的永远是真正执行的那一份
        sink(NodeEvent {
            kind: "script.started",
            node_id: node.id.clone(),
            summary: format!("{interpreter} · {}", 摘要(&script)),
            payload_ref: self.save_output(&node.id, "command.sh", &script),
        });

        let outcome = run_script(ScriptRequest {
            interpreter,
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
                // 而失败分支提前 return 的话，恰恰是这时候没有日志可看。
                // 事件同理 —— 下面这三条也在成败判断之前发
                let out_ref = self.save_output(&node.id, "stdout.log", &stdout);
                let err_ref = self.save_output(&node.id, "stderr.log", &stderr);

                if !stdout.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "script.stdout",
                        node_id: node.id.clone(),
                        summary: 摘要(&stdout),
                        payload_ref: out_ref,
                    });
                }
                if !stderr.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "script.stderr",
                        node_id: node.id.clone(),
                        summary: 摘要(&stderr),
                        payload_ref: err_ref,
                    });
                }
                sink(NodeEvent {
                    kind: "script.exited",
                    node_id: node.id.clone(),
                    summary: format!(
                        "退出码 {code}{}",
                        if truncated { " · 输出已截断" } else { "" }
                    ),
                    payload_ref: None,
                });

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

    fn run_worktree(
        &self,
        node: &GraphNode,
        scope: &mut Scope,
        sink: &EventSink<'_>,
    ) -> Result<NodeOutcome> {
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

        // 相对路径按**运行工作目录**算，不是进程的 CWD。
        //
        // 脚本节点的 cwd 就是运行工作目录：上一步 `gh repo clone … repo`
        // 克隆到那儿，这一步写 `repoRoot: "repo"` 是最自然的写法。
        // 按进程 CWD 解析的话它会去应用自己的目录里找，
        // 报「不是一个 Git 仓库」—— 而错误信息里看不出它找的是哪儿。
        let repo_path = {
            let given = PathBuf::from(&repo_root);
            if given.is_absolute() {
                given
            } else {
                self.workdir.join(given)
            }
        };

        match create_worktree(WorktreeRequest {
            repo_root: repo_path,
            base_branch,
            branch,
            parent_dir: self.worktree_parent.clone(),
        }) {
            Ok(result) => {
                // 「在哪个分支、哪个目录里改的」是这一步唯一要说清的事。
                // 只放进 scope 的话，运行记录上看不到 —— 而那正是
                // 事后要核对「它有没有污染主分支」的地方
                sink(NodeEvent {
                    kind: "node.output_emitted",
                    node_id: node.id.clone(),
                    summary: format!(
                        "分支 {} · worktree {}",
                        result.branch,
                        result.path.display()
                    ),
                    payload_ref: None,
                });

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
    /// 存一份产物，返回它的**相对路径**（`analyze/agent.md`）。
    ///
    /// 相对路径就是 `run.artifacts` 给界面的那个 `relPath`，也是事件里
    /// `payload_ref` 该写的值 —— 界面拿它去调 `run.artifactContent`。
    /// 原先这里把返回值丢了，于是事件想指向产物也指不了。
    fn save_output(&self, node_id: &str, name: &str, content: &str) -> Option<String> {
        if content.is_empty() {
            return None;
        }
        self.artifacts
            .save(
                &self.run_id,
                node_id,
                ArtifactKind::Log,
                name,
                content.as_bytes(),
            )
            .ok()
            .map(|_| format!("{node_id}/{name}"))
    }

    /// 跑一个 AI 节点：起 adapter → 建会话 → 发提示词 → 收流式回答。
    ///
    /// 会话是**一次性**的：每个节点起一个 adapter 进程，跑完就收掉。
    /// 复用会话能省启动时间，但也让「这个节点看到了什么上下文」
    /// 变得说不清 —— 而可解释性是这个产品的核心。
    fn run_ai(
        &self,
        node: &GraphNode,
        scope: &mut Scope,
        sink: &EventSink<'_>,
    ) -> Result<NodeOutcome> {
        // 节点写了角色 id 而查不到 —— 硬错误。
        //
        // 悄悄按「没有角色」跑下去的话，用户得到的分析是一个没有人设、
        // 没有输出契约、也没有权限约束的模型给的，而画布上那个节点
        // 显示的是「审查者」。错得越安静越难查。
        let declared = node
            .config
            .get("agentProfileId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty());
        let profile = self.profile_for(node);
        if let (Some(id), None) = (declared, profile) {
            return Ok(NodeOutcome::Failed {
                message: format!(
                    "找不到 Agent 角色 {id}。在「Agent 角色」屏上确认它还在，\
                     或者把节点改成引用一个存在的角色"
                ),
            });
        }

        let agent_cwd = match self.resolve_ai_workdir(node, scope) {
            Ok(dir) => dir.display().to_string(),
            Err(message) => return Ok(NodeOutcome::Failed { message }),
        };

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

        // 角色拼在最前面，节点的指令留在最后。
        //
        // 顺序是有讲究的：角色说的是「你是谁、你怎么做事、交出什么形状」，
        // 那是**这一整类任务**都成立的；指令是「这一次要干什么」。
        // 把指令埋在中间的话，多轮下来模型容易把它当成背景说明。
        let instruction = match profile {
            None => instruction,
            Some(profile) => {
                let mut prompt = String::new();
                if !profile.role.is_empty() || !profile.name.is_empty() {
                    prompt.push_str(&format!("你的角色：{}（{}）\n", profile.name, profile.role));
                }
                if !profile.goal.is_empty() {
                    prompt.push_str(&format!("你的目标：{}\n", profile.goal));
                }
                if !profile.persona.is_empty() {
                    prompt.push_str(&format!("你的做事方式：{}\n", profile.persona));
                }
                if !profile.output_contract.is_empty() {
                    prompt.push_str(&format!(
                        "交出来的东西要是这个形状：{}\n",
                        profile.output_contract
                    ));
                }
                if !prompt.is_empty() {
                    prompt.push('\n');
                }
                prompt.push_str(&instruction);
                prompt
            }
        };

        // runtime 由角色说了算；角色没说才看节点。
        // 都没有时默认 codex：这个应用本身跑在 Claude Code 里开发，
        // 用 claude 的 adapter 会与开发环境互相干扰 —— 嵌套的 agent 会话、
        // 共用的登录态、同一份配额
        let runtime = self.resolved_runtime(node);
        let runtime = runtime.as_str();

        // 也记一份在执行器上：单测靠它断言「解析对了没有」，
        // 不必去翻事件表
        if let Some(resolution) = self.resolution_for(node, scope) {
            if let Ok(mut list) = self.resolutions.lock() {
                list.push(resolution);
            }
        }

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

        // 超时：节点上写了就听节点的（那是针对这一步调的），
        // 否则用角色的 —— 执行者跑得久，审查者不该等那么长
        let timeout_ms = node
            .config
            .get("timeoutMs")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| profile.and_then(|p| u64::try_from(p.timeout_ms).ok()))
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

        let session = match client.new_session(&agent_cwd) {
            Ok(session) => session,
            Err(error) => {
                return Ok(NodeOutcome::Failed {
                    message: format!("建会话失败：{error}"),
                });
            }
        };

        // 发出去的提示词进对话流 —— 那是「往返」的另一半。
        //
        // 只记 agent 的回答不叫往返：用户看到一个出乎意料的结论时，
        // 第一个要问的是「我们到底问了它什么」，而那份提示词里拼着
        // 角色的人设、注入的记忆、上游节点的输出，都不是他手写的。
        sink(NodeEvent {
            kind: "conversation.user_message",
            node_id: node.id.clone(),
            summary: 摘要(&instruction),
            payload_ref: self.save_output(&node.id, "prompt.md", &instruction),
        });

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls = 0_u32;
        // 工具调用的标题只在首帧里。更新帧只带 id 与状态 ——
        // 不记住的话，完成事件是一条「（completed）」，说不出完成的是哪一次
        let mut tool_titles: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        let outcome = client.prompt(&session.id, &instruction, |update| match update {
            SessionUpdate::AgentText { text: chunk } => text.push_str(chunk),
            SessionUpdate::Reasoning { text: chunk } => reasoning.push_str(chunk),
            // 工具调用**逐个**发，不攒一个总数：图纸的对话视图里是
            // 「工具活动 · 6 次读取，2 次搜索」，那需要知道每次调的是什么。
            // 而且它们边跑边出现 —— AI 节点要好几分钟，这期间
            // 用户唯一能看到的「它还活着」就是这些
            SessionUpdate::ToolCall { id, title, status } => {
                // 首帧带标题就记下；更新帧拿它补上
                let 标题 = if title.is_empty() {
                    tool_titles.get(id).cloned().unwrap_or_default()
                } else {
                    tool_titles.insert(id.to_string(), title.to_string());
                    title.to_string()
                };

                // 按 status 分成契约里的三种，不是一律 started：
                // 对话投影只收 finished / failed（started 是过程噪声），
                // 全发 started 的话工具活动那一行永远是空的
                let kind = match status {
                    "failed" | "error" => "tool.call_failed",
                    "completed" | "success" => "tool.call_finished",
                    _ => "tool.call_started",
                };
                // 只在**结束**时计数：一次调用会来两帧（首帧 + 更新帧），
                // 每帧都加的话「工具活动 · 6 次」会翻倍
                if kind != "tool.call_started" {
                    tool_calls += 1;
                }
                sink(NodeEvent {
                    kind,
                    node_id: node.id.clone(),
                    summary: if 标题.is_empty() {
                        format!("工具调用 {id}（{status}）")
                    } else {
                        format!("{标题}（{status}）")
                    },
                    payload_ref: None,
                });
            }
            SessionUpdate::Other { .. } => {}
        });

        match outcome {
            Ok(stop) => {
                // 回答落产物：几十 KB 的分析不该进事件表
                let answer_ref = self.save_output(&node.id, "agent.md", &text);
                let reasoning_ref = if reasoning.is_empty() {
                    None
                } else {
                    self.save_output(&node.id, "reasoning.md", &reasoning)
                };

                // 推理在回答之前发：它是「怎么想的」，读起来在结论之前
                if !reasoning.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "reasoning.summary",
                        node_id: node.id.clone(),
                        summary: 摘要(&reasoning),
                        payload_ref: reasoning_ref,
                    });
                }
                if !text.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "conversation.agent_message",
                        node_id: node.id.clone(),
                        summary: 摘要(&text),
                        payload_ref: answer_ref,
                    });
                }

                // 端口从节点目录取，不硬编码 "success"：
                // ai.review 的端口是 passed / changes_requested，
                // ai.decide 是 auto_decided / escalated —— 硬编码的话，
                // 事件里会写「走 success 分支」这个根本不存在的分支，
                // 输出也落在一个下游引用不到的键上。
                //
                // 取第一个：**按模型的结论在多个端口之间选**是条件路由，
                // 还没做。先让说出来的那个端口至少是真的
                let port = crate::catalog::outputs(&node.node_type, &node.config)
                    .first()
                    .map_or_else(|| "success".to_string(), |p| p.id.clone());

                scope.set_node_output(
                    &node.id,
                    &port,
                    serde_json::json!({
                        "text": text,
                        "reasoning": reasoning,
                        "toolCalls": tool_calls,
                        "stopReason": format!("{stop:?}"),
                        "sessionId": session.id,
                        "mode": session.current_mode,
                    }),
                );

                Ok(NodeOutcome::Succeeded { port })
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

/// 上游最近一个跑成功的 `git.worktree` 节点给出的路径。
///
/// 按输出的形状认（同时有 `path` 与 `branch`），不按节点 id 认 ——
/// 用户给 worktree 节点起什么名字是他的自由。
/// `preserve_order` 让 outputs 保持写入顺序，所以「最近一个」是最后一个。
fn latest_worktree(scope: &Scope) -> Option<String> {
    let snapshot = scope.snapshot();
    let outputs = snapshot.get("outputs")?.as_object()?;
    outputs
        .values()
        .filter_map(|value| {
            value.get("branch")?;
            value.get("path")?.as_str().filter(|path| !path.is_empty())
        })
        .next_back()
        .map(str::to_string)
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}
