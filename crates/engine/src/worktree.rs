use std::path::{Path, PathBuf};
use std::process::Command;

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

/// 移除 worktree。有未提交改动就拒绝。
///
/// 宁可留下一个孤儿目录，也不要删掉用户还没保存的工作 ——
/// 目录可以事后手动清，丢掉的改动找不回来。
pub fn cleanup_worktree(repo_root: &Path, worktree_path: &Path) -> Result<()> {
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
    let output = Command::new("git")
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
    let output = Command::new("git")
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

fn is_dirty(worktree: &Path) -> Result<bool> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree)
        .output()?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").args(args).current_dir(repo).output()?;
    if !output.status.success() {
        return Err(WorktreeError::Git {
            command: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
