//! 环境健康报告。
//!
//! 图纸「06 首次安装与检测」的产品原则写在头部：
//! 「我们不会静默修改系统。下面列出将要安装的内容、来源、版本与位置，
//! 确认后才执行；不使用 sudo，不改动 shell profile，
//! 也不把 App 工具写入全局 PATH。」
//!
//! 这个模块只管**检测**那一半，而且只读 —— 它没有任何能写的入口。

use serde::Serialize;

use crate::ApiResult;

/// 工具从哪来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    /// 系统自带或用户自己装的。
    System,
    /// 应用装在自己目录下的（不进全局 PATH）。
    AppManaged,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvStatus {
    Ready,
    NeedsAttention,
    /// 只有某类工作流需要 —— 缺了不影响整体状态。
    Optional,
    Missing,
}

/// 缺工具时给的一条可复制命令。
///
/// **应用自己不装任何东西**：不下载、不解压、不写 PATH。
/// 这不只是省事 —— 替用户执行下载与解压意味着要为
/// 「从哪下载、怎么校验签名、装坏了怎么回滚」全都做决定，
/// 而每个决定都是新的攻击面。给一行命令，用户自己看、自己跑。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHint {
    /// 复制得走的一行。**绝不含 sudo** —— 图纸的产品原则里就有这句，
    /// 而用户多半会照贴不误。
    pub command: String,
    /// 这条命令的出处，让用户能自己判断要不要跑。
    pub source: String,
    /// 可选：官方安装页，给不想用命令行的人。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHealthItem {
    pub capability: String,
    /// 面向用户的名字。capability 是 id，这个是显示用的。
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 它在哪 —— 用户要能自己确认，而不是只被告知「已就绪」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub source: EnvSource,
    pub status: EnvStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 缺了才给。已就绪还给的话，用户会以为「是不是该重装一下」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<InstallHint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHealthReport {
    /// 必需项是否都就绪。可选项缺失不影响它 ——
    /// 一个从不跑容器的用户不该永远看到「环境需要处理」。
    pub ready: bool,
    pub items: Vec<EnvHealthItem>,
}

struct Probe {
    capability: &'static str,
    label: &'static str,
    command: &'static str,
    version_arg: &'static str,
    optional: bool,
    detail: &'static str,
    /// 缺了怎么装：`(命令, 出处, 官方页)`。命令一律不含 sudo。
    install: (&'static str, &'static str, Option<&'static str>),
}

/// 一个目录能不能用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryCheck {
    /// 展开 `~` 之后的绝对路径。界面显示它 —— 用户要能确认自己选的是哪个。
    pub resolved: String,
    pub exists: bool,
    /// 探针文件写得进去吗。**这是唯一说得准的判据**。
    pub writable: bool,
    pub is_git_repo: bool,
    pub tcc_protected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// macOS 上要 TCC 授权才能访问的位置。
///
/// 现在写得进去不代表以后还行：ad-hoc 签名下 App 一更新，cdhash 变了，
/// 上一版拿到的授权就不再适用（docs/MACOS-PERMISSIONS.md）。
/// 界面要能提前说这句话，而不是等用户下次跑工作流时撞上 EPERM。
const TCC_PROTECTED_SUBDIRS: &[&str] = &[
    "Documents",
    "Desktop",
    "Downloads",
    "Movies",
    "Music",
    "Pictures",
];

/// 这个目录能不能用。
///
/// **必须是真探测**：写一个探针文件再删掉。`metadata` 说得出「存在」，
/// 说不出「你有没有权限往里写」—— 而 macOS 的 TCC 恰恰是后者
/// （目录在 `~/Documents` 下时，读得到、写不了，`exists` 照样是 true）。
///
/// 探针写完立刻删。留下一个 `.aiwf-probe` 的话，用户选中自己的仓库目录时
/// 会看到一个莫名其妙的文件，而 `git status` 会把它算成未跟踪改动。
pub fn check_directory(path: &str) -> ApiResult<DirectoryCheck> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        // 空串走 `PathBuf::from("")` 会变成当前目录 —— 于是「什么都没填」
        // 被当成「选了一个能用的目录」
        return Ok(DirectoryCheck {
            resolved: String::new(),
            exists: false,
            writable: false,
            is_git_repo: false,
            tcc_protected: false,
            message: Some("还没有选目录".to_string()),
        });
    }

    let expanded = expand_tilde(trimmed);
    let resolved = expanded.display().to_string();
    let exists = expanded.is_dir();
    let is_git_repo = expanded.join(".git").exists();
    let tcc_protected = in_tcc_protected(&expanded);

    if !exists {
        return Ok(DirectoryCheck {
            resolved,
            exists: false,
            writable: false,
            is_git_repo,
            tcc_protected,
            message: Some(format!("这个目录不存在：{}", expanded.display())),
        });
    }

    let (writable, message) = match probe(&expanded) {
        Ok(()) => (true, None),
        Err(reason) => (false, Some(reason)),
    };

    Ok(DirectoryCheck {
        resolved,
        exists,
        writable,
        is_git_repo,
        tcc_protected,
        message,
    })
}

/// 创建目录，然后按 `check_directory` 的方式重新探测。
///
/// 首次配置的死路：默认工作目录不存在时，探测只报「不存在」，
/// 应用里没有任何创建它的入口 ——「开始使用」永远灰着，
/// 用户只能去应用外面手动 mkdir。创建由用户点按钮显式触发，
/// 不违反「不静默修改系统」。
///
/// 返回值永远是「创建之后的真实探测结果」：创建调用没报错
/// 不等于写得进去（TCC 可能拦在写入那一步），所以不信任
/// `create_dir_all` 的 Ok，重新走一遍探针。
pub fn create_directory(path: &str) -> ApiResult<DirectoryCheck> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        // 与 check_directory 同一个坑：空串会变成当前目录
        return Ok(DirectoryCheck {
            resolved: String::new(),
            exists: false,
            writable: false,
            is_git_repo: false,
            tcc_protected: false,
            message: Some("还没有选目录".to_string()),
        });
    }

    let expanded = expand_tilde(trimmed);
    if let Err(error) = std::fs::create_dir_all(&expanded) {
        // 建不出来也走正常返回：这是用户要看的探测结论，不是内部错误
        return Ok(DirectoryCheck {
            resolved: expanded.display().to_string(),
            exists: expanded.is_dir(),
            writable: false,
            is_git_repo: false,
            tcc_protected: in_tcc_protected(&expanded),
            message: Some(match error.kind() {
                std::io::ErrorKind::PermissionDenied => format!(
                    "这个目录建不出来（权限被拒）。换一个位置，\
                     或到「系统设置 → 隐私与安全性」里授权：{}",
                    expanded.display()
                ),
                _ => format!("这个目录建不出来：{error}"),
            }),
        });
    }

    check_directory(trimmed)
}

/// 写一个探针文件再删掉。
fn probe(dir: &std::path::Path) -> std::result::Result<(), String> {
    // 名字带进程 id：两个实例同时探同一个目录时不会互相删掉对方的探针
    let probe = dir.join(format!(".aiwf-probe-{}", std::process::id()));
    let result = std::fs::write(&probe, b"aiwf");
    // 删除放在判断成败之前 —— 写成功了才有东西可删，
    // 而写失败时这一句是无害的
    let _ = std::fs::remove_file(&probe);

    result.map_err(|error| match error.kind() {
        std::io::ErrorKind::PermissionDenied => format!(
            "这个目录写不进去（权限被拒）。\
             如果它在「文稿」「桌面」「下载」里，到「系统设置 → 隐私与安全性 → 文件与文件夹」\
             里给 AI Workflows 授权；或者换一个目录：{}",
            dir.display()
        ),
        _ => format!("这个目录写不进去：{error}"),
    })
}

/// `~` 展开成主目录。
///
/// 界面上存的是 `~/Library/…` 这种可读形式（Web 形态拿不到 Tauri 的
/// path API），而判断要在真实路径上做。
fn expand_tilde(path: &str) -> std::path::PathBuf {
    let Some(rest) = path.strip_prefix('~') else {
        return std::path::PathBuf::from(path);
    };
    let Some(home) = std::env::var_os("HOME") else {
        return std::path::PathBuf::from(path);
    };
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() {
        std::path::PathBuf::from(home)
    } else {
        std::path::PathBuf::from(home).join(rest)
    }
}

fn in_tcc_protected(path: &std::path::Path) -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let home = std::path::PathBuf::from(home);
    TCC_PROTECTED_SUBDIRS
        .iter()
        .any(|name| path.starts_with(home.join(name)))
}

/// 要探测的工具，以及缺了怎么装。
///
/// 安装命令用各项目**官方推荐**的装法，并注明出处 ——
/// 「复制这行到终端」是让用户执行一段我们给的代码，
/// 至少要说清它是哪来的，好让他自己判断。
const PROBES: &[Probe] = &[
    Probe {
        capability: "git",
        label: "Git",
        command: "git",
        version_arg: "--version",
        optional: false,
        detail: "worktree 与 PR 都要它",
        install: (
            "xcode-select --install",
            "macOS 命令行工具（自带 git）",
            Some("https://git-scm.com/downloads"),
        ),
    },
    Probe {
        capability: "node",
        label: "Node.js",
        command: "node",
        version_arg: "--version",
        optional: false,
        detail: "ACP adapter 跑在它上面",
        install: (
            "brew install node@22",
            "Homebrew",
            Some("https://nodejs.org/en/download"),
        ),
    },
    Probe {
        capability: "python",
        label: "Python",
        command: "python3",
        version_arg: "--version",
        optional: true,
        detail: "只有 Python 脚本节点需要",
        install: (
            "curl -LsSf https://astral.sh/uv/install.sh | sh",
            "uv 官方安装脚本（astral.sh）",
            Some("https://docs.astral.sh/uv/getting-started/installation/"),
        ),
    },
    Probe {
        capability: "gh",
        label: "GitHub CLI",
        command: "gh",
        version_arg: "--version",
        optional: true,
        detail: "只有 GitHub 相关的工作流需要",
        install: (
            "brew install gh",
            "Homebrew",
            Some("https://cli.github.com"),
        ),
    },
    Probe {
        capability: "docker",
        label: "Docker / OrbStack",
        command: "docker",
        version_arg: "--version",
        optional: true,
        detail: "只有容器工作流需要",
        install: (
            "brew install --cask orbstack",
            "Homebrew Cask",
            Some("https://orbstack.dev"),
        ),
    },
];

/// 探测环境。
///
/// `recheck` 目前不影响行为 —— 没有缓存可跳过。留着这个参数是因为
/// 契约里有它：真正加缓存时不该再改一次契约。
pub fn env_health(_recheck: bool) -> ApiResult<EnvHealthReport> {
    let mut items: Vec<EnvHealthItem> = PROBES.iter().map(probe_tool).collect();

    // gh 单独再问一句「登录没有」。只跑 `gh --version` 的话，
    // 「装了但没登录」会报「已就绪」—— 而用户真正用到它时
    // （列仓库、建 PR）才发现用不了，那时的报错来自 gh，跟这一屏对不上。
    //
    // 用 `gh auth token` 而不是 `gh auth status`：前者只读本地 keyring，
    // 40ms；后者要一次网络往返（实测 770ms），而这一屏是打开设置就跑的，
    // 网络一慢它就跟着卡住
    if let Some(gh) = items
        .iter_mut()
        .find(|item| item.capability == "gh" && item.status == EnvStatus::Ready)
    {
        let (status, detail, install) = gh_login_state(gh_logged_in());
        gh.status = status;
        gh.detail = Some(detail);
        gh.install_hint = install.map(|command| InstallHint {
            command,
            source: "GitHub CLI 的登录流程".to_string(),
            url: Some("https://cli.github.com/manual/gh_auth_login".to_string()),
        });
    }

    // ACP adapter 单独探：它们不在 PATH 里，而是装在 sidecar 的 node_modules 下
    for (runtime, label) in [
        ("acp.claude", "Claude Code（ACP）"),
        ("acp.codex", "Codex（ACP）"),
    ] {
        items.push(probe_adapter(runtime, label));
    }

    let ready = items
        .iter()
        .filter(|item| item.status != EnvStatus::Optional)
        .all(|item| item.status == EnvStatus::Ready);

    Ok(EnvHealthReport { ready, items })
}

/// gh 登录了没 —— 读本地凭据，不联网。
fn gh_logged_in() -> bool {
    aiwf_engine::tooling::command("gh")
        .args(["auth", "token"])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// 由登录状态决定 gh 那一项怎么显示：`(状态, 说明, 安装命令)`。
///
/// 「没登录」**不算** NeedsAttention：那一档会让整体状态变成
/// 「环境需要处理」，而一个从不碰 GitHub 的用户不该因此被拦一下。
/// 它仍是可选档，只是把话说清楚。
#[must_use]
pub fn gh_login_state(logged_in: bool) -> (EnvStatus, String, Option<String>) {
    if logged_in {
        // 说出来，用户才知道我们真的验过 —— 而不只是看到一个绿点
        (EnvStatus::Ready, "已登录".to_string(), None)
    } else {
        (
            EnvStatus::Optional,
            "已装好，但还没登录 —— 列仓库、建 PR 这些都会失败".to_string(),
            Some("gh auth login".to_string()),
        )
    }
}

fn probe_tool(probe: &Probe) -> EnvHealthItem {
    let (command, source, url) = probe.install;

    let Some(path) = which(probe.command) else {
        return EnvHealthItem {
            capability: probe.capability.to_string(),
            label: probe.label.to_string(),
            version: None,
            path: None,
            source: EnvSource::Missing,
            // 可选项缺失不是「有问题」，只是「这类工作流跑不了」
            status: if probe.optional {
                EnvStatus::Optional
            } else {
                EnvStatus::Missing
            },
            detail: Some(probe.detail.to_string()),
            install_hint: Some(InstallHint {
                command: command.to_string(),
                source: source.to_string(),
                url: url.map(str::to_string),
            }),
        };
    };

    EnvHealthItem {
        capability: probe.capability.to_string(),
        label: probe.label.to_string(),
        version: read_version(probe.command, probe.version_arg),
        path: Some(path),
        source: EnvSource::System,
        status: EnvStatus::Ready,
        detail: None,
        install_hint: None,
    }
}

fn probe_adapter(runtime: &str, label: &str) -> EnvHealthItem {
    match aiwf_engine::acp::adapter_installed(runtime) {
        Some(path) => EnvHealthItem {
            capability: runtime.to_string(),
            label: label.to_string(),
            version: None,
            // 装在 sidecar 目录下的算 app_managed —— 它不进全局 PATH，
            // 这正是「不把 App 工具写入全局 PATH」那句话的落地
            source: if path.contains("node_modules") {
                EnvSource::AppManaged
            } else {
                EnvSource::System
            },
            path: Some(path),
            status: EnvStatus::Ready,
            detail: None,
            install_hint: None,
        },
        None => EnvHealthItem {
            capability: runtime.to_string(),
            label: label.to_string(),
            version: None,
            path: None,
            source: EnvSource::Missing,
            // AI 节点与主管 AI 都要它，但没有它其余功能照常 ——
            // 所以是可选而不是缺失
            status: EnvStatus::Optional,
            detail: Some(adapter_missing_detail(which("node").as_deref())),
            install_hint: Some(InstallHint {
                // 给的是全局安装。原来这里写的是
                // `pnpm --filter @aiwf/acp-sidecar add …` —— 那条命令要在
                // 本仓库里才跑得通，而装了 App 的用户手上根本没有仓库，
                // 照着复制只会得到一句「找不到 @aiwf/acp-sidecar」。
                // 从源码跑的人不需要这条提示，他们那份已经装在 node_modules 下了
                command: format!(
                    "npm install -g {}",
                    if runtime == "acp.claude" {
                        "@agentclientprotocol/claude-agent-acp"
                    } else {
                        "@agentclientprotocol/codex-acp"
                    }
                ),
                source: "Agent Client Protocol 官方 adapter（npm）".to_string(),
                url: Some("https://agentclientprotocol.com".to_string()),
            }),
        },
    }
}

/// adapter 找不到时那句话。带上**当前用的 node 在哪**。
///
/// 「未安装」这三个字对一个刚跑完 `npm install -g` 的人是没有信息的。
/// 真实发生过一次：用户跑安装命令的终端里 nvm 切在 v22 上，包装进了
/// `~/.nvm/versions/node/v22.23.1/bin`，而应用读的是登录 shell 那份 PATH
/// （node 是 v25.6.1）—— 两边都没错，只是不是同一个 node。
/// npm 的全局包跟着 node 版本走，不把这件事说出来，用户只会
/// 反复重装同一条命令。
pub fn adapter_missing_detail(node: Option<&str>) -> String {
    let mut message = "AI 节点与主管 AI 需要它。".to_string();
    match node {
        Some(path) => message.push_str(&format!(
            "它随 npm 全局安装，位置跟着 node 版本走 —— \
             检测用的 node 是 {path}，请确认装到了同一个下面",
        )),
        // node 都没有的话，adapter 更不可能有；先解决 node 那一项
        None => message.push_str("它跑在 Node.js 上，而 Node.js 当前也没找到 —— 先装它"),
    }
    message
}

fn which(command: &str) -> Option<String> {
    // 走 tooling 而不是 fork 一个 `which`：后者查的是**本进程继承的 PATH**，
    // 而打包版 App 由 launchd 拉起，那份 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin。
    // 用户在终端里装齐了 node / gh / docker，这一屏却报「都没安装」，
    // 根因就在这里
    aiwf_engine::tooling::which(command).map(|path| path.display().to_string())
}

/// 读版本号。读不到不算失败 —— 工具在就是在，版本只是补充信息。
fn read_version(command: &str, arg: &str) -> Option<String> {
    // 与上面 which 同一份 PATH：找得到却跑不起来的话，
    // 用户会看到一条「已就绪」但没有版本号的记录，而那说明不了任何事
    let output = aiwf_engine::tooling::command(command)
        .arg(arg)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    // 「git version 2.45.1」→「2.45.1」：前缀对用户没用，
    // 而表格里那一列窄得放不下整句。
    //
    // 结尾的逗号也要去：docker 报的是「Docker version 29.5.2, build …」，
    // 不去掉的话表格里显示成「29.5.2,」，看着像我们把字符串截断了
    Some(
        line.split_whitespace()
            .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .unwrap_or(line)
            .trim_start_matches('v')
            .trim_end_matches(',')
            .to_string(),
    )
}
