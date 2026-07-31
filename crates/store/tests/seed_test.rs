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

// ── sample.v1-fix:老库里带坏脚本的示例工作流 ─────────────────────────────
//
// 模板与生成物早已修好($ISSUE → ${input.issue}),但种子「只种一次」——
// 老工作区里的示例还带着坏脚本,一跑就 `invalid issue format: ""`
// (第 3 轮浏览器实测撞上的就是它)。照 builtins.v1-fix 的先例,
// 用一个修复批次把「从未被用户动过」的旧样例修到新终点。
//
// 这里用独立的 rusqlite 连接伪造「老库」的原始行 ——
// 公共 API 刻意没有这种口子。

const BROKEN_MARKER: &str = r#"view \"$ISSUE\""#;

fn raw(path: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap()
}

fn sample_graph(path: &std::path::Path) -> String {
    raw(path)
        .query_row(
            "SELECT graph_json FROM workflow_revision
             WHERE workflow_id='workflow:sample' ORDER BY rev DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

/// 模拟老种子:rev 1 的脚本还是带引号的 $ISSUE 环境变量形态,
/// 且修复批次「还没跑过」。
fn break_sample(path: &std::path::Path) {
    let conn = raw(path);
    let broken = sample_graph(path).replace("${input.issue}", "\\\"$ISSUE\\\"");
    assert!(broken.contains(BROKEN_MARKER), "前提:构造出了坏形态");
    conn.execute(
        "UPDATE workflow_revision SET graph_json = ?1
         WHERE workflow_id='workflow:sample' AND rev = 1",
        rusqlite::params![broken],
    )
    .unwrap();
    conn.execute("DELETE FROM bootstrap WHERE name = 'sample.v1-fix'", [])
        .unwrap();
}

#[test]
fn 未被动过的坏样例在下次打开时被修好() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    drop(Store::open_workspace(&path).unwrap());
    break_sample(&path);

    drop(Store::open_workspace(&path).unwrap());
    let graph = sample_graph(&path);
    assert!(!graph.contains(BROKEN_MARKER), "坏脚本该被修掉");
    assert!(graph.contains("${input.issue}"), "修到与新种子同一个终点");
}

#[test]
fn 用户编辑过的样例不动_哪怕还带着坏脚本() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    drop(Store::open_workspace(&path).unwrap());
    break_sample(&path);
    // 用户存过一版(rev 2)——不管内容如何,他的东西不能被冲掉
    let broken = sample_graph(&path);
    raw(&path)
        .execute(
            "INSERT INTO workflow_revision (workflow_id, rev, graph_json, updated_at)
             VALUES ('workflow:sample', 2, ?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![broken],
        )
        .unwrap();

    drop(Store::open_workspace(&path).unwrap());
    // 每一版都不许动:只看最高 rev 的话,「只改 rev 1」的越界改动会漏过去
    // (第一版这条测试就是这么假的 —— 元测试抓出来的)
    let untouched: Vec<String> = raw(&path)
        .prepare(
            "SELECT graph_json FROM workflow_revision
             WHERE workflow_id='workflow:sample' ORDER BY rev",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(untouched.len(), 2);
    assert!(
        untouched.iter().all(|graph| graph.contains(BROKEN_MARKER)),
        "编辑过的一版都不许动 —— 用户的东西不能被冲掉"
    );
}

#[test]
fn 用户删掉的样例不复活() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    drop(Store::open_workspace(&path).unwrap());
    {
        let conn = raw(&path);
        conn.execute(
            "DELETE FROM workflow_revision WHERE workflow_id='workflow:sample'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM workflow WHERE id='workflow:sample'", [])
            .unwrap();
        conn.execute("DELETE FROM bootstrap WHERE name = 'sample.v1-fix'", [])
            .unwrap();
    }

    drop(Store::open_workspace(&path).unwrap());
    let count: i64 = raw(&path)
        .query_row(
            "SELECT COUNT(*) FROM workflow WHERE id='workflow:sample'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0, "删掉的不复活");
}

#[test]
fn 内置角色的降级模型不跨_runtime() {
    // 第 5 轮实测 P3:四个内置角色 runtime=codex 而 fallback=model:claude ——
    // 界面下拉按 runtime 过滤后显示「不降级」,引擎也无法把 claude 的
    // 模型 id 交给 codex 的 adapter。降级要么同 runtime,要么就没有
    let (_dir, store) = 新库();
    for id in [
        "builtin:analyst",
        "builtin:builder",
        "builtin:reviewer",
        "builtin:operator",
    ] {
        let agent = store.get_agent(id).unwrap().unwrap();
        let Some(fallback) = agent.fallback_model_ref.clone() else {
            continue;
        };
        let model = store
            .get_model(&fallback)
            .unwrap()
            .unwrap_or_else(|| panic!("{id} 的降级模型 {fallback} 不存在"));
        assert_eq!(
            model.runtime, agent.runtime,
            "{id} 的降级模型跨了 runtime:角色 {} vs 模型 {}",
            agent.runtime, model.runtime
        );
    }
}

#[test]
fn 老库里跨_runtime_的内置降级会被修复批次清掉() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    drop(Store::open_workspace(&path).unwrap());
    {
        // 伪造老库形态:骨干四角色的 fallback 又指回 model:claude,
        // 且修复批次「还没跑过」
        let conn = raw(&path);
        conn.execute(
            "UPDATE agent_profile SET fallback_model_ref = 'model:claude'
             WHERE id LIKE 'builtin:%' AND runtime = 'acp.codex'",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM bootstrap WHERE name = 'builtins.v2-fallback-fix'",
            [],
        )
        .unwrap();
    }

    let store = Store::open_workspace(&path).unwrap();
    let agent = store.get_agent("builtin:analyst").unwrap().unwrap();
    assert_eq!(
        agent.fallback_model_ref, None,
        "跨 runtime 的降级引用要被清成「不降级」"
    );
}

#[test]
fn 用户自己设过的降级不被修复批次动() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    drop(Store::open_workspace(&path).unwrap());
    {
        let conn = raw(&path);
        // 用户把降级改成了一个同 runtime 的模型 —— 不是坏形态,不许动
        conn.execute(
            "UPDATE agent_profile SET fallback_model_ref = 'model:codex'
             WHERE id = 'builtin:analyst'",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM bootstrap WHERE name = 'builtins.v2-fallback-fix'",
            [],
        )
        .unwrap();
    }

    let store = Store::open_workspace(&path).unwrap();
    let agent = store.get_agent("builtin:analyst").unwrap().unwrap();
    assert_eq!(agent.fallback_model_ref.as_deref(), Some("model:codex"));
}
