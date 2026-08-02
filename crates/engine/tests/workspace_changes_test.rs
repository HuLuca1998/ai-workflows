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

/*
 * ── 产物目录不算 agent 的改动 ────────────────────────────────────────
 *
 * 实测（run_e97c3005197b58d8，嵌套发布编排，2026-08-02）：
 *
 *   #48 node.output_emitted  merge  改了 1072 个文件：.aiwf-artifacts/run_a6d9f50a916b405f/sca…
 *
 * 那个 `merge` 节点是**只读**的（它只调 MCP 读子运行的报告），
 * 一个文件都没改。1072 全是引擎自己写的 prompt.md / stdout.log / agent.md，
 * 而且因为父子共用工作目录，父运行还把**子运行**的产物一起认领了。
 *
 * 用户看到这句话的第一反应是「它动了一千多个文件？」——
 * 而真正该看的那几个被埋在里面。这条守的是「这句话说的是 agent 干的事」。
 */

#[test]
fn 产物目录里的文件不算作节点改动() {
    let (_guard, root) = 空仓库();

    // 引擎自己写的：本次运行的产物，外加一条子运行的
    for run in ["run_parent", "run_child"] {
        let artifacts = root.join(".aiwf-artifacts").join(run).join("某节点");
        std::fs::create_dir_all(&artifacts).unwrap();
        for name in ["prompt.md", "stdout.log", "agent.md"] {
            std::fs::write(artifacts.join(name), "引擎写的").unwrap();
        }
    }
    // agent 真改的
    std::fs::write(root.join("report.json"), "{}").unwrap();

    let changes = workspace_changes(&root).expect("git 仓库该能算出改动");
    assert!(
        changes.files.iter().all(|f| !f.contains(".aiwf-artifacts")),
        "产物目录进了「改了什么」的清单 —— 那是引擎自己写的，不是 agent 干的。\
         实测里这让一个只读节点报「改了 1072 个文件」：{:?}",
        changes.files
    );
    assert_eq!(
        changes.files,
        vec!["report.json".to_string()],
        "agent 真改的那个文件应当仍在清单里"
    );
}

#[test]
fn 只有产物时报没有改动_而不是报改了一堆() {
    // 只读节点的常态。原来它会报「改了 N 个文件」，N 是引擎自己写的产物数
    let (_guard, root) = 空仓库();
    let artifacts = root.join(".aiwf-artifacts").join("run_x").join("n");
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(artifacts.join("prompt.md"), "引擎写的").unwrap();

    let changes = workspace_changes(&root).expect("git 仓库该能算出改动");
    assert!(
        changes.is_empty(),
        "只有产物却报有改动：{:?}",
        changes.files
    );
}

#[test]
fn 名字里带_aiwf_artifacts_的普通文件不受影响() {
    /*
     * 过滤要按**目录前缀**，不能按「路径里出现这个词」——
     * `docs/aiwf-artifacts-说明.md` 是一个正常文件。
     * 这条防的是把过滤顺手写成 `contains("aiwf-artifacts")` 那种。
     */
    let (_guard, root) = 空仓库();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/aiwf-artifacts-说明.md"), "文档").unwrap();

    let changes = workspace_changes(&root).expect("git 仓库该能算出改动");
    assert_eq!(
        changes.files,
        vec!["docs/aiwf-artifacts-说明.md".to_string()],
        "一个名字里带 aiwf-artifacts 的正常文件被过滤掉了"
    );
}
