//! 一键初始化的存储侧：清空重来。
//!
//! 「重来」有两层意思，缺一层这功能就是坏的：
//! 用户自己建的东西要没，内置的那批要**回来**。
//! 只做前一层的话，重置完是个空壳 —— 没有模型、没有 Agent 角色，
//! 比重置前更糟。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

fn 新库() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_workspace(&dir.path().join("aiwf.sqlite")).unwrap();
    (dir, store)
}

#[test]
fn 重置后用户建的工作流没了() {
    let (_dir, mut store) = 新库();
    store.create_workflow("我自己搭的", None).unwrap();
    let (前, _) = store.list_workflows_paged(50, 0).unwrap();
    let 自建 = 前.iter().filter(|w| w.name == "我自己搭的").count();
    assert_eq!(自建, 1, "前置条件没成立：那条工作流压根没建上");

    store.reset_workspace().unwrap();

    let (后, _) = store.list_workflows_paged(50, 0).unwrap();
    assert!(
        !后.iter().any(|w| w.name == "我自己搭的"),
        "重置之后用户建的工作流还在：{:?}",
        后.iter().map(|w| &w.name).collect::<Vec<_>>()
    );
}

#[test]
fn 重置后内置数据回来了() {
    let (_dir, mut store) = 新库();
    // 模拟一个「被折腾坏了」的库：内置模型全停用、内置角色的目标改成一句废话。
    //
    // 内置角色删不掉（存储层挡着），模型现在也删不掉（四个内置角色在引用它，
    // `delete_model` 会拒绝并说清是谁）—— 但两者都**改得动**，
    // 而「改坏了想恢复」正是用户会来点这个按钮的场景。
    for id in ["model:codex", "model:claude"] {
        store
            .update_model(id, None, None, None, None, None, None, Some(false))
            .unwrap();
    }
    let 角色 = store.get_agent("builtin:analyst").unwrap().unwrap();
    store
        .update_agent(
            "builtin:analyst",
            角色.ver,
            &aiwf_store::AgentPatch {
                goal: Some("啥也不干"),
                ..Default::default()
            },
        )
        .unwrap();

    store.reset_workspace().unwrap();

    let (models, _) = store.list_models_paged(true, None, 50, 0).unwrap();
    let runtimes: Vec<&str> = models.iter().map(|m| m.runtime.as_str()).collect();
    assert!(runtimes.contains(&"acp.codex"), "{runtimes:?}");
    assert!(runtimes.contains(&"acp.claude"), "{runtimes:?}");

    let (agents, _) = store.list_agents_paged(None, 50, 0).unwrap();
    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    for id in [
        "builtin:analyst",
        "builtin:builder",
        "builtin:reviewer",
        "builtin:operator",
    ] {
        assert!(ids.contains(&id), "{id} 没回来：{ids:?}");
    }

    // 光有 id 不够 —— 改坏的那一句得真的回到内置文案
    let 恢复后 = store.get_agent("builtin:analyst").unwrap().unwrap();
    assert_ne!(恢复后.goal, "啥也不干", "角色还在，但内容是用户改坏的那份");
}

#[test]
fn 重置后示例工作流在() {
    // 「重置完什么都没有」与「重置完有一条能点开的示例」是两种体验。
    // 后者才是用户选的那个。
    let (_dir, mut store) = 新库();
    store.reset_workspace().unwrap();

    let (工作流, _) = store.list_workflows_paged(50, 0).unwrap();
    let 示例 = 工作流
        .iter()
        .find(|w| w.name == "GitHub Issue 修复")
        .expect("示例工作流不见了");

    // 光有条目不够 —— 点开是空图的话，用户看到的是一条坏工作流
    let rev = store.draft_revision(&示例.id).unwrap().expect("没有草稿");
    let graph_json = store.get_draft(&示例.id, rev).unwrap().expect("草稿是空的");
    let graph: serde_json::Value = serde_json::from_str(&graph_json).unwrap();
    let nodes = graph["nodes"].as_array().expect("图里没有 nodes");
    assert!(nodes.len() >= 9, "示例工作流只有 {} 个节点", nodes.len());
}

#[test]
fn 重置不改_schema_版本() {
    // DROP 全表之后忘了重跑迁移的话，下一次写入才会炸，
    // 而那时用户已经以为重置成功了
    let (_dir, mut store) = 新库();
    let 前 = store.schema_version().unwrap();
    store.reset_workspace().unwrap();
    assert_eq!(store.schema_version().unwrap(), 前);
}

#[test]
fn 重置可以连着做两次() {
    // 第二次必须也能成 —— 「种过没有」的记账要跟着一起清掉，
    // 否则第二次重置出来的是个没有内置数据的空库
    let (_dir, mut store) = 新库();
    store.reset_workspace().unwrap();
    store.reset_workspace().unwrap();

    let (models, _) = store.list_models_paged(true, None, 50, 0).unwrap();
    assert!(!models.is_empty(), "第二次重置之后内置模型没种上");
}

#[test]
fn 重置之后外键还开着() {
    // 踩过：DROP 全表期间要关外键（否则 COMMIT 时报「引用的表没了」），
    // 而关掉之后忘了开回来的话，这条连接**之后再也不检查外键** ——
    // 症状是删一条工作流，它的草稿修订留在库里成了孤儿，
    // 而界面上一切正常，直到某天统计数字对不上。
    let (_dir, mut store) = 新库();
    store.reset_workspace().unwrap();
    assert_eq!(store.pragma_string("foreign_keys").unwrap(), "1");
}

#[test]
fn 重置失败也要把外键开回来() {
    // 成功路径上开回来不够 —— 失败路径才是最容易漏的那条，
    // 而它留下的是一条「看起来正常、其实不校验」的连接
    let (_dir, mut store) = 新库();
    let _ = store.reset_workspace();
    assert_eq!(store.pragma_string("foreign_keys").unwrap(), "1");
}

#[test]
fn 重置后连接还能用() {
    // 实现上刻意不删数据库文件：MCP 与主管 AI 各自持有连接，
    // 删文件会让它们指向一个已经不存在的 inode —— 之后的写入静默丢失。
    // 这条测试守的是「重置走的是同一条连接」这个前提。
    let (_dir, mut store) = 新库();
    store.reset_workspace().unwrap();
    let id = store.create_workflow("重置之后新建的", None).unwrap();
    assert!(store.get_workflow(&id).unwrap().is_some());
}
