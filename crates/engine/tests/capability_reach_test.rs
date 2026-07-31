//! 能力声明说给了谁听。
//!
//! 上一版这里守的是 `check_capability` —— 那个函数的每一支都从
//! `profile_for(node)` 取能力，而 `profile_for` 只认 config 里的
//! `agentProfileId`。给一个**没有这个字段**的节点类型写分支，
//! 那一支永远匹配不到：代码看着有一道防线，运行时一次都不会经过。
//!
//! `check_capability` 已经撤了（权限由流程管，见 `risk.rs` 头部），
//! 但**同一种坏法换个地方还会长出来**：现在是 `capability_note`
//! 把角色声明的边界拼进提示词，它同样只对挂得上角色的节点有效。
//!
//! 这条守卫盯的就是那件事：**契约说某个节点类型挂得上角色，
//! 那它就必须真的拿得到那段边界说明**。拿不到的话，用户在角色页上
//! 逐项设过的东西一个字都不会到模型面前，而界面上什么都不会说。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use aiwf_engine::executor::{AgentProfile, NodeExecutor};
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::Scope;

const NODE_CONFIGS: &str =
    include_str!("../../../packages/contracts/generated/node-configs.schema.json");

/// 契约里声明了 `agentProfileId` 的节点类型 —— 只有它们挂得上角色。
fn 挂得上角色的() -> BTreeSet<String> {
    let spec: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(NODE_CONFIGS).expect("node-configs.schema.json");
    spec.into_iter()
        .filter(|(_, schema)| {
            schema
                .get("properties")
                .and_then(|p| p.get("agentProfileId"))
                .is_some()
        })
        .map(|(node_type, _)| node_type)
        .collect()
}

fn mock_acp() -> (String, Vec<String>) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    (
        "node".to_string(),
        vec![script.display().to_string(), "echo-prompt".to_string()],
    )
}

fn 角色() -> AgentProfile {
    AgentProfile {
        id: "ap_reach".to_string(),
        name: "执行者".to_string(),
        role: "执行".to_string(),
        goal: String::new(),
        persona: String::new(),
        runtime: "acp.codex".to_string(),
        model_ref: "model:codex".to_string(),
        output_contract: String::new(),
        capabilities_json:
            r#"{"file":"read","command":"declared","network":"none","memory":"read","secret":[]}"#
                .to_string(),
        timeout_ms: 900_000,
    }
}

/// 每种 AI 节点跑起来至少要哪些配置字段。
fn 最小配置(node_type: &str) -> serde_json::Value {
    let mut config = serde_json::json!({
        "agentProfileId": "ap_reach",
        "instruction": "做点什么",
    });
    // analyze / review 的 target 是必填
    if matches!(node_type, "ai.analyze" | "ai.review") {
        config["target"] = serde_json::json!("一段材料");
    }
    if node_type == "ai.execute" {
        config["workdirSource"] = serde_json::json!("inherit");
    }
    config
}

#[test]
fn 挂得上角色的节点都真的拿得到那段边界说明() {
    // 契约声明 `agentProfileId` 的每一种，都要真的把角色的能力
    // 拼进提示词。少一种的话，用户在角色页上设的东西对那种节点无效，
    // 而没有任何一处会告诉他
    let (command, args) = mock_acp();
    let 类型 = 挂得上角色的();
    assert!(!类型.is_empty(), "契约里一个挂得上角色的节点都没有？");

    for node_type in &类型 {
        let node = GraphNode {
            id: "n".to_string(),
            node_type: node_type.clone(),
            title: "节点".to_string(),
            config: 最小配置(node_type),
            join: None,
        };

        let dir = std::env::temp_dir().join("aiwf_reach");
        std::fs::create_dir_all(&dir).unwrap();
        let executor = NodeExecutor::new(dir)
            .with_acp_command(&command, &args)
            .with_agent_profiles(&[角色()]);

        let mut scope = Scope::new("run_reach");
        executor.execute(&node, &mut scope).unwrap();

        // echo-prompt 把收到的提示词原样回显，落在 scope 的输出里
        let snapshot = scope.snapshot();
        let 提示词 = snapshot["outputs"]
            .as_object()
            .and_then(|o| o.values().next())
            .and_then(|v| v["text"].as_str())
            .unwrap_or_default()
            .to_string();

        assert!(
            提示词.contains("文件 read") && 提示词.contains("命令 declared"),
            "{node_type} 挂得上角色，却没把角色声明的边界拼进提示词 —— \
             用户在角色页上设的东西对它无效：\n{提示词}"
        );
    }
}

#[test]
fn 挂不上角色的节点不会凭空得到一段边界() {
    // 反过来那半句。给一个没有 agentProfileId 字段的节点类型
    // 塞一段边界说明的话，那段话只会误导 —— 它压根没有 agent 在读
    let dir = std::env::temp_dir().join("aiwf_reach2");
    std::fs::create_dir_all(&dir).unwrap();
    let executor = NodeExecutor::new(dir.clone()).with_agent_profiles(&[角色()]);

    let 脚本 = GraphNode {
        id: "s".to_string(),
        node_type: "script.shell".to_string(),
        title: "脚本".to_string(),
        // 契约里脚本节点没有 agentProfileId —— 塞进去也会被 Zod strip 掉。
        // 这里直接塞是为了验证「就算塞了也不生效」
        config: serde_json::json!({
            "interpreter": "bash",
            "script": "echo hi",
            "agentProfileId": "ap_reach",
            "timeoutMs": 5000,
        }),
        join: None,
    };

    let mut scope = Scope::new("run_reach2");
    let outcome = executor.execute(&脚本, &mut scope).unwrap();

    // 脚本照跑 —— 能力声明对它没有任何影响，那正是要确认的
    assert!(
        matches!(
            &outcome,
            aiwf_engine::runner::NodeOutcome::Succeeded { port } if port == "success"
        ),
        "{outcome:?}"
    );
}
