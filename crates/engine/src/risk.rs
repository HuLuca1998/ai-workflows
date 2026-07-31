//! 审批：谁来批工作流里的那些门，以及这一步会造成什么。
//!
//! ## 权限由流程管，不由节点各自管
//!
//! 执行节点拿到的是**最高权限** —— 引擎不再按节点类型或脚本内容
//! 自动拦截。要不要停下来问，由工作流的形状决定：在
//! 「探索完成 → 开始编辑」之间、在「编码完成 → 开 PR」之间
//! 放一个 `approval` 节点，那两处就是关卡。
//!
//! 上一版按风险自动拦截，结果是**读一个 Issue 也要人点一次** ——
//! 用户的原话。而自动判定既拦不住 `PUSH="git push"; $PUSH`
//! （静态分析看不出来），又挡住了明明无害的操作。
//!
//! **这条的代价必须说清楚**：一条没放 `approval` 节点的工作流
//! 会一路跑到底，包括 push 与建 PR。
//!
//! ## 风险等级还留着，但换了用途
//!
//! [`node_risk`] 不再决定拦不拦，它决定**审批界面上怎么说** ——
//! 批的那个人（或那个 AI）要知道放行之后会发生什么。
//! 判低了的后果从「门开了」变成「说明不准”，仍然不该判低，
//! 但不再是安全边界。

use serde_json::Value;

use crate::catalog;
use crate::graph::GraphNode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    ReadOnly,
    WorkspaceWrite,
    ExternalWrite,
}

impl RiskLevel {
    fn from_contract(value: &str) -> Self {
        match value {
            "read_only" => Self::ReadOnly,
            "workspace_write" => Self::WorkspaceWrite,
            // 认不出的按最高。生成物里出现新值时走这里
            _ => Self::ExternalWrite,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecider {
    Ai,
    Human,
}

/// 一道审批门由谁批。
///
/// 两个输入：全局档位（用户当下想被打扰多少）与节点上写的
/// （工作流作者的意图）。**全局档位覆盖节点** —— 那是设置页
/// 那三张卡的意义所在。
///
/// 与 `packages/contracts/src/approval.ts` 的 `approvalDecider`
/// **逐格等价**。两份实现的代价由 `contract_sync_test` 对冲。
///
/// 注意**没有「不用批」这一档**：审批节点是工作流作者显式放下的一道门，
/// 让某个档位把它整个跳过，等于让设置页悄悄改写工作流的形状。
#[must_use]
pub fn approval_decider(mode: &str, node_decider: &str) -> ApprovalDecider {
    match mode {
        // 全都我来 —— 节点上写的 ai 也不作数
        "human_approval" => ApprovalDecider::Human,
        // 全交给 AI —— 节点上写的 user 也不作数，否则它不叫无人值守
        "unattended" => ApprovalDecider::Ai,
        // 节点说了算；没说（auto）时默认 AI
        "ai_assisted" => {
            if node_decider == "user" {
                ApprovalDecider::Human
            } else {
                ApprovalDecider::Ai
            }
        }
        // 认不出的档位回到人 —— 库里可能躺着上一版的值。
        // 静默交给 AI 的话，用户以为自己设了一道要亲自批的门
        _ => ApprovalDecider::Human,
    }
}

/// 上一版三档 → 新三档。
///
/// 与 `packages/contracts/src/capabilities.ts` 的 `migrateApprovalMode` 等价。
///
/// **在读取处映射，不改库**：改了库之后用户装回旧版就读不出来了，
/// 而回退是内部分发最常发生的事。
///
/// 不迁移的后果不是「更安全」而是「更难用」：一个原本选了
/// `trusted_workflow`（全放行）的用户升级后，每一步都被拦下来，
/// 而他没改过任何设置 —— 他会以为应用坏了。
#[must_use]
pub fn migrate_approval_mode(value: &str) -> &str {
    match value {
        "human_approval" | "ai_assisted" | "unattended" => value,
        "workspace_safe" => "ai_assisted",
        "trusted_workflow" => "unattended",
        // review_every_change 与一切认不出的值都回到最严那档
        _ => "human_approval",
    }
}

/// 节点类型的基线风险，取自契约生成物。
///
/// **未登记的类型按外部写算**：契约加了新节点而生成物没重新生成时走这里。
/// 默认只读的话，新节点会带着「三档全放行」上线，而没有任何东西会红。
#[must_use]
pub fn base_risk(node_type: &str) -> RiskLevel {
    catalog::definition(node_type)
        .map(|entry| RiskLevel::from_contract(&entry.base_risk))
        .unwrap_or(RiskLevel::ExternalWrite)
}

/// 一个节点的实际风险。
///
/// 只有 **shell 脚本**做内容嗅探，其余类型一律用基线。
///
/// AI 节点不嗅探是因为 `instruction` 里出现「别 git push」不该改变判定 ——
/// 那是给 agent 看的话，不是要执行的命令。`script.python` 不嗅探是因为
/// 这里没有 Python 的解析，猜不出 `subprocess.run` 里装着什么。
///
/// ## 为什么 shell 脚本可以**降到基线以下**
///
/// `script.shell` 的基线是 `WorkspaceWrite`，而 `gh issue view` 这样的
/// 一行只读命令会被判成 `ReadOnly` —— 比基线低。这不是漏洞：
/// 降级的判据是**整段脚本的每一条命令都在只读白名单里，且没有重定向、
/// 没有看不透的命令替换**。白名单本身就是那道防线。
///
/// 换句话说，基线在这里的含义是「嗅探不出结论时用它」，不是下限。
/// 若改成取 `max(基线, 嗅探)`，最严档下读一个 Issue 也要人点一次 ——
/// 那正是这次要修的东西。
#[must_use]
pub fn node_risk(node: &GraphNode) -> RiskLevel {
    let 基线 = base_risk(&node.node_type);

    if node.node_type != "script.shell" {
        return 基线;
    }

    let Some(Value::String(script)) = node.config.get("script") else {
        // 脚本节点没有脚本 —— 配置坏了。按基线算，执行时自会报错
        return 基线;
    };

    script_risk(script)
}

/// 一段 shell 脚本的风险。
///
/// 判的是**插值之前**的原文。这样安全，因为 `interp::shell_quote`
/// 把插进来的值整个包进单引号 —— 值里的 `;`、`$()`、反引号全部失去
/// 特殊含义，插值改不了命令的结构。
#[must_use]
pub fn script_risk(script: &str) -> RiskLevel {
    // 命令替换里的东西也会被执行。先把它们抠出来单独判，
    // 只看外层第一个词的话，`echo $(git push)` 会被当成 echo
    let (剩余, 替换内容) = 抽出命令替换(script);

    let mut 风险 = RiskLevel::ReadOnly;
    for 片段 in 替换内容 {
        风险 = 风险.max(script_risk(&片段));
        if 风险 == RiskLevel::ExternalWrite {
            return 风险;
        }
    }

    // 重定向就是写文件，左边是什么都不重要。
    // `2>&1` / `>&2` 这类重定向到 fd 的写法先摘掉 —— 它们不写文件，
    // 而 `git log 2>&1` 是常见的只读写法，不该因此被拦
    let 去掉fd重定向 = 剩余
        .replace("2>&1", " ")
        .replace("1>&2", " ")
        .replace(">&2", " ")
        .replace(">&1", " ");
    let 有重定向 = 去掉fd重定向.contains('>');

    for 片段 in 切成命令(&去掉fd重定向) {
        let 词: Vec<&str> = 片段.split_whitespace().collect();
        let 词 = 跳过环境变量赋值(&词);
        if 词.is_empty() {
            continue;
        }

        if 是外部写(词) {
            return RiskLevel::ExternalWrite;
        }
        if !是只读命令(词) {
            风险 = 风险.max(RiskLevel::WorkspaceWrite);
        }
    }

    if 有重定向 {
        风险 = 风险.max(RiskLevel::WorkspaceWrite);
    }
    风险
}

/// `$(...)` 与反引号里的内容。返回（挖掉替换后的剩余文本，各段替换内容）。
fn 抽出命令替换(script: &str) -> (String, Vec<String>) {
    let mut 剩余 = String::with_capacity(script.len());
    let mut 内容 = Vec::new();
    let mut 迭代 = script.char_indices().peekable();

    while let Some((位置, ch)) = 迭代.next() {
        // $( ... ) —— 只处理不嵌套的一层。嵌套的那层会留在内容里，
        // 递归 script_risk 时再被抠出来
        if ch == '$' && 迭代.peek().map(|(_, c)| *c) == Some('(') {
            迭代.next();
            let 开始 = 位置 + 2;
            let mut 深度 = 1usize;
            let mut 结束 = 开始;
            for (i, c) in 迭代.by_ref() {
                结束 = i;
                if c == '(' {
                    深度 += 1;
                } else if c == ')' {
                    深度 -= 1;
                    if 深度 == 0 {
                        break;
                    }
                }
            }
            内容.push(script[开始..结束.max(开始)].to_string());
            // 挖掉的地方补个空格，免得左右两个词粘成一个
            剩余.push(' ');
            continue;
        }

        if ch == '`' {
            let 开始 = 位置 + 1;
            let mut 结束 = 开始;
            for (i, c) in 迭代.by_ref() {
                结束 = i;
                if c == '`' {
                    break;
                }
            }
            内容.push(script[开始..结束.max(开始)].to_string());
            剩余.push(' ');
            continue;
        }

        剩余.push(ch);
    }

    (剩余, 内容)
}

/// 按 shell 的命令分隔符切开。
///
/// 引号里的分隔符也会被切 —— 那是**保守**方向：切多了只会让某个片段
/// 落到白名单外，判成 `WorkspaceWrite`，多问一次而已。
fn 切成命令(script: &str) -> Vec<String> {
    let 规整 = script
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace(['|', ';', '&', '\n'], "\n");
    规整
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

/// 跳过 `FOO=bar cmd` 前面那串赋值。
///
/// 全是赋值时返回空 —— 一行 `ISSUE=123` 不执行任何东西。
fn 跳过环境变量赋值<'a>(词: &'a [&'a str]) -> &'a [&'a str] {
    let mut i = 0;
    while i < 词.len() {
        let w = 词[i];
        // `a=b` 形式，且等号不在开头（`=x` 不是赋值）
        match w.find('=') {
            Some(位置) if 位置 > 0 && !w.starts_with('-') => i += 1,
            _ => break,
        }
    }
    &词[i..]
}

/// 会写到这台机器之外的命令。
///
/// 前缀匹配：模式是命令词序列的前缀就算命中。
/// 这份清单**不可能完备** —— 它的作用是把最常见的那几种识别出来，
/// 兜底的是「认不出的按 WorkspaceWrite 算，而那一档在最严模式下同样挂人工」。
const 外部写模式: &[&[&str]] = &[
    &["git", "push"],
    // 拉取会改本地，但不写远端 —— 不在这里
    &["gh", "pr", "create"],
    &["gh", "pr", "merge"],
    &["gh", "pr", "close"],
    &["gh", "pr", "edit"],
    &["gh", "pr", "comment"],
    &["gh", "pr", "review"],
    &["gh", "pr", "ready"],
    &["gh", "issue", "create"],
    &["gh", "issue", "close"],
    &["gh", "issue", "edit"],
    &["gh", "issue", "comment"],
    &["gh", "issue", "reopen"],
    &["gh", "release", "create"],
    &["gh", "release", "upload"],
    &["gh", "release", "delete"],
    &["gh", "repo", "create"],
    &["gh", "repo", "delete"],
    &["gh", "repo", "fork"],
    &["gh", "repo", "rename"],
    &["gh", "secret", "set"],
    &["gh", "workflow", "run"],
    &["gh", "gist", "create"],
    &["npm", "publish"],
    &["pnpm", "publish"],
    &["yarn", "publish"],
    &["cargo", "publish"],
    &["docker", "push"],
    &["kubectl", "apply"],
    &["kubectl", "delete"],
    &["kubectl", "create"],
    &["terraform", "apply"],
    &["terraform", "destroy"],
    &["scp"],
    &["rsync"],
    &["ssh"],
];

/// HTTP 客户端带上写方法或请求体时算外部写。
fn 是写请求(词: &[&str]) -> bool {
    let 客户端 = matches!(词.first(), Some(&"curl" | &"wget" | &"http" | &"gh"));
    if !客户端 {
        return false;
    }

    let mut i = 1;
    while i < 词.len() {
        let w = 词[i];
        // -X POST / --request PUT / --method DELETE
        if matches!(w, "-X" | "--request" | "--method" | "-f") {
            if let Some(方法) = 词.get(i + 1) {
                let 方法 = 方法.trim_matches(['"', '\'']).to_ascii_uppercase();
                if matches!(方法.as_str(), "POST" | "PUT" | "PATCH" | "DELETE") {
                    return true;
                }
            }
        }
        // -XPOST 连写
        if let Some(方法) = w.strip_prefix("-X") {
            if matches!(
                方法.to_ascii_uppercase().as_str(),
                "POST" | "PUT" | "PATCH" | "DELETE"
            ) {
                return true;
            }
        }
        // 带请求体的一律算写 —— GET 带 body 不是正常用法
        if matches!(w, "-d" | "--data" | "--data-raw" | "--data-binary" | "-F" | "--form") {
            return true;
        }
        i += 1;
    }
    false
}

fn 是外部写(词: &[&str]) -> bool {
    if 是写请求(词) {
        return true;
    }
    外部写模式.iter().any(|模式| {
        模式.len() <= 词.len() && 模式.iter().zip(词.iter()).all(|(m, w)| m == w)
    })
}

/// 只读命令白名单。
///
/// **只有整段脚本的每一条命令都在这里，才降到 `ReadOnly`。**
/// 加一条进来之前先问：它有没有一个参数能让它写东西？
/// `sed` 有 `-i`、`find` 有 `-exec`、`gh api` 有 `-X POST`、
/// `tee` 天生就写 —— 这几个都因此被排除在外。
const 只读命令: &[&[&str]] = &[
    &["git", "log"],
    &["git", "show"],
    &["git", "diff"],
    &["git", "status"],
    &["git", "rev-parse"],
    &["git", "describe"],
    &["git", "ls-files"],
    &["git", "ls-remote"],
    &["git", "blame"],
    &["git", "cat-file"],
    &["git", "shortlog"],
    &["gh", "issue", "view"],
    &["gh", "issue", "list"],
    &["gh", "pr", "view"],
    &["gh", "pr", "list"],
    &["gh", "pr", "diff"],
    &["gh", "pr", "checks"],
    &["gh", "repo", "view"],
    &["gh", "run", "view"],
    &["gh", "run", "list"],
    &["cat"],
    &["head"],
    &["tail"],
    &["ls"],
    &["pwd"],
    &["echo"],
    &["printf"],
    &["wc"],
    &["grep"],
    &["egrep"],
    &["rg"],
    &["jq"],
    &["yq"],
    &["sort"],
    &["uniq"],
    &["cut"],
    &["column"],
    &["date"],
    &["basename"],
    &["dirname"],
    &["realpath"],
    &["which"],
    &["command", "-v"],
    &["true"],
    &["false"],
    &["file"],
    &["stat"],
    &["du"],
    &["df"],
];

fn 是只读命令(词: &[&str]) -> bool {
    只读命令.iter().any(|模式| {
        模式.len() <= 词.len() && 模式.iter().zip(词.iter()).all(|(m, w)| m == w)
    })
}
