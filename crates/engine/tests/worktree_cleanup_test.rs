//! B-4：`cleanupPolicy` 真的驱动清理。
//!
//! 此前 `cleanup_worktree` 是死代码 —— 函数本身写得很好、测试全绿，
//! 只是生产代码零调用：每跑一次带 worktree 的工作流，磁盘上就
//! 永久多一个目录。这组测试跑**真的 git、真的 Runner**，断言
//! 「按策略该清的清了、该留的留了」。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::Command;

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_store::Store;

fn fixture_repo(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("aiwf_wtclean_{name}"));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} 失败：{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "user.name", "Test"]);
    std::fs::write(root.join("README.md"), "base\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    root
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    let out = Command::new("git")
        .args(["branch", "--list", branch])
        .current_dir(repo)
        .output()
        .unwrap();
    !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}

/// 跑一条「入口 → worktree →（可选的下游脚本）」的工作流。
/// 返回 (store, run_id, 运行状态, workdir)。
fn run_worktree_flow(
    name: &str,
    repo: &Path,
    cleanup_policy: &str,
    tail_script: Option<&str>,
) -> (Store, String, String, PathBuf) {
    let workdir = std::env::temp_dir().join(format!("aiwf_wtclean_run_{name}"));
    let _ = std::fs::remove_dir_all(&workdir);

    let mut nodes = vec![
        serde_json::json!({"id": "entry", "type": "entry", "title": "入口", "config": {}}),
        serde_json::json!({"id": "wt", "type": "git.worktree", "title": "建工作区", "config": {
            "repoRoot": repo.display().to_string(),
            "baseBranch": "main",
            "branchTemplate": format!("aiwf/{name}"),
            "cleanupPolicy": cleanup_policy,
        }}),
    ];
    let mut edges = vec![serde_json::json!(
        {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
         "target": {"nodeId": "wt", "port": "input"}}
    )];
    if let Some(script) = tail_script {
        nodes.push(serde_json::json!(
            {"id": "tail", "type": "script.shell", "title": "下游",
             "config": {"interpreter": "bash", "script": script, "timeoutMs": 10000}}
        ));
        edges.push(serde_json::json!(
            {"id": "e2", "source": {"nodeId": "wt", "port": "success"},
             "target": {"nodeId": "tail", "port": "input"}}
        ));
    }
    let graph = serde_json::json!({"nodes": nodes, "edges": edges, "groups": []}).to_string();

    let store = Store::open_in_memory().unwrap();
    store
        .set_workspace_setting("permissionPreset", "human_approval")
        .unwrap();
    let workflow = store
        .create_workflow_with_graph("worktree 清理", None, &graph)
        .unwrap();
    let runner = Runner::new();
    let run_id = runner
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: workdir.display().to_string(),
            },
        )
        .unwrap();
    let status = runner.run_all(&store, &run_id).unwrap();
    (store, run_id, status, workdir)
}

fn worktree_path(store: &Store, run_id: &str) -> PathBuf {
    // worktree 节点的 output_emitted 事件里带着路径；
    // 但直接从落点推导更稳：workdir/.aiwf-worktrees 下唯一的子目录
    let events = store.events(run_id, 0, 200).unwrap();
    let summary = &events
        .iter()
        .find(|e| e.kind == "node.output_emitted" && e.node_id.as_deref() == Some("wt"))
        .expect("worktree 节点要报它建在哪")
        .summary;
    let path = summary
        .split("worktree ")
        .nth(1)
        .expect("摘要里有路径")
        .trim();
    PathBuf::from(path)
}

#[test]
fn 默认策略_运行成功后worktree被清理_分支保留_事件留痕() {
    let repo = fixture_repo("ok_default");
    let (store, run_id, status, _workdir) =
        run_worktree_flow("ok_default", &repo, "on_success", None);
    assert_eq!(status, "succeeded");

    let wt = worktree_path(&store, &run_id);
    assert!(
        !wt.exists(),
        "on_success + 成功 ⇒ worktree 目录应被移除：{}",
        wt.display()
    );
    assert!(
        branch_exists(&repo, "aiwf/ok_default"),
        "分支必须保留 —— 提交在分支上"
    );
    assert!(
        store
            .events(&run_id, 0, 200)
            .unwrap()
            .iter()
            .any(|e| e.kind == "system.worktree_cleaned"),
        "删了用户磁盘上的目录必须留痕"
    );
}

#[test]
fn keep策略_运行成功也不清理() {
    let repo = fixture_repo("keep");
    let (store, run_id, status, _workdir) = run_worktree_flow("keep", &repo, "keep", None);
    assert_eq!(status, "succeeded");

    let wt = worktree_path(&store, &run_id);
    assert!(wt.exists(), "keep ⇒ 目录留着：{}", wt.display());
    assert!(
        store
            .events(&run_id, 0, 200)
            .unwrap()
            .iter()
            .all(|e| e.kind != "system.worktree_cleaned"),
        "没清就不该有清理事件"
    );
}

#[test]
fn 默认策略_运行失败保留现场() {
    let repo = fixture_repo("fail_keep");
    let (store, run_id, status, _workdir) =
        run_worktree_flow("fail_keep", &repo, "on_success", Some("exit 1"));
    assert_eq!(status, "failed");

    let wt = worktree_path(&store, &run_id);
    assert!(
        wt.exists(),
        "on_success + 失败 ⇒ 保留现场供排查：{}",
        wt.display()
    );
}

#[test]
fn on_run_end策略_运行失败也清理() {
    let repo = fixture_repo("end_clean");
    let (store, run_id, status, _workdir) =
        run_worktree_flow("end_clean", &repo, "on_run_end", Some("exit 1"));
    assert_eq!(status, "failed");

    let wt = worktree_path(&store, &run_id);
    assert!(!wt.exists(), "on_run_end ⇒ 成败都清：{}", wt.display());
}

#[test]
fn 脏worktree拒绝清理_安全闸门在真实路径上生效() {
    let repo = fixture_repo("dirty");
    // 下游脚本往 worktree 里写一个不提交的文件 —— agent 常见的中途现场
    let (store, run_id, status, _workdir) = run_worktree_flow(
        "dirty",
        &repo,
        "on_success",
        Some("echo droppings > ${wt.success.path}/uncommitted.txt"),
    );
    assert_eq!(status, "succeeded");

    let wt = worktree_path(&store, &run_id);
    assert!(
        wt.exists(),
        "有未提交改动 ⇒ 拒绝清理，宁可留孤儿：{}",
        wt.display()
    );
    assert!(
        store
            .events(&run_id, 0, 200)
            .unwrap()
            .iter()
            .all(|e| e.kind != "system.worktree_cleaned"),
        "没清成不能谎报清理事件"
    );
}

#[test]
fn 审批被拒的终止路径也按_on_run_end_清理() {
    // codex 复核抓到的:decide_approval 拒绝时直接置 failed,
    // 不经过 run_until_pause 的收尾 —— on_run_end 的清理承诺漏了这条路
    let repo = fixture_repo("reject_clean");
    let workdir = std::env::temp_dir().join("aiwf_wtclean_run_reject");
    let _ = std::fs::remove_dir_all(&workdir);

    let graph = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "wt", "type": "git.worktree", "title": "建工作区", "config": {
                "repoRoot": repo.display().to_string(),
                "baseBranch": "main",
                "branchTemplate": "aiwf/reject_clean",
                "cleanupPolicy": "on_run_end",
            }},
            {"id": "gate", "type": "approval", "title": "把关", "config": {"title": "确认"}},
            {"id": "done", "type": "end", "title": "结束", "config": {}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "wt", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "wt", "port": "success"}, "target": {"nodeId": "gate", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "gate", "port": "approved"}, "target": {"nodeId": "done", "port": "input"}}
        ],
        "groups": []
    })
    .to_string();

    let store = Store::open_in_memory().unwrap();
    store
        .set_workspace_setting("permissionPreset", "human_approval")
        .unwrap();
    let workflow = store
        .create_workflow_with_graph("拒批清理", None, &graph)
        .unwrap();
    let runner = Runner::new();
    let run_id = runner
        .start(
            &store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: workdir.display().to_string(),
            },
        )
        .unwrap();
    let status = runner.run_all(&store, &run_id).unwrap();
    assert_eq!(status, "waiting_approval", "先挂在审批上");

    let wt = worktree_path(&store, &run_id);
    assert!(wt.exists(), "挂着时 worktree 还在");

    runner
        .decide_approval(&store, &run_id, "gate", "rejected")
        .unwrap();
    assert_eq!(
        store.run_status(&run_id).unwrap().as_deref(),
        Some("failed")
    );
    assert!(
        !wt.exists(),
        "on_run_end ⇒ 拒批这种结束也要清:{}",
        wt.display()
    );
}
