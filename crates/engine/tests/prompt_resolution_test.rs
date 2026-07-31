//! B-3：提示词库接上执行路径。
//!
//! 此前整屏「提示词库」做得很细（分段、版本、变量表），而 `run_ai`
//! 从不读 `promptId` —— 契约说「留空则用该节点类型的内建提示词」，
//! 暗示「填了就用填的那个」，实际填了也不用。出口标准
//! 「提示词与模型在运行记录中可追溯到具体版本」只兑现了模型那一半。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::runner::{RunRequest, Runner};
use aiwf_store::Store;

fn flow_with_prompt(prompt_id: Option<&str>) -> String {
    let mut config = serde_json::json!({
        "agentProfileId": "",
        "instruction": "分析这段材料",
        "target": "材料正文",
    });
    if let Some(id) = prompt_id {
        config["promptId"] = serde_json::json!(id);
    }
    serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ai", "type": "ai.analyze", "title": "分析", "config": config}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "ai", "port": "input"}}
        ],
        "groups": []
    })
    .to_string()
}

/// 起一个假 adapter（/usr/bin/false）：提示词解析发生在拉起 adapter 之前，
/// 节点最终失败不影响「解析事件已经写下」这个断言 ——
/// 真 adapter 会连上开发机的登录态与配额（CLAUDE.md 明令禁止）。
fn run_flow(store: &Store, graph: &str) -> String {
    let workdir = std::env::temp_dir().join("aiwf_prompt_res_test");
    std::fs::create_dir_all(&workdir).unwrap();
    store
        .set_workspace_setting("permissionPreset", "human_approval")
        .unwrap();
    let workflow = store
        .create_workflow_with_graph("提示词解析", None, graph)
        .unwrap();
    let runner = Runner::new().with_acp_command("/usr/bin/false", &[]);
    let run_id = runner
        .start(
            store,
            RunRequest {
                workflow_id: workflow,
                version_id: None,
                draft_rev: Some(0),
                inputs_json: "{}".to_string(),
                workdir: workdir.display().to_string(),
            },
        )
        .unwrap();
    let _ = runner.run_all(store, &run_id).unwrap();
    run_id
}

#[test]
fn 指定提示词时_事件流能读到用的是哪一版() {
    let store = Store::open_in_memory().unwrap();
    let prompt_id = store
        .create_prompt(&aiwf_store::NewPrompt {
            group: "analysis".to_string(),
            name: "我的分析框架".to_string(),
            sections_json: serde_json::json!([
                {"title": "Role", "body": "你是资深故障分析师"},
                {"title": "Constraints", "body": "只引用给到的材料"}
            ])
            .to_string(),
            vars_json: "[]".to_string(),
        })
        .unwrap();

    let run_id = run_flow(&store, &flow_with_prompt(Some(&prompt_id)));
    let events = store.events(&run_id, 0, 200).unwrap();
    let resolved = events
        .iter()
        .find(|e| e.kind == "system.prompt_resolved")
        .expect("要有 system.prompt_resolved 事件");
    assert!(
        resolved.summary.contains("我的分析框架") && resolved.summary.contains("v1"),
        "要说清用了哪条提示词的哪一版：{}",
        resolved.summary
    );

    // 库里的分段真的进了发给 agent 的提示词(prompt.md 产物)
    let workdir = std::env::temp_dir().join("aiwf_prompt_res_test");
    let prompt_md = workdir
        .join(".aiwf-artifacts")
        .join(&run_id)
        .join("ai")
        .join("prompt.md");
    let content = std::fs::read_to_string(&prompt_md).expect("prompt.md 产物要存在");
    assert!(
        content.contains("你是资深故障分析师"),
        "库里的分段要进提示词：{content}"
    );
}

#[test]
fn 不指定提示词时_事件写明用的是内建框架() {
    let store = Store::open_in_memory().unwrap();
    let run_id = run_flow(&store, &flow_with_prompt(None));
    let events = store.events(&run_id, 0, 200).unwrap();
    let resolved = events
        .iter()
        .find(|e| e.kind == "system.prompt_resolved")
        .expect("内建框架也要留痕 —— 可追溯不能只对库里的成立");
    assert!(
        resolved.summary.contains("内建"),
        "要说明用的是内建框架：{}",
        resolved.summary
    );
}

#[test]
fn 指向不存在的提示词_节点明确失败() {
    let store = Store::open_in_memory().unwrap();
    let run_id = run_flow(&store, &flow_with_prompt(Some("prompt_不存在")));
    let events = store.events(&run_id, 0, 200).unwrap();
    let failed = events
        .iter()
        .find(|e| e.kind == "node.failed")
        .expect("幽灵引用必须失败,不能静默退回内建");
    assert!(
        failed.summary.contains("提示词"),
        "失败原因要说清是提示词引用：{}",
        failed.summary
    );
}
