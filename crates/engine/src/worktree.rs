use std::path::{Path, PathBuf};

/// Git worktree 节点。
///
/// 存在的全部理由：Agent 改代码不能碰用户正在编辑的分支。
/// 因此这里的每个失败都倾向于「拒绝并保留现场」，而不是「尽力而为地继续」。
#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("{path} 不是一个 Git 仓库")]
    NotARepo { path: String },
    #[error("基础分支 {branch} 不存在")]
    BaseMissing { branch: String },
    #[error("分支 {branch} 已存在。换一个分支名，或先处理掉那个分支上的工作")]
    BranchExists { branch: String },
    #[error("worktree {path} 里有未提交的改动，已拒绝清理")]
    DirtyWorktree { path: String },
    #[error("{path} 不是引擎建的 worktree，已拒绝清理")]
    NotOurs { path: String },
    #[error("git {command} 失败：{stderr}")]
    Git { command: String, stderr: String },
    #[error("文件系统错误：{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, WorktreeError>;

pub struct WorktreeRequest {
    pub repo_root: PathBuf,
    pub base_branch: String,
    pub branch: String,
    /// worktree 建在哪个目录下。每个 worktree 都是它的**直接**子目录。
    pub parent_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct WorktreeResult {
    pub path: PathBuf,
    pub branch: String,
}

pub fn create_worktree(request: WorktreeRequest) -> Result<WorktreeResult> {
    ensure_repo(&request.repo_root)?;

    if !branch_exists(&request.repo_root, &request.base_branch)? {
        return Err(WorktreeError::BaseMissing {
            branch: request.base_branch.clone(),
        });
    }
    // 复用已有分支意味着把别人的改动混进这次运行
    if branch_exists(&request.repo_root, &request.branch)? {
        return Err(WorktreeError::BranchExists {
            branch: request.branch.clone(),
        });
    }

    std::fs::create_dir_all(&request.parent_dir)?;
    let target = request.parent_dir.join(dir_name(&request.branch));

    git(
        &request.repo_root,
        &[
            "worktree",
            "add",
            "-b",
            &request.branch,
            &target.to_string_lossy(),
            &request.base_branch,
        ],
    )?;

    Ok(WorktreeResult {
        path: target,
        branch: request.branch,
    })
}

/// 移除 worktree。
///
/// 两道闸门，宁可留下孤儿目录也不误删：
///
/// 1. **只删引擎自己建的**。git 只验证「这是本仓库注册过的 worktree」，
///    用户手工建的也满足 —— 那会把别人正在用的工作区删掉。
/// 2. **有任何改动就拒绝**，包括 .gitignore 命中的文件。
///    `git status --porcelain` 默认不显示被忽略的文件，照它判断「干净」
///    会连用户的构建缓存、本地配置一起递归删掉。
pub fn cleanup_worktree(repo_root: &Path, worktree_path: &Path) -> Result<()> {
    cleanup_worktree_in(repo_root, worktree_path, None)
}

/// 带归属校验的清理。`parent_dir` 是引擎放 worktree 的目录；
/// 给 None 时从路径名兜底判断（叶子名必须是引擎生成的那种）。
pub fn cleanup_worktree_in(
    repo_root: &Path,
    worktree_path: &Path,
    parent_dir: Option<&Path>,
) -> Result<()> {
    if let Some(parent) = parent_dir {
        if worktree_path.parent() != Some(parent) {
            return Err(WorktreeError::NotOurs {
                path: worktree_path.display().to_string(),
            });
        }
    } else if !is_engine_worktree(worktree_path) {
        return Err(WorktreeError::NotOurs {
            path: worktree_path.display().to_string(),
        });
    }

    if worktree_path.exists() && is_dirty(worktree_path)? {
        return Err(WorktreeError::DirtyWorktree {
            path: worktree_path.display().to_string(),
        });
    }

    git(
        repo_root,
        &["worktree", "remove", &worktree_path.to_string_lossy()],
    )?;
    Ok(())
}

/// 这个 worktree 是不是引擎建的。
///
/// 判据是它躺在引擎的 worktree 目录里（`.aiwf-worktrees`），
/// 或者测试用的 `aiwf_wt_*_out`。用户手工建的不会在这些地方。
fn is_engine_worktree(path: &Path) -> bool {
    path.parent().is_some_and(|parent| {
        parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == ENGINE_WORKTREE_DIR || name.ends_with("_out"))
    })
}

/// 引擎放 worktree 的目录名。executor 建的时候用同一个常量。
pub const ENGINE_WORKTREE_DIR: &str = ".aiwf-worktrees";

/// 分支名转目录名：斜杠换成短横。
///
/// 直接拿 `feat/deep/nested` 当路径会在 parent 下撑出多层目录，
/// 清理时一个 `remove_dir_all(parent/feat)` 就会误删同级的别的 worktree。
fn dir_name(branch: &str) -> String {
    branch.replace(['/', '\\'], "-")
}

fn ensure_repo(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Err(WorktreeError::NotARepo {
            path: path.display().to_string(),
        });
    }
    let output = crate::tooling::command("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()?;
    if !output.status.success() {
        return Err(WorktreeError::NotARepo {
            path: path.display().to_string(),
        });
    }
    Ok(())
}

fn branch_exists(repo: &Path, branch: &str) -> Result<bool> {
    let output = crate::tooling::command("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(repo)
        .output()?;
    Ok(output.status.success())
}

/// worktree 里有没有任何改动。
///
/// `--ignored` 是关键：默认不显示 .gitignore 命中的文件，
/// 而那些往往是最贵的东西（构建缓存、本地配置、依赖目录）。
/// 删掉它们不会丢代码，但会让用户重跑一次几十分钟的构建。
fn is_dirty(worktree: &Path) -> Result<bool> {
    let output = crate::tooling::command("git")
        .args(["status", "--porcelain", "--ignored"])
        .current_dir(worktree)
        .output()?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let output = crate::tooling::command("git")
        .args(args)
        .current_dir(repo)
        .output()?;
    if !output.status.success() {
        return Err(WorktreeError::Git {
            command: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
