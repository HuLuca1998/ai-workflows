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
