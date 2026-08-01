//! 节点执行器：把节点配置真的变成副作用。
//!
//! 一条铁律：**没实现的节点类型明确报「尚未实现」，绝不假装成功**。
//! 假装成功会让用户以为工作流跑通了，然后在下游拿到空数据时才发现，
//! 那时错误离原因已经很远。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::acp::{SessionUpdate, adapter_command, adapter_installed};
use crate::artifacts::{ArtifactKind, ArtifactStore};
use crate::exec::{ExecOutcome, ScriptRequest, run_script};
use crate::graph::GraphNode;
use crate::interp::{Scope, interpolate, interpolate_with, shell_quote};
use crate::notify::{Notification, Notifier};
use crate::risk::{ApprovalDecider, approval_decider};
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
    /// 这次运行用哪个模型 / 哪个推理深度。
    ///
    /// `None` = 不设，用 agent 自己的默认（实测 codex 是 `gpt-5.6-sol[high]`）。
    /// 值必须来自 agent 报的候选 —— 它自己会校验，设错了走降级而不是失败。
    model: Option<String>,
    effort: Option<String>,
    /// 实时帧往哪推。`None` = 不推（无头运行、测试）。
    ///
    /// 与事件流是两回事：事件落库、是事实来源；帧不落库、是「正在发生」
    /// 的投影。AI 节点要跑好几分钟，这期间运行面板上只有几条工具调用
    /// 事件在动，而 agent 说的话要等节点跑完才一次性出现。
    stream: Option<std::sync::Arc<dyn crate::acp::ChunkSink>>,
    /// 接给 AI 节点的系统 MCP。
    ///
    /// 空 = agent 手上没有任何工具，只能凭提示词里的文字工作：
    /// 读不到工作流、改不动草稿、也看不到自己上一步跑出了什么。
    /// 主管 AI 一直是接着的，AI 节点一直不是 —— 而这件事没有任何地方写着。
    mcp: Vec<crate::acp::McpHttpServer>,
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
     * AI 审批者最近一次收到的提示词。
     *
     * 留档是为了能验证「审批者到底看见了什么」—— 只把节点类型
     * 发过去的话，它只能对着「script.shell」这四个字表态，
     * 而那种审批看起来在工作，实际什么都没审。
     */
    last_gate_prompt: std::sync::Mutex<Option<String>>,
    /**
     * 谁把系统通知发出去。
     *
     * 引擎自己发不了 —— 它是个库，跑在没有桌面的地方也要能编译。
     * **None 时 `notify` 节点明确报发不了**，不返回成功
     * （DEBT.md 的 B-1 就是那个「什么都不做直接成功」）。
     */
    notifier: Option<std::sync::Arc<dyn Notifier>>,
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
    prompts: Vec<PromptEntry>,
    /// 「模型」页登记且启用的条目。空 = 模型页空着（全新安装），
    /// 那时不做任何解析也不报降级 —— 没有目录，谈不上「要的给不了」。
    models: Vec<ModelEntry>,
    /// 每个 AI 节点实际用了什么。上层据此写可解释性事件。
    resolutions: std::sync::Mutex<Vec<Resolution>>,
}

/// 这个节点最终跑在哪个 runtime 上。
///
/// 角色说了算：节点上的 `runtime` 是 M2 时期的写法（那时还没有角色），
/// 两处都写着时以界面上用户真正在改的那一栏为准。
///
/// 抽成自由函数是因为 **Dry Run 也要解出同一个值** —— 它原来自己
/// 读 `node.config["runtime"]`、自己缺省 `acp.claude`，
/// 于是查的 adapter 和执行时用的不是一个。两处各写一套默认值，
/// 迟早对不上；对不上的样子是「Dry Run 说通过，一跑就挂」。
#[must_use]
pub fn resolve_runtime(node: &GraphNode, profiles: &[AgentProfile]) -> String {
    let from_profile = node
        .config
        .get("agentProfileId")
        .and_then(serde_json::Value::as_str)
        .and_then(|id| profiles.iter().find(|p| p.id == id));
    if let Some(profile) = from_profile {
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

/// 一个 Agent 角色，解析好的形态。
///
/// **执行器不碰数据库** —— 上层查好了传进来。这样它既能单测，
/// 也不会在执行中途因为角色被改而拿到前后不一致的两份。
/// 提示词库的一条（B-3）。运行开始时随角色一起查好交给执行器 ——
/// 执行器不碰数据库，中途被改也不会拿到前后不一致的两份。
#[derive(Debug, Clone)]
pub struct PromptEntry {
    pub id: String,
    pub name: String,
    pub ver: i64,
    /// 框架分段（标题, 正文），有序。
    pub sections: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub role: String,
    pub goal: String,
    pub persona: String,
    pub runtime: String,
    pub model_ref: String,
    /// 主选模型不可用时的后备。空 = 没配。
    /// 「模型失效就不设置，用系统默认的」那条链在它之后。
    pub fallback_model_ref: String,
    pub output_contract: String,
    /// 引擎强制的能力声明（JSON）。图纸「05 Agent 角色」写着
    /// 「权限（引擎强制，Prompt 无法越权）」——就靠它。
    pub capabilities_json: String,
    pub timeout_ms: i64,
}

/// 「模型」页登记的一个可用条目。
///
/// runner 从库里查好交进来（只传启用的）—— 执行器不碰数据库，
/// 与 [`AgentProfile`] 同一条理由。
#[derive(Debug, Clone)]
pub struct ModelEntry {
    /// 登记条目的 id（`model:xxx`）。`modelPolicy.modelId` 与
    /// 角色的 `model_ref` 引用的都是它。
    pub id: String,
    pub name: String,
    pub runtime: String,
    /// 交给 adapter 的那个名字（`claude-sonnet-4-5`）。
    /// 值必须在 agent 报的候选里 —— 不在的话 adapter 会拒，走降级。
    pub model_id: String,
    /// minimal / low / medium / high（同步进来的更高档也认，见 `effort_rank`）。
    pub effort: String,
    /// 传全量目录进来（含停用的）：解析要区分「未登记」与「已停用」——
    /// 前者是配置坏了要报降级，后者是用户自己的显式动作，
    /// 把他刚停用的模型报成「降级」等于把他的决定当故障。
    pub enabled: bool,
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
    /// 实际交给 adapter 的模型名；没配就是 `agent 默认`。
    /// 写「没配」的实话，比留一个空串让读记录的人猜强。
    pub model_ref: String,
    /// 实际交给 adapter 的推理档。空 = 未指定。
    pub effort: String,
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

/// 一个 AI 节点最终交给 adapter 的模型。`None` = 不设，agent 用自己的默认。
#[derive(Debug, Default)]
struct ModelChoice {
    model: Option<String>,
    effort: Option<String>,
    /// 解析过程里每一次「要的给不了」。执行时逐条写 `system.model_downgraded`。
    downgraded: Vec<String>,
}

impl ModelChoice {
    fn pick(mut self, entry: &ModelEntry) -> Self {
        self.model = Some(entry.model_id.clone());
        self.effort = Some(entry.effort.clone());
        self
    }
}

/// 推理档的序。认不出的值按 medium 算 —— 排序要的是稳定，不是精确。
///
/// 高于 high 的档（`xhigh` / `max` / `ultra`）两端 runtime 都真实报过
/// （`docs/acp/transcripts/`）—— 少了它们，`quality` 会把最高档当中档。
fn effort_rank(effort: &str) -> u8 {
    match effort {
        "minimal" => 0,
        "low" => 1,
        "high" => 3,
        "xhigh" | "max" | "ultra" => 4,
        _ => 2,
    }
}

/// 档位 → 候选里的哪一条。
///
/// fast 取推理档最低的、quality 取最高的、balanced 优先 medium
/// （没有就取离 medium 最近的）。平手时取目录里靠前的 —— 目录顺序
/// 由「模型」页决定，用户看得见，比这里再发明一套排序规则可解释。
fn pick_tier<'a>(candidates: &[&'a ModelEntry], tier: &str) -> Option<&'a ModelEntry> {
    match tier {
        "fast" => candidates
            .iter()
            .min_by_key(|entry| effort_rank(&entry.effort))
            .copied(),
        // min_by_key 平手取第一个，max_by_key 取最后一个 ——
        // 三个档都走 min_by_key，平手规则才一致
        "quality" => candidates
            .iter()
            .min_by_key(|entry| std::cmp::Reverse(effort_rank(&entry.effort)))
            .copied(),
        "balanced" => candidates
            .iter()
            .min_by_key(|entry| (i32::from(effort_rank(&entry.effort)) - 2).abs())
            .copied(),
        // 认不出的档位选不出条目 —— 上层会记一条降级，不静默
        _ => None,
    }
}

/// 「回答」其实是 adapter 吐回来的上游报错。
///
/// 第 3 轮实测的事故：LLM 网关 502，codex adapter 把
/// `unexpected status 502 Bad Gateway: …` 当**普通 agent 消息**发回来，
/// stopReason 还是正常的 end_turn —— 协议层看不出任何异常，节点绿了，
/// 下游把这段报错当「纪要」写进了用户的文件。
///
/// 判据从紧：整段回答**以已知报错形态开头**且很短（真实分析不会只有一行
/// HTTP 报错）。宁可放过一条真报错，也不能把正常回答误杀。
pub fn adapter_error_in_answer(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 500 {
        return None;
    }
    let known_shapes = [
        "unexpected status ",
        "error sending request",
        "API Error:",
        "api error:",
        "stream error:",
        "connection refused",
        "connection reset",
    ];
    let lowered = trimmed.to_lowercase();
    known_shapes
        .iter()
        .any(|shape| lowered.starts_with(&shape.to_lowercase()))
        .then(|| trimmed.to_string())
}

/// 摘要的长度上限。
///
/// 存储层的硬上限是 2000 字符，但对话流里一条几千字的气泡也没法看。
/// 截到能一眼扫完的长度，全文点 payload_ref 去看。
const SUMMARY_CHARS: usize = 400;

fn summarize(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= SUMMARY_CHARS {
        return trimmed.to_string();
    }
    format!(
        "{}…",
        trimmed.chars().take(SUMMARY_CHARS).collect::<String>()
    )
}

/// AI 审批者等多久。
///
/// 比 AI 节点短得多：它只需要看一个节点的配置就表态，
/// 而卡在这里的代价是整条运行停着不动 —— 超时之后升级人工，
/// 用户至少能自己点。
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// AI 审批者给的答复。
#[derive(Debug, Clone, PartialEq, Eq)]
enum AiVerdict {
    Approved,
    Rejected {
        reason: String,
    },
    /// 没给出明确决定 —— 升级给人。
    CannotDecide,
}

/// 上游节点到目前为止产出了什么。
///
/// 从 `Scope` 取而不是让调度器传进来：Scope 本来就是「这次运行到现在
/// 攒下了什么」的权威副本，再开一条传递路径就多一处会不一致的地方。
///
/// 全量交给审批者，不挑。挑就要为每种上游节点维护一份「哪些字段重要」
/// 的清单，而漏掉的那个恰恰可能是他要判断的依据。太长时截断 ——
/// 一份几十 MB 的 stdout 发过去只会撑爆上下文。
fn upstream_output(scope: &Scope) -> String {
    /// 单个上游产出的上限。超了截断并说明 —— 悄悄截断的话，
    /// 审批者会对着半份 diff 做判断，而它看起来是完整的
    const PER_ITEM_LIMIT: usize = 8_000;

    let snapshot = scope.snapshot();
    let Some(outputs) = snapshot
        .get("outputs")
        .and_then(serde_json::Value::as_object)
    else {
        return String::new();
    };

    let mut material = String::new();
    for (key, value) in outputs {
        let text = match value {
            serde_json::Value::String(text) => text.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        };
        material.push_str(&format!("--- {key} ---\n"));
        if text.chars().count() > PER_ITEM_LIMIT {
            let head: String = text.chars().take(PER_ITEM_LIMIT).collect();
            material.push_str(&head);
            material.push_str(&format!(
                "\n…（这一项太长，只给了前 {PER_ITEM_LIMIT} 个字。完整内容在运行详情的产物里）\n"
            ));
        } else {
            material.push_str(&text);
            material.push('\n');
        }
    }
    material
}

/// 交给 AI 审批者的提示词。
///
/// 这是一道**门**，不是一个执行节点。所以要说清三件事：
/// 这道门守的是什么（标题与正文，工作流作者写给审批者看的）、
/// **上游刚做完了什么**（那是他要判断的材料）、答复要长什么样。
///
/// 上游产出不能省。只把门的标题发过去的话，AI 只能对着
/// 「检查 Diff 与风险」这几个字表态 —— 那种审批看起来在工作，
/// 实际什么都没审。
fn approval_prompt(node: &GraphNode, upstream: &str) -> String {
    let text_body = node
        .config
        .get("bodyMarkdown")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");

    let title = node
        .config
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&node.title);

    let material = if upstream.trim().is_empty() {
        "（上游没有产出可看 —— 这本身就值得怀疑：\
         一道审批门前面通常有一步刚做完的事）"
            .to_string()
    } else {
        format!("```\n{upstream}\n```")
    };

    format!(
        "你是这条工作流上的审批者。前面一步刚做完，现在到了一道门，\
         请判断放行还是拒绝。\n\
         \n\
         这道门：{title}\n\
         {text_body}\n\
         \n\
         上游刚产出的东西：\n\
         {material}\n\
         \n\
         判断依据：\n\
         - 上游做的是不是这条工作流该做的那件事，有没有跑偏\n\
         - 有没有超出范围的改动（碰了无关文件、删了不该删的、外发了数据）\n\
         - 放行之后接下来会真的执行 —— 包括推分支、开 PR 这类别人看得见的操作\n\
         \n\
         拿不准就拒绝 —— 拒绝只是让工作流走另一条分支，放行是不可逆的。\n\
         \n\
         答复格式（第一行必须是这个，且只出现一次）：\n\
         DECISION: APPROVE 或 DECISION: REJECT\n\
         第二行起写一句话理由。"
    )
}

/// 从答复里读出决定。
///
/// **只有恰好一个决定时才作数。** 两个都出现（`DECISION: APPROVE …
/// 不过 DECISION: REJECT 更稳妥`）是提示词注入最容易造出来的形状，
/// 「取第一个」会让注入者赢。一个都没有的话是模型没照格式答，
/// 从措辞里猜等于让用词决定要不要放行。
fn parse_verdict(answer: &str) -> AiVerdict {
    let upper = answer.to_ascii_uppercase();
    let approve = upper.matches("DECISION: APPROVE").count();
    let reject = upper.matches("DECISION: REJECT").count();

    match (approve, reject) {
        (1, 0) => AiVerdict::Approved,
        (0, 1) => AiVerdict::Rejected {
            // 理由是给用户看的 —— 被拦下来却不知道为什么，
            // 用户只能把这一档关掉
            reason: reason(answer),
        },
        _ => AiVerdict::CannotDecide,
    }
}

/// 决定那一行之后的话。没有就退回整段。
fn reason(answer: &str) -> String {
    let rest = answer
        .lines()
        .skip_while(|line| !line.to_ascii_uppercase().contains("DECISION:"))
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ");
    let rest = rest.trim();
    if rest.is_empty() {
        summarize(answer)
    } else {
        summarize(rest)
    }
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
            model: None,
            effort: None,
            stream: None,
            mcp: Vec::new(),
            memories: Vec::new(),
            injected: std::sync::Mutex::new(Vec::new()),
            // 没设过就按最严的办
            permission_preset: "human_approval".to_string(),
            approved_nodes: Vec::new(),
            last_gate_prompt: std::sync::Mutex::new(None),
            notifier: None,
            capabilities: None,
            agent_profiles: Vec::new(),
            prompts: Vec::new(),
            models: Vec::new(),
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

    /// 图里引用到的提示词（B-3）。节点写了 promptId 而这里查不到是硬错误 ——
    /// 静默退回内建框架的话，用户在库里挑的那份一个字都没到模型面前，
    /// 而界面上显示的是他挑的名字。
    #[must_use]
    pub fn with_prompts(mut self, prompts: &[PromptEntry]) -> Self {
        self.prompts = prompts.to_vec();
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
        // 与执行时同一份解析 —— 事件里写一个、adapter 收到另一个，
        // 可解释性就成了误导
        let choice = self.resolve_model(node);
        Some(Resolution {
            node_id: node.id.clone(),
            agent_profile_id: profile.map(|p| p.id.clone()).unwrap_or_default(),
            agent_name: profile.map(|p| p.name.clone()).unwrap_or_default(),
            model_ref: choice
                .model
                .or_else(|| self.model.clone())
                .unwrap_or_else(|| "agent 默认".to_string()),
            effort: choice
                .effort
                .or_else(|| self.effort.clone())
                .unwrap_or_default(),
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

    /// 这个节点最终交给 adapter 的模型。
    ///
    /// 解析顺序：节点的 `modelPolicy`（钉住某条 / fast、balanced、quality）
    /// → 角色的 `model_ref` → 角色的 `fallback_model_ref` → 不设。
    /// 每一次「要的给不了」都记进 `downgraded`，执行时写
    /// `system.model_downgraded` —— AgentsPage 上写着「降级发生时会写入
    /// RunEvent，不会静默替换模型」，这句话就靠它。
    fn resolve_model(&self, node: &GraphNode) -> ModelChoice {
        let mut choice = ModelChoice::default();
        // 模型页空着（全新安装）：不解析、不降级 —— 没有目录，
        // 谈不上「要的给不了」；每个节点报一条降级是误导
        if self.models.is_empty() {
            return choice;
        }

        let runtime = self.resolved_runtime(node);
        let candidates: Vec<&ModelEntry> = self
            .models
            .iter()
            .filter(|entry| entry.enabled && entry.runtime == runtime)
            .collect();

        // 一个引用查下来的三种下场，各有各的说法：
        // 找到且可用 → 用；已停用 → 静默按没配（停用是用户的显式动作，
        // 把他的决定报成降级等于把它当故障）；未登记 / runtime 不符 → 降级
        enum Lookup<'a> {
            Usable(&'a ModelEntry),
            DisabledByUser,
            Missing(String),
        }
        let look_up = |id: &str, who: &str| -> Lookup<'_> {
            match self.models.iter().find(|entry| entry.id == id) {
                Some(entry) if entry.enabled && entry.runtime == runtime => Lookup::Usable(entry),
                Some(entry) if !entry.enabled => Lookup::DisabledByUser,
                Some(entry) => Lookup::Missing(format!(
                    "{who} {id} 属于 runtime {}，这个节点跑在 {runtime} 上，用不了",
                    entry.runtime
                )),
                None => Lookup::Missing(format!("{who} {id} 没有在「模型」页登记")),
            }
        };

        match node.config.get("modelPolicy") {
            Some(serde_json::Value::String(tier)) => {
                if let Some(entry) = pick_tier(&candidates, tier) {
                    return choice.pick(entry);
                }
                choice.downgraded.push(format!(
                    "模型策略「{tier}」在 runtime {runtime} 下选不出条目，退回角色默认"
                ));
            }
            Some(serde_json::Value::Object(policy)) => {
                if let Some(id) = policy.get("modelId").and_then(serde_json::Value::as_str) {
                    match look_up(id, "节点钉住的模型") {
                        Lookup::Usable(entry) => return choice.pick(entry),
                        Lookup::DisabledByUser => {}
                        Lookup::Missing(reason) => {
                            choice.downgraded.push(format!("{reason}，退回角色默认"));
                        }
                    }
                }
            }
            _ => {}
        }

        let Some(profile) = self.profile_for(node) else {
            return choice;
        };
        if profile.model_ref.is_empty() {
            return choice;
        }
        match look_up(
            &profile.model_ref,
            &format!("角色「{}」的模型", profile.name),
        ) {
            Lookup::Usable(entry) => return choice.pick(entry),
            // 停用不算降级，但后备正是为「主选不可用」准备的 —— 接着试
            Lookup::DisabledByUser => {}
            Lookup::Missing(reason) => choice.downgraded.push(reason),
        }
        if profile.fallback_model_ref.is_empty() {
            return choice;
        }
        match look_up(&profile.fallback_model_ref, "后备模型") {
            Lookup::Usable(entry) => choice.pick(entry),
            Lookup::DisabledByUser => choice,
            Lookup::Missing(reason) => {
                choice.downgraded.push(format!("{reason}，改用 agent 默认"));
                choice
            }
        }
    }

    /// 这个节点最终跑在哪个 runtime 上。
    #[must_use]
    pub fn resolved_runtime(&self, node: &GraphNode) -> String {
        resolve_runtime(node, &self.agent_profiles)
    }

    /// Agent 角色声明的能力。不传表示这次运行没挂角色。
    ///
    /// **目前只有测试传**。留着是因为它是「运行级兜底」那条路的入口，
    /// 但在接上生产调用点之前，别再往 `check_capability` 里加
    /// 只有它才够得着的分支 —— `capability_reach_test` 守着这件事。
    #[must_use]
    pub fn with_capabilities(mut self, capabilities: &serde_json::Value) -> Self {
        self.capabilities = Some(capabilities.clone());
        self
    }

    /// 角色声明的能力**不再由引擎强制**。
    ///
    /// 上一版在这里逐项拦：角色的「文件」权限不是可读写就不让
    /// `ai.execute` 跑。现在的设计是**权限由流程管** ——
    /// 执行节点拿最高权限，要不要停下来问由工作流里有没有
    /// 在那个位置放一道 `approval` 门决定。
    ///
    /// capabilities 字段留着，但它的身份变了：从「引擎强制的边界」
    /// 变成「写进提示词交给 agent 的约束说明」。
    /// **Agent 角色页上那句「引擎强制，Prompt 无法越权」必须跟着改** ——
    /// 界面承诺一件实现里没有的事，比不承诺更糟。
    fn capability_note(&self, node: &GraphNode) -> Option<String> {
        let profile = self.profile_for(node)?;
        let caps: serde_json::Value = serde_json::from_str(&profile.capabilities_json).ok()?;
        // **枚举外的值一律当成 none。**
        //
        // 直接把库里那个字符串念给 agent 听的话，一个拼错的
        // `"READ-WRITE"` 会让它以为自己被授权做一件用户没授权的事。
        // 认不出的输入在安全判断里只能往严了算 —— 这里虽然只是提示词，
        // 但说错的后果与放行是一样的
        let level = |key: &str| -> String {
            let allowed: &[&str] = match key {
                "file" | "memory" => &["none", "read", "read-write"],
                "command" => &["none", "declared", "any"],
                "network" => &["none", "allowlist", "any"],
                _ => &[],
            };
            caps.get(key)
                .and_then(serde_json::Value::as_str)
                .filter(|value| allowed.contains(value))
                .unwrap_or("none")
                .to_string()
        };
        Some(format!(
            "这个角色声明的边界：文件 {} · 命令 {} · 网络 {}。\
             请自觉遵守 —— 超出范围的事先停下来说明，不要直接做。",
            level("file"),
            level("command"),
            level("network"),
        ))
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

    /// 接上系统通知的发送器。
    ///
    /// 桌面壳注入一个走 `tauri-plugin-notification` 的实现。
    /// 不注入时 `notify` 节点报「这个环境发不了系统通知」——
    /// 那是真话，而「发送成功」不是。
    #[must_use]
    pub fn with_notifier(mut self, notifier: std::sync::Arc<dyn Notifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    /// 已经被用户批准过的节点。恢复执行时靠它跳过重复的审批。
    #[must_use]
    pub fn with_approved_nodes(mut self, node_ids: &[String]) -> Self {
        self.approved_nodes = node_ids.to_vec();
        self
    }

    /// 这道审批门该由谁批。
    ///
    /// **只对 `approval` 节点有意义。** 执行节点不再被自动拦截 ——
    /// 权限由流程管：要不要停下来问，取决于工作流里有没有在这个位置
    /// 放一道门，不取决于节点属于哪种类型或脚本里写了什么。
    ///
    /// 上一版按风险自动拦截，结果是「读一个 Issue 也要人点一次」。
    #[must_use]
    pub fn decider_for(&self, node: &GraphNode) -> ApprovalDecider {
        let node_decider = node
            .config
            .get("decider")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("auto");
        approval_decider(&self.permission_preset, node_decider)
    }

    /// 一条工作流里的哪些节点是门。
    ///
    /// 就是 `approval` 节点 —— 暴露出来是给 Dry Run 用的：
    /// 运行之前要能告诉用户「这条工作流有几道门、分别在哪」，
    /// 那是「权限由流程管」这个设计唯一的兜底。
    #[must_use]
    pub fn is_gate(node: &GraphNode) -> bool {
        node.node_type == "approval"
    }

    /// 只跑执行**之前**那道关。
    ///
    /// 放行时返回 `None`。抽出来是因为这道关本身值得单独测 ——
    /// 走完整的 `execute` 会真的起进程、连 adapter，
    /// 而要验证的只是「它到底拦不拦」。
    ///
    /// **AI 审批不在这里**：它要起一个 adapter 进程，而这个方法的用途
    /// 之一就是「不起进程地问一句拦不拦」。AI 那一支在
    /// [`execute_with_sink`] 里走。
    #[must_use]
    pub fn precheck(&self, node: &GraphNode) -> Option<NodeOutcome> {
        if !Self::is_gate(node) {
            return None;
        }
        // 批过一次就不再问。恢复运行时靠它不停在同一道门上
        if self.approved_nodes.iter().any(|id| id == &node.id) {
            return None;
        }
        if self.decider_for(node) == ApprovalDecider::Human {
            return Some(NodeOutcome::NeedsApproval);
        }
        None
    }

    /// 审批者用哪个 runtime。
    ///
    /// 节点上写了 `deciderAgentProfileId` 就用那个角色的，否则用默认。
    /// **刻意与执行的角色分开**：让写代码的那个 agent 自己批自己的改动，
    /// 等于没有这道门。
    fn gate_runtime(&self, node: &GraphNode) -> String {
        node.config
            .get("deciderAgentProfileId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .and_then(|id| self.agent_profiles.iter().find(|p| p.id == id))
            .map_or_else(|| self.resolved_runtime(node), |p| p.runtime.clone())
    }

    /// AI 审批者最近一次收到的提示词。
    ///
    /// 留这个观测口是因为「审批者到底看见了什么」决定了它的判断值不值钱 ——
    /// 只把节点类型发过去的话，它只能对着「script.shell」这四个字表态，
    /// 而那种审批看起来在工作，实际什么都没审。
    #[must_use]
    pub fn last_gate_prompt(&self) -> Option<String> {
        self.last_gate_prompt.lock().ok().and_then(|p| p.clone())
    }

    /// 让 AI 审批者看一眼这个节点。
    ///
    /// 三种结果：放行、拒绝、判不了。**判不了一律升级给人**，
    /// 包括 adapter 连不上、超时、回答里没有明确决定、
    /// 两个决定同时出现。
    ///
    /// fail closed 在这里不是保守习惯而是必需的：审批者请不来时放行，
    /// 等于「AI 审批」这一档在没装 adapter 的机器上把所有门都打开了，
    /// 而用户在设置里读到的是「AI 会替你把关」。
    fn ai_gate(&self, node: &GraphNode, scope: &Scope, sink: &EventSink<'_>) -> AiVerdict {
        let prompt = approval_prompt(node, &upstream_output(scope));
        if let Ok(mut slot) = self.last_gate_prompt.lock() {
            *slot = Some(prompt.clone());
        }

        // 先说一句「正在审批」再去问。
        //
        // AI 审批要起一个 adapter 进程、跑一轮对话，几十秒是常事 ——
        // 这期间界面上那道门如果什么都不显示，用户看到的就是「卡住了」，
        // 而他并不知道有一次审批正在进行
        sink(NodeEvent {
            kind: "approval.requested",
            node_id: node.id.clone(),
            summary: format!("交给 AI 审批：{}", node.title),
            payload_ref: self.save_output(&node.id, "approval-prompt.md", &prompt, sink),
        });

        // 审批者用这次运行的默认工作目录。它只读，不该进 worktree
        let cwd = self.workdir.display().to_string();
        // 审批者的角色刻意与执行的分开：让写代码的那个 agent
        // 自己批自己的改动，等于没有这道门
        let runtime = self.gate_runtime(node);

        let answer = match self.ask_once(&runtime, &cwd, &prompt, APPROVAL_TIMEOUT) {
            Ok(text) => text,
            Err(reason) => {
                sink(NodeEvent {
                    kind: "approval.decided",
                    node_id: node.id.clone(),
                    summary: format!("AI 审批没能进行（{reason}），改由你来决定"),
                    payload_ref: None,
                });
                return AiVerdict::CannotDecide;
            }
        };

        let verdict = parse_verdict(&answer);
        let verdict_line = match verdict {
            AiVerdict::Approved => "AI 审批：放行",
            AiVerdict::Rejected { .. } => "AI 审批：拒绝",
            AiVerdict::CannotDecide => "AI 没给出明确决定，改由你来决定",
        };
        sink(NodeEvent {
            kind: "approval.decided",
            node_id: node.id.clone(),
            summary: format!("{verdict_line} · {}", summarize(&answer)),
            payload_ref: self.save_output(&node.id, "approval.md", &answer, sink),
        });

        verdict
    }

    /// 连一次 adapter，问一句，把回答的文本拿回来。
    ///
    /// 与 `run_ai` 的区别是它**不发对话事件、不落产物、不解析端口** ——
    /// 审批者的一问一答不属于工作流的对话流，混进去会让运行详情里
    /// 多出一段用户没有配过的对话。
    fn ask_once(
        &self,
        runtime: &str,
        cwd: &str,
        prompt: &str,
        timeout: Duration,
    ) -> std::result::Result<String, String> {
        // 与 AI 节点、主管 AI、连通性测试**同一个入口**。
        //
        // 原先这里自己写了一遍「找 adapter → connect → new_session」，
        // 四处各写一份的结果是：模型、推理深度、权限档那三格四处全是空的，
        // 而每次想补一格都得改四个地方（于是一格都没补）。
        let opened = crate::acp::open_session(&crate::acp::SessionSpec {
            runtime: runtime.to_string(),
            cwd: cwd.to_string(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            mode: None,
            mcp: Vec::new(),
            timeout,
            adapter_override: self.acp_override.clone(),
        })
        .map_err(|error| format!("连不上 adapter：{error}"))?;

        let crate::acp::OpenedSession {
            mut client,
            session,
            downgraded,
        } = opened;
        // 审批者的降级只记日志：它的一问一答不进工作流的对话流
        // （见这个方法的文档注释），往事件表里塞一条用户没配过的降级
        // 会让运行详情多出一段他看不懂的东西
        for down in &downgraded {
            eprintln!("[approval] {down}");
        }

        let mut text = String::new();
        let outcome = client.prompt(&session.id, prompt, |update| {
            if let SessionUpdate::AgentText { text: chunk } = update {
                text.push_str(chunk);
            }
        });

        match outcome {
            Ok(crate::acp::PromptOutcome::Refusal) => Err("模型拒绝了这一轮".to_string()),
            Ok(_) => Ok(text),
            Err(error) => Err(format!("问不出结果：{error}")),
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

    /// 这次运行用哪个模型、哪个推理深度。
    ///
    /// 两个都是 `Option`：不给就是不设，用 agent 自己的默认 ——
    /// 「模型失效就不设置，用系统默认的」那条路要真的存在。
    ///
    /// 这是**运行级兜底**。节点级的选择走 `modelPolicy` 与角色的
    /// `model_ref`（[`Self::with_models`] 给目录），解析得出的值优先。
    #[must_use]
    pub fn with_model(mut self, model: Option<String>, effort: Option<String>) -> Self {
        self.model = model;
        self.effort = effort;
        self
    }

    /// 「模型」页登记且启用的条目。
    ///
    /// 不传（或空）= 模型页空着：不解析、不降级，agent 用自己的默认。
    #[must_use]
    pub fn with_models(mut self, models: &[ModelEntry]) -> Self {
        self.models = models.to_vec();
        self
    }

    /// 把系统 MCP 接给 AI 节点。
    #[must_use]
    pub fn with_mcp(mut self, servers: &[crate::acp::McpHttpServer]) -> Self {
        self.mcp = servers.to_vec();
        self
    }

    /// 实时帧往哪推。不设就不推 —— 无头运行与测试都走这条。
    #[must_use]
    pub fn with_stream(mut self, sink: std::sync::Arc<dyn crate::acp::ChunkSink>) -> Self {
        self.stream = Some(sink);
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
        // 审批门先说话。引擎不拦的话，设置屏那三张卡就只是三个好看的卡片。
        //
        // **只有 `approval` 节点会被拦**：权限由流程管，执行节点拿最高权限。
        // 一条没放 approval 节点的工作流会一路跑到底，包括 push
        if let Some(outcome) = self.precheck(node) {
            return Ok(outcome);
        }

        match node.node_type.as_str() {
            // entry 什么都不做是**对的** —— 它就是个标记
            "entry" => Ok(NodeOutcome::Succeeded {
                port: "success".to_string(),
            }),

            // end 也是标记，但它多做一件事：把 `artifacts` 里声明的文件
            // 从工作目录收进产物库。没有这一步的话 `end.artifacts`
            // 就是「填了不生效」，而**报告抽屉永远打不开** ——
            // 界面按 `report.json` 找产物，引擎只会存 stdout.log / agent.md
            // 那几个固定名字
            "end" => self.collect_final_artifacts(node, sink),

            "notify" => self.run_notify(node, scope, sink),

            // 一道门。走到这里说明 precheck 判的是「交给 AI」——
            // 判「交给人」的那一支在 precheck 里就返回 NeedsApproval 了
            "approval" => match self.ai_gate(node, scope, sink) {
                AiVerdict::Approved => Ok(NodeOutcome::Succeeded {
                    port: "approved".to_string(),
                }),
                // AI 说不行就走 rejected 端口，让工作流自己决定接下来怎么办
                // （内置模板把它接到一个 outcome 为 failure 的终点）——
                // 而不是让整个节点失败，那样图上那条边就白连了
                AiVerdict::Rejected { .. } => Ok(NodeOutcome::Succeeded {
                    port: "rejected".to_string(),
                }),
                // 判不了就交回给人。这一支是 fail closed 的落点：
                // adapter 连不上、超时、答复里没有明确决定都会走到这里
                AiVerdict::CannotDecide => Ok(NodeOutcome::NeedsApproval),
            },

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

    /// 发一条系统通知。
    ///
    /// 引擎自己发不了 —— 它是个库。真正的发送由外壳注入
    /// （`with_notifier`），**没注入就明确报发不了**，不返回成功。
    fn run_notify(
        &self,
        node: &GraphNode,
        scope: &mut Scope,
        sink: &EventSink<'_>,
    ) -> Result<NodeOutcome> {
        // 标题与正文在契约里都是 min(1) 的必填。缺了就报错，
        // 不发一条空通知 —— 用户收到一个没有内容的横幅，
        // 不知道是哪条工作流发的，比不发更糟
        let title_raw = self.require_str(node, "title")?;
        let body_raw = self.require_str(node, "body")?;

        // 不插值的话，通知上写的是 `${input.issue}` 这串字面量
        let interp = |raw: &str| -> std::result::Result<String, String> {
            interpolate(raw, scope).map_err(|error| error.to_string())
        };
        let (title, body) = match (interp(&title_raw), interp(&body_raw)) {
            (Ok(title), Ok(body)) => (title, body),
            (Err(message), _) | (_, Err(message)) => {
                return Ok(NodeOutcome::Failed { message });
            }
        };

        let subtitle = node
            .config
            .get("subtitle")
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .and_then(|raw| interp(raw).ok());

        let notification = Notification {
            title,
            subtitle,
            body,
            click_action: node
                .config
                .get("clickAction")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("open_run")
                .to_string(),
            run_id: scope.run_id().to_string(),
            node_id: node.id.clone(),
        };

        let result = match &self.notifier {
            Some(notifier) => notifier.send(&notification),
            // 没有发送器 —— 这个环境（无头、Web、CI）发不了通知。
            // 这句话是真的；「发送成功」不是
            None => Err("这个环境发不了系统通知：桌面外壳没有接上通知发送器。\
                         在 macOS App 里跑这条工作流才会真的弹出通知"
                .to_string()),
        };

        // 发没发出去都要留事件。
        //
        // 通知发生在应用之外，事件流是**唯一**能回答「到底有没有发出去」
        // 的地方 —— 而用户抱怨「我没收到通知」时，第一个要分清的就是
        // 「没发」还是「发了但系统没显示」
        let summarize = match &result {
            Ok(()) => format!("已发出通知：{}", notification.title),
            Err(reason) => format!("通知没能发出（{}）：{reason}", notification.title),
        };
        sink(NodeEvent {
            kind: "system.notification_sent",
            node_id: node.id.clone(),
            summary: summarize,
            payload_ref: None,
        });

        match result {
            Ok(()) => Ok(NodeOutcome::Succeeded {
                port: "success".to_string(),
            }),
            Err(reason) => {
                // 通知是提醒不是产出。默认 ignore：发不出去就走 failed 端口
                // 往下走，而不是把整条工作流拖挂
                match node
                    .config
                    .get("onFailure")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("ignore")
                {
                    "fail_node" => Ok(NodeOutcome::Failed { message: reason }),
                    // retry 归调度器管（节点级重试策略），执行器这里与 ignore 同路
                    _ => Ok(NodeOutcome::Succeeded {
                        port: "failed".to_string(),
                    }),
                }
            }
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
            summary: format!("{interpreter} · {}", summarize(&script)),
            payload_ref: self.save_output(&node.id, "command.sh", &script, sink),
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
                stdout_truncated,
                stderr_truncated,
                ..
            } => {
                let truncated = stdout_truncated || stderr_truncated;
                // 落产物必须在判断成败**之前**：脚本失败时最需要看日志，
                // 而失败分支提前 return 的话，恰恰是这时候没有日志可看。
                // 事件同理 —— 下面这三条也在成败判断之前发
                let out_ref = self.save_output(&node.id, "stdout.log", &stdout, sink);
                let err_ref = self.save_output(&node.id, "stderr.log", &stderr, sink);

                // 一份被砍掉的日志和一份完整的在产物列表里长得一样 ——
                // 截断必须在事件流里指名道姓（B-2）
                for (stream_truncated, stream_ref) in
                    [(stdout_truncated, &out_ref), (stderr_truncated, &err_ref)]
                {
                    if stream_truncated {
                        if let Some(rel) = stream_ref {
                            sink(NodeEvent {
                                kind: "artifact.truncated",
                                node_id: node.id.clone(),
                                summary: format!("产物 {rel} 超出上限，只保留了前面的部分"),
                                payload_ref: Some(rel.clone()),
                            });
                        }
                    }
                }

                if !stdout.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "script.stdout",
                        node_id: node.id.clone(),
                        summary: summarize(&stdout),
                        payload_ref: out_ref,
                    });
                }
                if !stderr.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "script.stderr",
                        node_id: node.id.clone(),
                        summary: summarize(&stderr),
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
            repo_root: repo_path.clone(),
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
                        // 运行结束时按 cleanupPolicy 清理要知道主仓库在哪 ——
                        // checkpoint 会把它跨重启保住，别的地方拿不到这个值
                        "repoRoot": repo_path.display().to_string(),
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

    /// 把 `end.artifacts` 里声明的文件从工作目录收进产物库。
    ///
    /// 三条规矩，每条都对应一种「悄悄出错」：
    ///
    /// - **找不到就发事件说出来**。静默跳过的话，用户在 end 上写了
    ///   `report.json`、运行绿着结束、抽屉里什么都没有，而没有一处
    ///   告诉他文件名写错了
    /// - **不许逃出工作目录**。产物会进导出物与诊断包，
    ///   `../../.ssh/id_rsa` 是一条真实的外泄路径
    /// - **收不到不让运行失败**。正事都做完了，因为一个报告文件
    ///   把整条运行判失败，用户会去查一个根本没出问题的流程
    fn collect_final_artifacts(
        &self,
        node: &GraphNode,
        sink: &EventSink<'_>,
    ) -> Result<NodeOutcome> {
        let declared = node
            .config
            .get("artifacts")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for rel in declared {
            let rel = rel.trim();
            if rel.is_empty() {
                continue;
            }
            let Some(path) = self.resolve_in_workdir(rel) else {
                sink(NodeEvent {
                    kind: "artifact.rejected",
                    node_id: node.id.clone(),
                    summary: format!("产物 {rel} 指向工作目录之外，没有收集"),
                    payload_ref: None,
                });
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else {
                sink(NodeEvent {
                    kind: "artifact.missing",
                    node_id: node.id.clone(),
                    summary: format!(
                        "声明的最终产物 {rel} 没找到 —— 上游节点没写出来，或者文件名不对"
                    ),
                    payload_ref: None,
                });
                continue;
            };
            // 名字只取最后一段：产物列表按 name 找（界面找的是
            // `report.json`），带上目录会让它对不上
            let name = std::path::Path::new(rel)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(rel);
            match self
                .artifacts
                .save(&self.run_id, &node.id, ArtifactKind::Report, name, &bytes)
            {
                Ok(saved) => sink(NodeEvent {
                    kind: "artifact.created",
                    node_id: node.id.clone(),
                    summary: format!("最终产物 {name} · {} 字节", saved.bytes),
                    payload_ref: Some(format!("{}/{name}", node.id)),
                }),
                Err(error) => sink(NodeEvent {
                    kind: "artifact.rejected",
                    node_id: node.id.clone(),
                    summary: format!("最终产物 {name} 存不下：{error}"),
                    payload_ref: None,
                }),
            }
        }

        Ok(NodeOutcome::Succeeded {
            port: "success".to_string(),
        })
    }

    /// 把一个相对路径解析到工作目录内。逃出去的返回 `None`。
    ///
    /// 与 `ArtifactStore::read` 同一个判据：先显式拒 `/` 开头与 `..` 段，
    /// 再逐段拼。一次性 join 的话 `PathBuf` 会把 `..` 当成上级目录
    /// 直接处理掉，而那正是要挡的。
    /// 不在工作目录内时返回 `None`；在的话返回路径，**文件存不存在不管**。
    ///
    /// 「逃出工作目录」和「文件没写出来」必须分开报。合在一起的话，
    /// 用户只是把文件名打错，收到的却是一句「指向工作目录之外」——
    /// 他会去查权限、查路径，而真正的原因是上游节点根本没生成那个文件。
    fn resolve_in_workdir(&self, rel: &str) -> Option<std::path::PathBuf> {
        if rel.starts_with('/') || rel.split('/').any(|seg| seg == "..") {
            return None;
        }
        let mut path = self.workdir.clone();
        for segment in rel.split('/') {
            if segment.is_empty() || segment == "." {
                continue;
            }
            path.push(segment);
        }
        // 路径字符串本身可以完全正常 —— 软链要 canonicalize 才看得出。
        // 文件不存在时 canonicalize 会失败，那不是「逃逸」，交给调用方按
        // 「没找到」处理
        match (path.canonicalize(), self.workdir.canonicalize()) {
            (Ok(real), Ok(root)) if !real.starts_with(&root) => None,
            _ => Some(path),
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
    fn save_output(
        &self,
        node_id: &str,
        name: &str,
        content: &str,
        sink: &EventSink<'_>,
    ) -> Option<String> {
        if content.is_empty() {
            return None;
        }
        let saved = self
            .artifacts
            .save(
                &self.run_id,
                node_id,
                ArtifactKind::Log,
                name,
                content.as_bytes(),
            )
            .ok()?;
        let rel = format!("{node_id}/{name}");
        // 落盘成功即发 —— 「产物视图」的投影以它为源（B-2）。
        // 发在引用它的事件之前：产物先存在，再被指向
        sink(NodeEvent {
            kind: "artifact.created",
            node_id: node_id.to_string(),
            summary: format!("产物 {rel} · {} 字节", saved.bytes),
            payload_ref: Some(rel.clone()),
        });
        Some(rel)
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

        // 分析 / 审查对象拼在指令**前面**。
        //
        // `target` 是契约里 `ai.analyze` / `ai.review` 的**必填**字段
        // （「分析对象」/「审查对象」），而这里曾经根本不读它 ——
        // 内置模板用 `target: "${read_issue.success}"` 把 issue 正文交给分析师，
        // agent 收到的却只有角色和记忆，于是回一句
        // 「请提供要分析的具体问题和现有证据」。界面能填、能存、能校验，
        // 引擎不读，这比直接报错更糟：没有任何一处会告诉用户它没生效。
        //
        // 材料在前、指令在后：issue 正文可能有几千字，把指令压在它下面的话，
        // 「这一次要干什么」就被推到很远的地方去了 —— 而下面那段注释
        // （「指令留在最后」）说的正是同一件事。带个抬头是为了让模型
        // 分得清哪些是给它的指令、哪些是要它处理的材料。
        let instruction = match node
            .config
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            // ai.decide / ai.execute 的契约里没有这个字段，缺了很正常
            None => instruction,
            Some(raw) => {
                // 不解析就发出去的话，agent 看到的是 `${read_issue.success}`
                // 这串字面量，会把它当成一个真实存在的东西去理解
                let target = match interpolate(raw, scope) {
                    Ok(text) => text,
                    Err(error) => {
                        return Ok(NodeOutcome::Failed {
                            message: error.to_string(),
                        });
                    }
                };
                format!("要处理的对象：\n{target}\n\n{instruction}")
            }
        };

        // 提示词库（B-3）：节点指定了 promptId 就用库里那份做框架，
        // 替掉下面由角色拼出来的内建框架；查不到是硬错误 ——
        // 静默退回内建的话，用户挑的那份一个字都没到模型面前。
        let library_prompt = match node
            .config
            .get("promptId")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            None => None,
            Some(id) => match self.prompts.iter().find(|entry| entry.id == id) {
                Some(entry) => Some(entry.clone()),
                None => {
                    return Ok(NodeOutcome::Failed {
                        message: format!(
                            "找不到提示词 {id}。在「提示词库」页确认它还在，\
                             或清空节点的「提示词」字段改用内建框架"
                        ),
                    });
                }
            },
        };

        // 「这次用了哪份提示词的哪一版」在拉起 adapter 之前就写下 ——
        // 出口标准「提示词与模型在运行记录中可追溯到具体版本」的
        // 提示词那一半（模型那一半是 system.model_resolved）
        sink(NodeEvent {
            kind: "system.prompt_resolved",
            node_id: node.id.clone(),
            summary: match &library_prompt {
                Some(entry) => {
                    format!("提示词：库「{}」v{}（{}）", entry.name, entry.ver, entry.id)
                }
                None => "提示词：内建框架（角色 + 记忆 + 指令）".to_string(),
            },
            payload_ref: None,
        });

        let instruction = if let Some(entry) = &library_prompt {
            let mut prompt = String::new();
            for (title, body) in &entry.sections {
                if body.trim().is_empty() {
                    continue;
                }
                // 分段过插值:变量 tab 里声明的 ${…} 要换成真实内容 ——
                // 原样发出去的话模型收到的是一串它无法理解的字面量
                // (第 4 轮实测 #4)。解析不了与指令同一待遇:明确失败
                let body = match interpolate(body, scope) {
                    Ok(text) => text,
                    Err(error) => {
                        return Ok(NodeOutcome::Failed {
                            message: format!(
                                "提示词「{}」的分段「{title}」解析失败:{error}",
                                entry.name
                            ),
                        });
                    }
                };
                prompt.push_str(&format!("【{title}】\n{body}\n\n"));
            }
            // 角色的能力边界仍然要带上 —— 它是角色页上逐项设的声明，
            // 不随提示词框架走
            if let Some(note) = self.capability_note(node) {
                prompt.push_str(&note);
                prompt.push('\n');
                prompt.push('\n');
            }
            prompt.push_str(&instruction);
            prompt
        } else {
            // 内建框架：角色拼在最前面，节点的指令留在最后。
            //
            // 顺序是有讲究的：角色说的是「你是谁、你怎么做事、交出什么形状」，
            // 那是**这一整类任务**都成立的；指令是「这一次要干什么」。
            // 把指令埋在中间的话，多轮下来模型容易把它当成背景说明。
            match profile {
                None => instruction,
                Some(profile) => {
                    let mut prompt = String::new();
                    if !profile.role.is_empty() || !profile.name.is_empty() {
                        prompt
                            .push_str(&format!("你的角色：{}（{}）\n", profile.name, profile.role));
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
                    // 角色声明的边界写进提示词。
                    //
                    // 引擎不再逐项强制它（权限由流程管，见 risk.rs 头部）——
                    // 但那不等于这几个字段可以不生效。**填了不生效比报错更糟**：
                    // 用户在角色页上逐项设过它们，一个字都没到过模型面前的话，
                    // 那一屏就是装饰
                    if let Some(note) = self.capability_note(node) {
                        prompt.push_str(&note);
                        prompt.push('\n');
                    }
                    if !prompt.is_empty() {
                        prompt.push('\n');
                    }
                    prompt.push_str(&instruction);
                    prompt
                }
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

        // adapter 没装是最常见的一种失败，那句「装什么」要留着 ——
        // open_session 只会说「没有安装」，说不出这个仓库该敲哪条命令
        if self.acp_override.is_none() {
            match adapter_command(runtime) {
                Some((command, _)) if adapter_installed(runtime).is_none() => {
                    return Ok(NodeOutcome::Failed {
                        message: format!(
                            "{runtime} 的 adapter（{command}）没有安装。\
                             装上它才能跑 AI 节点：pnpm --filter @aiwf/acp-sidecar add {command}"
                        ),
                    });
                }
                None => {
                    return Ok(NodeOutcome::Failed {
                        message: format!("不认识的 runtime {runtime}"),
                    });
                }
                Some(_) => {}
            }
        }

        // 超时：节点上写了就听节点的（那是针对这一步调的），
        // 否则用角色的 —— 执行者跑得久，审查者不该等那么长
        let timeout_ms = node
            .config
            .get("timeoutMs")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| profile.and_then(|p| u64::try_from(p.timeout_ms).ok()))
            .unwrap_or(900_000);

        // 节点的 modelPolicy 与角色的 model_ref 在这里生效。
        // 解析期的每一次「要的给不了」先说出来 —— adapter 拒掉的那种
        // 降级在 open_session 之后另有一段，两种都不静默
        let model_choice = self.resolve_model(node);
        for message in &model_choice.downgraded {
            sink(NodeEvent {
                kind: "system.model_downgraded",
                node_id: node.id.clone(),
                summary: message.clone(),
                payload_ref: None,
            });
        }

        // 发出去的提示词进对话流 —— 那是「往返」的另一半。
        //
        // 挪在 open_session **之前**：连不上 adapter 的那次失败,
        // 「本来要问什么」也该有记录 —— 排查连接问题时它就是现场。
        //
        // 只记 agent 的回答不叫往返：用户看到一个出乎意料的结论时，
        // 第一个要问的是「我们到底问了它什么」，而那份提示词里拼着
        // 角色的人设、注入的记忆、上游节点的输出，都不是他手写的。
        sink(NodeEvent {
            kind: "conversation.user_message",
            node_id: node.id.clone(),
            summary: summarize(&instruction),
            payload_ref: self.save_output(&node.id, "prompt.md", &instruction, sink),
        });

        // 与审批者、主管 AI、连通性测试同一个入口。
        //
        // **MCP 从这里接上**：原先 AI 节点走的是不带 MCP 的 `new_session`，
        // 于是工作流里的 agent 读不到工作流、改不动草稿、看不到自己上一步
        // 跑出了什么 —— 而主管 AI 一直是接着的。同一个应用里两种 AI
        // 看到的系统不一样，这件事没有任何地方写着。
        let opened = match crate::acp::open_session(&crate::acp::SessionSpec {
            runtime: runtime.to_string(),
            cwd: agent_cwd.clone(),
            // 节点级解析优先，with_model 的运行级设置兜底
            model: model_choice.model.or_else(|| self.model.clone()),
            effort: model_choice.effort.or_else(|| self.effort.clone()),
            mode: None,
            mcp: self.mcp.clone(),
            timeout: Duration::from_millis(timeout_ms),
            adapter_override: self.acp_override.clone(),
        }) {
            Ok(opened) => opened,
            Err(error) => {
                return Ok(NodeOutcome::Failed {
                    message: format!("连不上 adapter：{error}"),
                });
            }
        };

        let crate::acp::OpenedSession {
            mut client,
            session,
            downgraded,
        } = opened;

        // 降级进事件流。
        //
        // 「降级发生时会写入 RunEvent，不会静默替换模型」写在
        // `AgentsPage.tsx` 上，而 `system.model_downgraded` 至今零发射 ——
        // 那句话一直是假的。这是它第一次成真。
        for down in &downgraded {
            sink(NodeEvent {
                kind: "system.model_downgraded",
                node_id: node.id.clone(),
                summary: down.to_string(),
                payload_ref: None,
            });
        }

        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls = 0_u32;
        // 工具调用的标题只在首帧里。更新帧只带 id 与状态 ——
        // 不记住的话，完成事件是一条「（completed）」，说不出完成的是哪一次
        let mut tool_titles: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // 实时帧的攒帧缓冲。**与事件流是两回事**：事件落库、是事实来源；
        // 帧不落库、是「正在发生」的投影。不推的话，一个跑五分钟的 AI 节点
        // 在运行面板上只有几条工具调用在动，而它说的话要等节点结束才一次性出现
        let mut pending = String::new();
        let mut last_push = std::time::Instant::now();
        let emit_chunk = |chunk: crate::acp::StreamChunk| {
            if let Some(s) = &self.stream {
                s.push(&chunk);
            }
        };

        let outcome = client.prompt(&session.id, &instruction, |update| match update {
            SessionUpdate::AgentText { text: chunk } => {
                text.push_str(chunk);
                pending.push_str(chunk);
                if last_push.elapsed() >= crate::acp::STREAM_WINDOW {
                    emit_chunk(crate::acp::StreamChunk::Text {
                        text: std::mem::take(&mut pending),
                        node_id: Some(node.id.clone()),
                        run_id: Some(self.run_id.clone()),
                    });
                    last_push = std::time::Instant::now();
                }
            }
            SessionUpdate::Reasoning { text: chunk } => {
                reasoning.push_str(chunk);
                emit_chunk(crate::acp::StreamChunk::Reasoning {
                    text: chunk.to_string(),
                    node_id: Some(node.id.clone()),
                    run_id: Some(self.run_id.clone()),
                });
            }
            // 工具调用**逐个**发，不攒一个总数：图纸的对话视图里是
            // 「工具活动 · 6 次读取，2 次搜索」，那需要知道每次调的是什么。
            // 而且它们边跑边出现 —— AI 节点要好几分钟，这期间
            // 用户唯一能看到的「它还活着」就是这些
            SessionUpdate::ToolCall { id, title, status } => {
                // 首帧带标题就记下；更新帧拿它补上
                let title = if title.is_empty() {
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
                // 工具调用不攒帧：它本来就稀疏，而「它正在读文件」是
                // 一个跑几分钟的节点里唯一能回答「还活着吗」的东西
                emit_chunk(crate::acp::StreamChunk::ToolCall {
                    title: title.clone(),
                    status: status.to_string(),
                    node_id: Some(node.id.clone()),
                    run_id: Some(self.run_id.clone()),
                });
                sink(NodeEvent {
                    kind,
                    node_id: node.id.clone(),
                    summary: if title.is_empty() {
                        format!("工具调用 {id}（{status}）")
                    } else {
                        format!("{title}（{status}）")
                    },
                    payload_ref: None,
                });
            }
            SessionUpdate::Other { .. } => {}
        });

        // **把攒在窗口里的最后一段推出去。**
        //
        // 不 flush 的话，不足一个窗口的尾巴永远推不出去 —— 而一个
        // 50ms 内说完的短回答会**完全没有流式**：界面上一直是「正在想…」，
        // 直到节点结束才一次性出现整段。测试就是这么抓到的。
        if !pending.is_empty() {
            emit_chunk(crate::acp::StreamChunk::Text {
                text: std::mem::take(&mut pending),
                node_id: Some(node.id.clone()),
                run_id: Some(self.run_id.clone()),
            });
        }

        match outcome {
            // 模型明确拒答。带着这半句话往下走的话，`ai.review` / `ai.decide`
            // 的下游会按端口分支继续跑审查、分级、审批 ——
            // 而它们手上是一段没有内容的话。用户唯一能看出异常的
            // 是回答短得离谱
            Ok(crate::acp::PromptOutcome::Refusal) => {
                let said = summarize(&text);
                Ok(NodeOutcome::Failed {
                    message: if said.trim().is_empty() {
                        "模型拒绝了这一轮，没有给出理由。换个说法或者调整角色的约束再试".to_string()
                    } else {
                        format!("模型拒绝了这一轮：{said}")
                    },
                })
            }
            Ok(stop) => {
                // 「回答」其实是 adapter 吐回来的上游报错 —— 节点必须失败，
                // 不能让下游把一段 502 当成分析结果继续加工（第 3 轮实测）
                if let Some(error_text) = adapter_error_in_answer(&text) {
                    return Ok(NodeOutcome::Failed {
                        message: format!(
                            "模型服务报错，这一轮没有产出：{}。\
                             检查「模型」页的连通性测试，或稍后重试",
                            summarize(&error_text)
                        ),
                    });
                }

                // 回答落产物：几十 KB 的分析不该进事件表
                let answer_ref = self.save_output(&node.id, "agent.md", &text, sink);
                let reasoning_ref = if reasoning.is_empty() {
                    None
                } else {
                    self.save_output(&node.id, "reasoning.md", &reasoning, sink)
                };

                // 推理在回答之前发：它是「怎么想的」，读起来在结论之前
                if !reasoning.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "reasoning.summary",
                        node_id: node.id.clone(),
                        summary: summarize(&reasoning),
                        payload_ref: reasoning_ref,
                    });
                }
                if !text.trim().is_empty() {
                    sink(NodeEvent {
                        kind: "conversation.agent_message",
                        node_id: node.id.clone(),
                        summary: summarize(&text),
                        payload_ref: answer_ref,
                    });
                }

                // 撞上 token 上限时那半句话是**有用的**，不该丢掉让整个节点失败。
                // 但下游必须知道它不完整 —— 一份被砍掉一半的方案清单
                // 看起来和一份完整的没有区别。
                //
                // 正常结束不发这条：每轮都说一句「这轮怎么结束的」是噪声，
                // 会把真正异常的那条淹掉
                if stop == crate::acp::PromptOutcome::MaxTokens {
                    sink(NodeEvent {
                        kind: "system.output_truncated",
                        node_id: node.id.clone(),
                        summary: "回答在 token 上限处被截断，这份结果是不完整的。\
                                  下游拿到的只是前半部分 —— 缩小一次要处理的范围，\
                                  或者在「模型」页换一个上下文更大的"
                            .to_string(),
                        payload_ref: None,
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

                // 它到底动了什么。
                //
                // 「完成 · 走 success 分支」只说明 Agent 把话说完了。
                // 真实 Issue 上跑出过一次「完成」而工作区一个字节没变 ——
                // 那件事一直到三个节点之后 git push 才暴露，中间的审查、
                // 分级、人工审批全在评审一份空改动。
                //
                // 所以把改动本身发成事件：不判成败（不改文件有时是对的），
                // 只让「什么都没做」当场看得见。
                let changes = workspace_changes(Path::new(&agent_cwd));
                if let Some(changes) = &changes {
                    sink(NodeEvent {
                        kind: "node.output_emitted",
                        node_id: node.id.clone(),
                        summary: changes.summary.clone(),
                        payload_ref: None,
                    });
                }

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
                        // 下游能引用：`${fix.success.changedFiles}`
                        "changedFiles": changes
                            .as_ref()
                            .map(|c| c.files.clone())
                            .unwrap_or_default(),
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

/// AI 执行节点在工作区里留下的改动。
#[derive(Debug, Clone)]
pub struct WorkspaceChanges {
    /// 动过的文件（含未跟踪的新文件），相对工作区根目录。
    pub files: Vec<String>,
    /// 一句话结论，直接进事件摘要。
    pub summary: String,
}

impl WorkspaceChanges {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// 这个目录里有哪些改动。不是 git 仓库就返回 `None`。
///
/// 为什么要有这个：`ai.execute` 报「完成」只说明 Agent 把话说完了，
/// 不说明它动过任何东西。端到端跑真实 Issue 时就出现过一次
/// 「完成 · 走 success 分支」而工作区一个字节没变 —— 那件事一直到
/// 三个节点之后 `git push` 才暴露，中间的审查、分级、人工审批
/// 全在评审一份空改动。
///
/// **不拿它判成败**：不改文件有时候是对的（分析型的执行、幂等的重跑）。
/// 它的作用是让「什么都没做」当场看得见，而不是留到下游炸。
///
/// 不是 git 仓库时返回 `None` 而不是「0 个文件」：`workdirSource` 为
/// inherit / declared 的节点可能跑在任意目录里，那时根本没有「改了什么」
/// 可谈，编一个 0 出来是拿假证据冒充真证据。
#[must_use]
pub fn workspace_changes(dir: &Path) -> Option<WorkspaceChanges> {
    // `--porcelain` 一行一个文件，格式稳定（专门给程序读的）；
    // `-uall` 让新建目录里的文件逐个列出，而不是折成一个目录名
    // `core.quotePath=false`：默认会把非 ASCII 路径转义成八进制
    // （`新的.rs` → `\346\226\260…`），事件摘要里就成了一串乱码
    let output = crate::tooling::command("git")
        .args([
            "-c",
            "core.quotePath=false",
            "status",
            "--porcelain",
            "-uall",
        ])
        .current_dir(dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let files: Vec<String> = text
        .lines()
        .filter_map(|line| line.get(3..))
        .map(|path| {
            // 重命名是 `旧 -> 新`，记新的那个：下游要看的是现在有什么
            path.split_once(" -> ")
                .map_or(path, |(_, new)| new)
                .trim_matches('"')
                .to_string()
        })
        .filter(|path| !path.is_empty())
        .collect();

    let summary = if files.is_empty() {
        "没有改动任何文件".to_string()
    } else {
        const MAX: usize = 5;
        let head = files
            .iter()
            .take(MAX)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("、");
        if files.len() > MAX {
            format!(
                "改了 {} 个文件：{head}（另有 {} 个）",
                files.len(),
                files.len() - MAX
            )
        } else {
            format!("改了 {} 个文件：{head}", files.len())
        }
    };

    Some(WorkspaceChanges { files, summary })
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
