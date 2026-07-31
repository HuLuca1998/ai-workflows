//! 产物预览的脱敏。
//!
//! 事件流底部常驻一句：「Secret 值在写入事件存储前已脱敏，
//! **界面不提供绕过查看**」。而产物就在隔壁那个 tab，每条都有「预览」按钮。
//!
//! 第 5 轮实测：脚本 `echo "token=sk-…"` 之后打开产物预览，
//! 拿到的是**一字未改的明文**。事件流脱敏了、启动参数写入时脱敏了、
//! 诊断包脱敏了 —— 只有这条路径没有，而它恰好是最容易被截图与录屏的那个。
//!
//! 磁盘上的文件保持原样（那是脚本的真实输出，用户要调试就去那儿看，
//! 路径界面上就显示着）。这里管的是**界面这一层**。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

const 密钥: &str = "sk-TESTLEAK-1234567890abcdefghijklmnopqrstuvwxyz";

/// 建一个运行，并在它的产物目录里放一个含密钥的文件。
fn 造一份产物(store: &Store, dir: &std::path::Path, 内容: &str) -> String {
    let wf = store.create_workflow("产物脱敏验证", None).unwrap();
    let run = store
        .create_run_in(&wf, None, Some(1), "{}", Some(&dir.display().to_string()))
        .unwrap();

    let 产物目录 = dir.join(".aiwf-artifacts").join(&run);
    std::fs::create_dir_all(&产物目录).unwrap();
    std::fs::write(产物目录.join("stdout.log"), 内容).unwrap();
    run
}

#[test]
fn 产物预览不把明文密钥送到界面() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let run = 造一份产物(
        &store,
        dir.path(),
        &format!("token={密钥}\nAWS_SECRET_ACCESS_KEY=TESTLEAKaws1234567890\ndone\n"),
    );

    let content =
        aiwf_core_api::run_artifact_content(&store, run, "stdout.log".to_string(), None).unwrap();
    // 按界面实际拿到的形状看：DTO 的字段是私有的，序列化后的 JSON 才是出口
    let text = serde_json::to_string(&content).unwrap();

    assert!(
        !text.contains(密钥),
        "产物预览把明文密钥送到了界面：\n{text}\n\
         事件流底部承诺「界面不提供绕过查看」，产物预览就在隔壁 tab"
    );
    assert!(
        text.contains("done"),
        "脱敏不该把正常内容也吃掉，实际拿到：\n{text}"
    );
}

#[test]
fn 不含密钥的产物原样返回() {
    // 脱敏器不能把普通日志改得面目全非 —— 那样用户会以为产物坏了
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let 原文 = "正在编译 aiwf-engine\n测试 12/12 通过\n耗时 4m18s\n";
    let run = 造一份产物(&store, dir.path(), 原文);

    let content =
        aiwf_core_api::run_artifact_content(&store, run, "stdout.log".to_string(), None).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&content).unwrap()).unwrap();
    assert_eq!(json["text"].as_str().unwrap_or_default(), 原文);
}

/// 登记过的密钥在**读取点**也要被挡住。
///
/// 「已知明文」那条路接上时只覆盖了事件写入口（`emit_full`）。
/// 三个读取点 —— 产物内容、运行诊断包、环境诊断包 —— 每处都是
/// `Redactor::with_defaults()` 新建一个，而它的 `literals` 是空的：
/// `register_secret` 登记过的东西它一个都不知道。
///
/// 最刺眼的是诊断包：它自己写着「所有文本已过脱敏器；Secret 只以
/// keychain:// 引用形式出现」—— 而诊断包正是用户会主动发给别人的那一份。
mod 读取点也要用共享脱敏器 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    #[test]
    fn 没有固定形态的密钥在诊断包里也被挡住() {
        // 一串纯随机字母 —— 任何形态规则都认不出，只有登记过才挡得住
        let 口令 = "Zt7qWm3xLp9bKv2rNh5dGc8fJa4sYe6u";
        aiwf_engine::redactor::register_secret(口令);

        let 脱敏后 = aiwf_engine::redactor::redact_shared(&format!("连接串：user:{口令}@db"));

        assert!(
            !脱敏后.contains(口令),
            "登记过的口令没被挡住 —— 而诊断包会被用户直接发给别人：{脱敏后}"
        );
    }

    #[test]
    fn 生产代码里不再各自新建脱敏器() {
        // 新建一个就等于把 register_secret 登记的那半边丢掉。
        // 门禁盯着这件事：下一处 `with_defaults()` 加进来时它会红
        let 源码 = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("读得到 core-api 的源码");

        assert!(
            !源码.contains("Redactor::with_defaults()"),
            "core-api 里还有地方自己新建脱敏器 —— 那一处拿不到登记过的密钥"
        );
    }
}

#[allow(clippy::unwrap_used, clippy::expect_used)]
mod 事件流读取脱敏 {
    use aiwf_store::{NewRunEvent, Store};

    #[test]
    fn 历史事件里的明文密钥在读取时被挡住_第9轮实测() {
        // 写入前脱敏(emit_full)会漏掉规则加进来之前写下的历史事件。
        // 读取路径再兜一道 —— 页脚承诺「界面不提供绕过查看」
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("aiwf.sqlite");
        let store = Store::open(&db).unwrap();
        let wf = store.create_workflow("测试", None).unwrap();
        let run = store.create_run_for_test(&wf).unwrap();
        // 直接写一条带明文 sec- 密钥的事件(绕过 emit_full,模拟历史数据)
        store
            .append_event(&NewRunEvent {
                run_id: run.clone(),
                kind: "conversation.agent_message".to_string(),
                node_id: None,
                node_label: None,
                attempt: None,
                actor: "agent".to_string(),
                status: None,
                summary: "502: url https://x/sec-T00LEAKabcdef1234567890/v1".to_string(),
                payload_ref: None,
                artifact_refs: vec![],
                parent_event_id: None,
                sensitivity: "internal".to_string(),
                schema_ver: 1,
            })
            .unwrap();

        let store2 = std::sync::Mutex::new(Store::open(&db).unwrap());
        let supervisor = aiwf_engine::supervisor::Supervisor::new(db.clone());
        let page = aiwf_core_api::dispatch::dispatch(
            "run_events",
            &serde_json::json!({"runId": run, "fromSeq": 0, "limit": 50}),
            &store2,
            &supervisor,
            dir.path(),
        )
        .unwrap();
        let json = serde_json::to_string(&page).unwrap();
        assert!(
            !json.contains("sec-T00LEAKabcdef1234567890"),
            "读取路径要挡住历史明文:{json}"
        );
    }
}
