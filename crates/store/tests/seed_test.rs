//! 首次启动的内置数据。
//!
//! 走 `Store::open_workspace` —— 应用入口用的就是这一条。
//! `Store::open` 只做迁移，不种数据（存储层自己的测试用那一条）。
//!
//! 没有它，一个刚装好的应用是**空的**：没有模型、没有 Agent 角色、
//! 没有提示词，于是内置模板里的 `agentProfileId: "builtin:analyst"`
//! 指向不存在的东西 —— 用户拖出一条工作流，Dry Run 才告诉他
//! 「角色不存在」，而他根本没机会知道该去建哪些角色。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

fn 新库() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_workspace(&dir.path().join("aiwf.sqlite")).unwrap();
    (dir, store)
}

#[test]
fn 首次打开模型页不是空白_但示例是停用的() {
    // AI 节点没有模型条目照样跑（引擎按「没配」处理，agent 用自己的默认）。
    // 种子的用处是让模型页有个能看的样例 —— 但它们的 model_id 是
    // 两端 adapter 都不认的示例值，必须停用：启用着的话，
    // 引用它们的每个 AI 节点每次运行都报一条 model_downgraded
    let (_dir, store) = 新库();
    let (models, _) = store.list_models_paged(false, None, 50, 0).unwrap();

    assert!(!models.is_empty(), "模型页首次打开是空白页");
    // 两个 ACP 运行时各一条 —— 只装了其中一个的机器也有参照
    let runtimes: Vec<&str> = models.iter().map(|m| m.runtime.as_str()).collect();
    assert!(runtimes.contains(&"acp.codex"), "{runtimes:?}");
    assert!(runtimes.contains(&"acp.claude"), "{runtimes:?}");
    assert!(
        models.iter().all(|m| !m.enabled),
        "示例条目启用着 —— 默认装机每次运行都会报降级"
    );
}

#[test]
fn 内置模型的凭据是引用_不是明文() {
    let (_dir, store) = 新库();
    for model in store.list_models_paged(false, None, 50, 0).unwrap().0 {
        if let Some(cred) = model.credential_ref {
            assert!(
                cred.starts_with("keychain://"),
                "{} 的凭据不是引用：{cred}",
                model.name
            );
        }
    }
}

#[test]
fn 内置模板引用的四个角色都在() {
    // 模板里写死了这四个 id。它们不存在的话，模板搭出来的工作流
    // 在 Dry Run 才报错 —— 而那时用户已经以为自己搭好了
    let (_dir, store) = 新库();
    let (agents, _) = store.list_agents_paged(None, 50, 0).unwrap();
    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();

    for id in [
        "builtin:analyst",
        "builtin:builder",
        "builtin:reviewer",
        "builtin:operator",
    ] {
        assert!(ids.contains(&id), "缺内置角色 {id}，现有：{ids:?}");
    }
}

#[test]
fn 内置角色不可删只可复制() {
    let (_dir, store) = 新库();
    let 结果 = store.delete_agent("builtin:analyst");
    assert!(结果.is_err(), "内置角色被删掉了，模板就再也搭不出来");
}

#[test]
fn 内置角色指向真实存在的模型() {
    // 指向一个不存在的模型 id，症状是 AI 节点跑到一半才失败
    let (_dir, store) = 新库();
    let (models, _) = store.list_models_paged(false, None, 50, 0).unwrap();
    let model_ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();

    for agent in store.list_agents_paged(None, 50, 0).unwrap().0 {
        assert!(
            model_ids.contains(&agent.model_ref.as_str()),
            "{} 指向的模型 {} 不存在",
            agent.name,
            agent.model_ref
        );
    }
}

#[test]
fn 内置角色的能力是收紧的_不是全开() {
    // 「权限（引擎强制，Prompt 无法越权）」——内置角色如果一上来
    // 就是 file: read-write + command: any，那句话就没有意义了
    let (_dir, store) = 新库();
    let 审查者 = store
        .get_agent("builtin:reviewer")
        .unwrap()
        .expect("审查者该在");

    let caps: serde_json::Value = serde_json::from_str(&审查者.capabilities_json).unwrap();
    assert_eq!(caps["file"], serde_json::json!("read"), "审查是只读的");
    assert_eq!(
        caps["command"],
        serde_json::json!("none"),
        "审查不该能执行命令"
    );
}

#[test]
fn 提示词库不是空的() {
    let (_dir, store) = 新库();
    let (prompts, _) = store.list_prompts_paged(None, None, 50, 0).unwrap();
    assert!(!prompts.is_empty());
    // 分段是有序数组，不是一坨文本 —— 图纸「06 提示词库」按分段渲染
    let first = &prompts[0];
    let sections: serde_json::Value = serde_json::from_str(&first.sections_json).unwrap();
    assert!(
        sections.is_array(),
        "分段必须是数组：{}",
        first.sections_json
    );
    assert!(!sections.as_array().unwrap().is_empty());
}

#[test]
fn 内置记忆解释了这个工作区的约定() {
    let (_dir, store) = 新库();
    let (memories, _) = store.list_memories_paged(None, None, 50, 0).unwrap();
    assert!(
        !memories.is_empty(),
        "记忆表是空的话，AI 节点没有任何长期上下文"
    );
    for memory in &memories {
        assert!(memory.enabled, "内置记忆默认要启用，否则等于没有");
        assert!(!memory.value.trim().is_empty());
    }
}

#[test]
fn 重复打开不会种第二份() {
    // 每次启动都插一遍的话，用了一个月之后模型下拉里会有三十条一样的
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");

    let 第一次 = {
        let store = Store::open_workspace(&path).unwrap();
        (
            store.list_models_paged(false, None, 99, 0).unwrap().1,
            store.list_agents_paged(None, 99, 0).unwrap().1,
            store.list_prompts_paged(None, None, 99, 0).unwrap().1,
            store.list_memories_paged(None, None, 99, 0).unwrap().1,
        )
    };

    for _ in 0..3 {
        let store = Store::open_workspace(&path).unwrap();
        let 现在 = (
            store.list_models_paged(false, None, 99, 0).unwrap().1,
            store.list_agents_paged(None, 99, 0).unwrap().1,
            store.list_prompts_paged(None, None, 99, 0).unwrap().1,
            store.list_memories_paged(None, None, 99, 0).unwrap().1,
        );
        assert_eq!(现在, 第一次, "重开一次就多种了一份");
    }
}

#[test]
fn 用户改过的内置条目不会被种子覆盖回去() {
    // 「内置」不等于「只读」：图纸说内置角色可以复制、可以改。
    // 每次启动把它改回去的话，用户的改动会在下次重启时静默消失
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");

    {
        let store = Store::open_workspace(&path).unwrap();
        let 角色 = store.get_agent("builtin:analyst").unwrap().unwrap();
        store
            .update_agent(
                "builtin:analyst",
                角色.ver,
                &aiwf_store::AgentPatch {
                    goal: Some("我自己改的目标"),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    let store = Store::open_workspace(&path).unwrap();
    let 角色 = store.get_agent("builtin:analyst").unwrap().unwrap();
    assert_eq!(角色.goal, "我自己改的目标", "重启把用户的改动冲掉了");
}

#[test]
fn 用户删掉的内置记忆不会自己长回来() {
    // 记忆会被注入每一次 AI 调用。用户明确停用或删掉了一条，
    // 它下次启动又出现，等于这个开关是假的
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");

    let id = {
        let store = Store::open_workspace(&path).unwrap();
        let first = store.list_memories_paged(None, None, 1, 0).unwrap().0[0]
            .id
            .clone();
        store.delete_memory(&first).unwrap();
        first
    };

    let store = Store::open_workspace(&path).unwrap();
    let 还在 = store
        .list_memories_paged(None, None, 99, 0)
        .unwrap()
        .0
        .iter()
        .any(|m| m.id == id);
    assert!(!还在, "删掉的记忆又长回来了");
}
