//! AI 执行节点到底改了什么。
//!
//! 端到端跑真实 Issue 时撞到的：`ai.execute` 节点报「完成 · 走 success 分支」，
//! 对话里 Agent 也说得头头是道，但工作区里一个字节都没变 —— 上游分析
//! 没接进指令，它没弄清要改什么就收尾了。
//!
//! 这件事一直到三个节点之后的 `git push` 才暴露（推上去的分支与 base
//! 指向同一提交）。中间的审查、分级、人工审批全都是在评审一份空改动。
//!
//! 所以执行节点必须留下「它动了哪些文件」这条证据：不是为了判成败
//! （不改文件有时是对的），是为了让「什么都没做」当场看得见。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::Command;

use aiwf_engine::executor::workspace_changes;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} 失败：{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn 空仓库() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@e.test"]);
    git(&root, &["config", "user.name", "T"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "init"]);
    (dir, root)
}

#[test]
fn 改了文件就说清改了哪些() {
    let (_guard, root) = 空仓库();
    std::fs::write(root.join("a.txt"), "one\nTWO\nthree\n").unwrap();

    let changes = workspace_changes(&root).expect("git 仓库该能算出改动");
    assert_eq!(changes.files, vec!["a.txt".to_string()]);
    assert!(changes.summary.contains("a.txt"), "{}", changes.summary);
    assert!(!changes.is_empty());
}

#[test]
fn 新建的文件也算改动() {
    let (_guard, root) = 空仓库();
    std::fs::write(root.join("新的.rs"), "fn main() {}\n").unwrap();

    let changes = workspace_changes(&root).expect("未跟踪文件也要算进去");
    assert_eq!(changes.files, vec!["新的.rs".to_string()]);
}

/// 这条是重点：什么都没改时**不能沉默**，要明确说出来。
#[test]
fn 什么都没改时明确说出来() {
    let (_guard, root) = 空仓库();

    let changes = workspace_changes(&root).expect("干净仓库也要有结论");
    assert!(changes.is_empty());
    assert!(changes.files.is_empty());
    assert!(
        changes.summary.contains("没有"),
        "要把「什么都没做」说出来：{}",
        changes.summary
    );
}

/// 不是 git 仓库时返回 None —— `workdirSource: inherit/declared` 的
/// 执行节点可能跑在任意目录里，那时没有「改了什么」可谈，
/// 不该编一个「0 个文件」出来冒充证据。
#[test]
fn 不是_git_仓库时不编证据() {
    let dir = tempfile::tempdir().unwrap();
    assert!(workspace_changes(dir.path()).is_none());
}
