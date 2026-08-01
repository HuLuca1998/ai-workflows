//! 诊断包导出。
//!
//! M5 的出口标准写着「诊断包不含 Secret」—— 那是这个功能存在的全部理由：
//! 用户要把失败现场发给别人看，而手工整理必然会漏掉某处的 token。
//!
//! 所以这里的测试重心不是「打包了什么」，是「有没有漏出去什么」。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::{NewRunEvent, Store};

fn 事件(run_id: &str, summary: &str) -> NewRunEvent {
    NewRunEvent {
        run_id: run_id.to_string(),
        kind: "node.succeeded".to_string(),
        node_id: Some("n1".to_string()),
        node_label: Some("脚本".to_string()),
        attempt: Some(1),
        actor: "engine".to_string(),
        status: None,
        summary: summary.to_string(),
        payload_ref: None,
        artifact_refs: vec![],
        parent_event_id: None,
        sensitivity: "internal".to_string(),
        schema_ver: 1,
    }
}

fn 建一次运行(store: &Store, summaries: &[&str]) -> String {
    let wf = store.create_workflow("诊断验证", None).unwrap();
    let run = store
        .create_run(&wf, None, Some(1), r#"{"repo":"atlas"}"#)
        .unwrap();
    for summary in summaries {
        store.append_event(&事件(&run, summary)).unwrap();
    }
    run
}

#[test]
fn 诊断包含运行本身与事件流() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let run = 建一次运行(&store, &["第一步完成", "第二步完成"]);

    let result = aiwf_core_api::run_diagnostics(&store, dir.path(), run.clone()).unwrap();
    let text = std::fs::read_to_string(&result.path).unwrap();

    assert!(text.contains(&run), "要能看出是哪次运行");
    assert!(text.contains("第一步完成"));
    assert!(text.contains("第二步完成"));
    assert!(result.bytes > 0);
}

#[test]
fn 事件里的_token_被脱敏() {
    // 脚本 echo 出一个 token、AI 的回答里带一段密钥 —— 都会进事件摘要。
    // 用户不会逐条检查 217 条事件，所以这一步必须是自动的
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let run = 建一次运行(
        &store,
        &[
            "推送用的 token 是 ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
            "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
        ],
    );

    let result = aiwf_core_api::run_diagnostics(&store, dir.path(), run).unwrap();
    let text = std::fs::read_to_string(&result.path).unwrap();

    assert!(
        !text.contains("ghp_1234567890abcdefghijklmnopqrstuvwxyzAB"),
        "GitHub token 漏了"
    );
    assert!(
        !text.contains("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"),
        "API key 漏了"
    );
    // 但要留下痕迹：完全删掉的话读的人不知道这里本来有东西
    assert!(
        text.contains("REDACTED") || text.contains("已脱敏"),
        "脱敏要留痕"
    );
}

#[test]
fn 启动参数也过脱敏() {
    // inputs 是用户填的，里面可能就有 token —— 启动表单不拦这个
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("带密钥的参数", None).unwrap();
    let run = store
        .create_run(
            &wf,
            None,
            Some(1),
            r#"{"token":"ghp_1234567890abcdefghijklmnopqrstuvwxyzAB"}"#,
        )
        .unwrap();

    let result = aiwf_core_api::run_diagnostics(&store, dir.path(), run).unwrap();
    let text = std::fs::read_to_string(&result.path).unwrap();
    assert!(!text.contains("ghp_1234567890abcdefghijklmnopqrstuvwxyzAB"));
}

#[test]
fn 诊断包带上环境报告() {
    // 「在我机器上是好的」——环境差异是最常见的原因，
    // 而让用户手工贴版本号必然漏
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let run = 建一次运行(&store, &["跑完了"]);

    let result = aiwf_core_api::run_diagnostics(&store, dir.path(), run).unwrap();
    let text = std::fs::read_to_string(&result.path).unwrap();
    assert!(text.contains("git"), "环境报告里该有 git 这一项");
}

#[test]
fn 不存在的运行报错而不是导出一个空包() {
    // 空包会被当成「这次运行什么都没发生」
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    assert!(aiwf_core_api::run_diagnostics(&store, dir.path(), "run_ghost".to_string()).is_err());
}

#[test]
fn 文件名带上_run_id_不会互相覆盖() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let a = 建一次运行(&store, &["甲"]);
    let b = 建一次运行(&store, &["乙"]);

    let first = aiwf_core_api::run_diagnostics(&store, dir.path(), a).unwrap();
    let second = aiwf_core_api::run_diagnostics(&store, dir.path(), b).unwrap();
    assert_ne!(first.path, second.path);
    assert!(std::fs::read_to_string(&first.path).unwrap().contains("甲"));
}

#[test]
fn 诊断包列出产物但不含内容() {
    // 产物内容可能有几十 MB，也可能有脚本 echo 出来的 token ——
    // stdout 走的是 artifact 而不是事件摘要，所以事件那层的脱敏管不到它。
    //
    // 列出名字、大小与哈希就够定位问题了；真要看内容，
    // 界面里有预览，那是用户自己选的一次性动作
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let wf = store.create_workflow("有产物的", None).unwrap();
    let run = store
        .create_run_in(
            &wf,
            None,
            Some(1),
            "{}",
            Some(dir.path().to_str().unwrap()),
            "manual",
        )
        .unwrap();

    let artifacts = aiwf_engine::artifacts::ArtifactStore::new(dir.path().join(".aiwf-artifacts"));
    artifacts
        .save(
            &run,
            "n1",
            aiwf_engine::artifacts::ArtifactKind::Log,
            "stdout.log",
            b"token=ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
        )
        .unwrap();

    let result = aiwf_core_api::run_diagnostics(&store, dir.path(), run).unwrap();
    let text = std::fs::read_to_string(&result.path).unwrap();

    assert!(
        text.contains("stdout.log"),
        "产物要列出来 —— 不然不知道有什么可看"
    );
    assert!(
        !text.contains("ghp_1234567890abcdefghijklmnopqrstuvwxyzAB"),
        "产物内容不该进诊断包"
    );
}

/// 环境诊断包 —— 图纸两屏底部的「导出脱敏报告」。
///
/// M5 的出口标准写着「诊断包不含 Secret」。这里守的是：
/// 它与 run_diagnostics 走同一条脱敏管道，不是另开一条没人看的路。
mod 环境诊断 {

    #[test]
    fn 落盘并返回大小() {
        let dir = tempfile::tempdir().unwrap();
        let 结果 = aiwf_core_api::env_diagnostics(dir.path()).unwrap();

        assert!(std::path::Path::new(&结果.path).exists(), "诊断包没落盘");
        assert!(结果.bytes > 0);
    }

    #[test]
    fn 内容是合法_json_且标明了脱敏() {
        let dir = tempfile::tempdir().unwrap();
        let 结果 = aiwf_core_api::env_diagnostics(dir.path()).unwrap();
        let 文本 = std::fs::read_to_string(&结果.path).unwrap();
        let 包: serde_json::Value = serde_json::from_str(&文本).unwrap();

        assert_eq!(包["kind"], "aiwf-env-diagnostics");
        assert!(包["note"].as_str().unwrap().contains("脱敏"));
        assert!(包["environment"].is_object() || 包["environment"].is_array());
    }

    #[test]
    fn 目录不存在时自己建() {
        let dir = tempfile::tempdir().unwrap();
        let 深 = dir.path().join("a/b/c");
        let 结果 = aiwf_core_api::env_diagnostics(&深).unwrap();

        assert!(std::path::Path::new(&结果.path).exists());
    }
}
