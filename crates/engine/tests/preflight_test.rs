//! Dry Run 依赖检查。
//!
//! 图纸的启动表单里有一块「Dry Run 依赖检查 · N 项通过 · M 项缺失」。
//! 这里只列**真的查过**的项：查不了的（ACP 握手、网络白名单）
//! 不出现在结果里，绝不放一个永远显示「通过」的假条目。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::graph::WorkflowGraph;
use aiwf_engine::preflight::{CheckStatus, dry_run};

fn graph(json: serde_json::Value) -> WorkflowGraph {
    serde_json::from_value(json).unwrap()
}

fn minimal() -> serde_json::Value {
    serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "run", "type": "script.shell", "title": "跑",
             "config": {"interpreter": "bash", "script": "echo hi"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "run", "port": "input"}}
        ],
        "groups": []
    })
}

#[test]
fn 图结构没问题时给出通过的检查项() {
    let workdir = std::env::temp_dir();
    let report = dry_run(&graph(minimal()), &workdir);

    let structure = report
        .checks
        .iter()
        .find(|c| c.label.contains("图结构"))
        .expect("应当有图结构检查");
    assert_eq!(structure.status, CheckStatus::Passed);
    assert!(report.ok);
}

#[test]
fn 有环的图在_dry_run_就被拦下_不必等到跑起来() {
    let cyclic = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A", "config": {"script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B", "config": {"script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "b", "port": "success"}, "target": {"nodeId": "a", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(cyclic), &std::env::temp_dir());
    assert!(!report.ok);
    let failed = report
        .checks
        .iter()
        .find(|c| c.status == CheckStatus::Failed)
        .unwrap();
    assert!(failed.detail.contains("环"), "详情实际：{}", failed.detail);
}

#[test]
fn 缺少入口节点时明确指出() {
    let no_entry = serde_json::json!({
        "nodes": [{"id": "a", "type": "script.shell", "title": "A", "config": {"script": "x"}}],
        "edges": [],
        "groups": []
    });
    let report = dry_run(&graph(no_entry), &std::env::temp_dir());
    assert!(!report.ok);
    assert!(
        report.checks.iter().any(|c| c.detail.contains("入口")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 工作目录不存在是缺失而不是通过() {
    let report = dry_run(
        &graph(minimal()),
        std::path::Path::new("/definitely/not/here"),
    );
    let workdir = report
        .checks
        .iter()
        .find(|c| c.label.contains("工作目录"))
        .expect("应当有工作目录检查");
    assert_eq!(workdir.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 图里用到的解释器会被逐个检查() {
    let with_zsh = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A",
             "config": {"interpreter": "bash", "script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B",
             "config": {"interpreter": "definitely-not-a-shell", "script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_zsh), &std::env::temp_dir());

    let bash = report
        .checks
        .iter()
        .find(|c| c.label.contains("bash"))
        .unwrap();
    assert_eq!(bash.status, CheckStatus::Passed);
    let missing = report
        .checks
        .iter()
        .find(|c| c.label.contains("definitely-not-a-shell"))
        .unwrap();
    assert_eq!(missing.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 同一个解释器用在多个节点上只检查一次() {
    let repeated = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A", "config": {"interpreter": "bash", "script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B", "config": {"interpreter": "bash", "script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(repeated), &std::env::temp_dir());
    assert_eq!(
        report
            .checks
            .iter()
            .filter(|c| c.label.contains("bash"))
            .count(),
        1
    );
}

#[test]
fn git_worktree_节点会检查_git_可用() {
    let with_git = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "wt", "type": "git.worktree", "title": "worktree",
             "config": {"repoRoot": "/tmp", "baseBranch": "main"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "wt", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_git), &std::env::temp_dir());
    assert!(
        report.checks.iter().any(|c| c.label.contains("git")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 没有_git_节点时不检查_git_不列无关条目() {
    // 列一堆与这个工作流无关的检查项，会让用户以为自己缺东西
    let report = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert!(!report.checks.iter().any(|c| c.label.contains("git ")));
}

#[test]
fn 尚未实现的节点类型在_dry_run_就说清楚() {
    // 跑到一半才说「ai.execute 尚未实现」太晚了，那时已经产生了副作用
    let with_ai = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ai", "type": "ai.execute", "title": "修复", "config": {"instruction": "修"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "ai", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_ai), &std::env::temp_dir());
    let unimplemented = report
        .checks
        .iter()
        .find(|c| c.label.contains("ai.execute"))
        .expect("应当指出未实现的节点类型");
    assert_eq!(unimplemented.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 汇总计数与检查项一致() {
    let report = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert_eq!(
        report.passed,
        report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Passed)
            .count()
    );
    assert_eq!(
        report.failed,
        report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Failed)
            .count()
    );
}
