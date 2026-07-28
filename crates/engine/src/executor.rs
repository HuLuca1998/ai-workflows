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
    pub fn resolution_for(&self, node: &GraphNode) -> Option<Resolution> {
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
        })
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

    pub fn execute(&self, node: &GraphNode, scope: &mut Scope) -> Result<NodeOutcome> {
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
        if let Some(resolution) = self.resolution_for(node) {
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
