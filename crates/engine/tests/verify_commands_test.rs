//! `verifyCommands` 真的会跑 —— 而不是填了不生效。
//!
//! 契约里它是「验证命令」，`issue-feature` 的 summary 写着
//! 「→ 实现 → **自测** → 审查 →」，而 `grep -rn verifyCommands crates`
//! 此前**零命中**（`node-config-drift` 白名单里记着「一条都不会跑」）。
//!
//! 两个刻意的选择：在 agent 的 cwd 里跑（验的是它刚改的那份代码），
//! 失败走 `failed` 端口而不是让节点失败（验证红了是一条要交给下游
//! 判断的事实，不是「这个节点崩了」）。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;

use aiwf_engine::executor::{NodeEvent, NodeExecutor};
use aiwf_engine::graph::GraphNode;

/// 只测验证命令那一段 —— AI 那半要连真 adapter，不在这条的范围里。
fn 跑验证(commands: &[&str], cwd: &std::path::Path) -> (Option<String>, Vec<NodeEvent>) {
    let node = GraphNode {
        id: "build".to_string(),
        node_type: "ai.execute".to_string(),
        title: "执行".to_string(),
        config: serde_json::json!({
            "agentProfileId": "a", "instruction": "改点东西",
            "verifyCommands": commands,
        }),
        join: None,
    };
    let events: Mutex<Vec<NodeEvent>> = Mutex::new(Vec::new());
    let executor = NodeExecutor::new(cwd.to_path_buf());
    let failed = executor.run_verify_commands_for_test(&node, &cwd.display().to_string(), &|e| {
        events.lock().unwrap().push(e);
    });
    let events = events.lock().unwrap().clone();
    (failed, events)
}

#[test]
fn 命令真的被执行了_而不是填了不生效() {
    let dir = tempfile::tempdir().unwrap();
    let 产出 = dir.path().join("跑过了.txt");
    let (failed, _) = 跑验证(&[&format!("echo x > {}", 产出.display())], dir.path());
    assert!(failed.is_none(), "命令成功却报了失败");
    assert!(产出.exists(), "验证命令一次都没跑 —— 那正是「填了不生效」");
}

#[test]
fn 在_agent_的_cwd_里跑_不是别处() {
    // 验的是它刚改的那份代码
    let dir = tempfile::tempdir().unwrap();
    let (failed, _) = 跑验证(&["echo y > 相对路径.txt"], dir.path());
    assert!(failed.is_none());
    assert!(dir.path().join("相对路径.txt").exists(), "跑在了别的目录下");
}

#[test]
fn 失败时返回原因并留一条事件() {
    let dir = tempfile::tempdir().unwrap();
    let (failed, events) = 跑验证(&["exit 7"], dir.path());
    let reason = failed.expect("退出码 7 应当算失败");
    assert!(reason.contains("exit 7"), "原因要说清是哪条命令：{reason}");
    assert!(
        events.iter().any(|e| e.summary.contains("没通过")),
        "失败要留一条事件：{events:?}"
    );
}

#[test]
fn 每条单独跑_单独发事件() {
    // 三条里第二条红了，用户要看得出是哪一条
    let dir = tempfile::tempdir().unwrap();
    let (failed, events) = 跑验证(&["true", "exit 1", "echo 不该跑到这"], dir.path());
    assert!(failed.is_some());
    assert_eq!(
        events.len(),
        2,
        "第二条失败之后不该继续跑第三条：{events:?}"
    );
}

#[test]
fn 没配验证命令时什么都不做() {
    let dir = tempfile::tempdir().unwrap();
    let (failed, events) = 跑验证(&[], dir.path());
    assert!(failed.is_none());
    assert!(events.is_empty(), "没配就不该发事件：{events:?}");
}
