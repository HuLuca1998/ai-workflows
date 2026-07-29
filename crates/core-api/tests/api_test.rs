/// 「回到最近审批点改选择」—— 图纸失败横幅的第二个按钮。
mod 回到审批点 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_store::Store;

    fn 库() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn 没有审批点时说清原因_而不是静默什么都不做() {
        let store = 库();
        let wf = store.create_workflow("测试", None).unwrap();
        let run = store.create_run_for_test(&wf).unwrap();

        let 结果 = aiwf_core_api::run_rewind_to_approval(&store, run);
        let 错 = 结果.expect_err("没审批过却成功了");
        assert!(
            错.message.contains("没有"),
            "错误信息要说清为什么，实际：{}",
            错.message
        );
    }

    #[test]
    fn 找不到运行时报错() {
        let store = 库();
        let 结果 = aiwf_core_api::run_rewind_to_approval(&store, "run_不存在".to_string());
        assert!(结果.is_err());
    }

    #[test]
    fn 有审批点时新开一条运行_原来那条留着() {
        let store = 库();
        let wf = store.create_workflow("测试", None).unwrap();
        let run = store.create_run_for_test(&wf).unwrap();
        store
            .save_checkpoint(&run, 4, "{}", Some(r#"{"nodeId":"approve_1"}"#))
            .unwrap();

        let 结果 = aiwf_core_api::run_rewind_to_approval(&store, run.clone()).unwrap();

        assert_eq!(结果.node_id, "approve_1");
        assert_ne!(结果.run_id, run, "应该是一条新运行");
        // 原来那条留在记录里：两次的事件流可以对照着看，这正是可解释性要的
        assert!(store.get_run(&run).unwrap().is_some(), "原运行被删了");
    }
}

/// 模型连通性测试 —— 图纸「07 模型」的「测试连通性」按钮。
///
/// ROADMAP 把它留给 M5「和环境健康中心一起做，共用同一套探测逻辑」——
/// 它们确实共用：都是启动 adapter 握手，区别只是这里还要量时间。
mod 模型连通性 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_core_api::probe_runtime;
    use aiwf_store::{NewModel, Store};

    fn 模型(store: &Store, runtime: &str) -> String {
        store
            .create_model(&NewModel {
                name: "测试模型".to_string(),
                runtime: runtime.to_string(),
                model_id: "test".to_string(),
                effort: "medium".to_string(),
                context_window: 200_000,
                capabilities: vec![],
                credential_ref: None,
                enabled: true,
            })
            .unwrap()
    }

    #[test]
    fn 找不到模型时报错() {
        let store = Store::open_in_memory().unwrap();
        assert!(aiwf_core_api::model_test(&store, "model_不存在".to_string()).is_err());
    }

    #[test]
    fn adapter_没装时不算报错_而是给出可照做的说明() {
        // 这是最常见的情况，用户需要的是「装什么」，不是一个红色的异常。
        //
        // 「没装」这个条件由测试自己造，不靠跑测试的机器上恰好没装 ——
        // 这条原先就是那么写的，于是开发机一装上 adapter 它就变成
        // 真的去握手（起一个 codex 进程，最长 30 秒），而要断言的那句话
        // 反而再也走不到
        let 话 = probe_runtime("acp.codex", |_| None, |_| panic!("没装就不该去探测"))
            .expect_err("adapter 没装却报告成功");

        assert!(话.contains("adapter"), "没说清是 adapter 的问题：{话}");
        assert!(话.contains("设置与环境"), "没说去哪儿看怎么装：{话}");
    }

    #[test]
    fn adapter_装了就把它交给探测() {
        let 结果 = probe_runtime(
            "acp.codex",
            |_| Some("/somewhere/codex-acp".to_string()),
            |command| Ok(format!("探测用的是 {command}")),
        );
        assert_eq!(结果.unwrap(), "探测用的是 /somewhere/codex-acp");
    }

    #[test]
    fn 非_acp_运行时也给得出说明() {
        let store = Store::open_in_memory().unwrap();
        // provider.api 是合法的接入方式，但不是 ACP —— 连通性测试只支持 ACP
        let id = 模型(&store, "provider.api");

        let 结果 = aiwf_core_api::model_test(&store, id).unwrap();
        assert!(!结果.ok);
        assert!(!结果.detail.is_empty());
    }

    #[test]
    fn 测过之后延迟写回模型行() {
        // 图纸的凭据卡里有一行「延迟 · 1.4s（最近一次测试）」。
        //
        // 用 provider.api：它在第一道分支就被挡下，测的是「失败也记延迟」，
        // 而不用去起一个真的 adapter 进程
        let store = Store::open_in_memory().unwrap();
        let id = 模型(&store, "provider.api");

        let _ = aiwf_core_api::model_test(&store, id.clone()).unwrap();
        let 模型行 = store.get_model(&id).unwrap().unwrap();

        // 失败也记：那同样是「最近一次测试」的结果
        assert!(模型行.last_latency_ms.is_some(), "没记下延迟");
    }
}

/// 错误里的「接下来该干什么」。
///
/// 第 5 轮审查 B1（第 11 条）：契约的错误对象是
/// `{code, message, retriable, hint}`，而 Rust 的 `ApiError` 只有前三个 ——
/// hint 从来没被填过，`normalizeIpcError` 那一层再丢一次。
/// 于是用户看到的永远只有「出了什么事」，没有「接下来怎么办」。
mod 错误要说下一步 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_store::Store;

    #[test]
    fn 找不到工作流时告诉用户去哪儿找() {
        let store = Store::open_in_memory().unwrap();
        // WorkflowDetail 没有 Debug，unwrap_err 用不了
        let err = match aiwf_core_api::workflow_get(&store, "wf_不存在".to_string()) {
            Err(e) => e,
            Ok(_) => panic!("不存在的工作流居然读到了"),
        };

        assert!(err.hint.is_some(), "没给下一步提示");
        let hint = err.hint.unwrap();
        assert!(
            hint.contains("列表") || hint.contains("首页"),
            "提示要能照着做，实际：{hint}"
        );
    }

    #[test]
    fn 版本冲突时说清怎么解() {
        let store = Store::open_in_memory().unwrap();
        let wf = store.create_workflow("测试", None).unwrap();
        // 用错的 baseRev 触发冲突
        let err = aiwf_core_api::workflow_save_draft(
            &store,
            wf,
            99,
            r#"{"nodes":[],"edges":[],"groups":[]}"#.to_string(),
        );
        let err = match err {
            Err(e) => e,
            Ok(_) => panic!("错的 baseRev 居然存进去了"),
        };

        assert_eq!(err.code, "REVISION_CONFLICT");
        assert!(
            err.hint.is_some(),
            "冲突是最需要提示的一类 —— 用户不知道该怎么办"
        );
    }

    #[test]
    fn 没有提示时字段缺席_而不是空串() {
        // 空串会让界面显示一个「（）」的空括号
        let err = aiwf_core_api::ApiError::validation("就是不合法".to_string());
        assert!(err.hint.is_none() || !err.hint.as_deref().unwrap_or("").is_empty());
    }
}

/// 错误响应不能手拼字段。
///
/// devserver 曾经手写 `json!({code, message, retriable})` —— 漏了 hint，
/// 于是「接下来该干什么」在引擎里填好了却到不了界面。
/// 契约加一个错误字段时，同样的事会再发生一次。
#[test]
#[allow(clippy::expect_used)]
fn 错误响应整体序列化_不手拼字段() {
    let 源 = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../devserver/src/main.rs"),
    )
    .expect("读得到 devserver 源码");

    // 去掉注释再找：解释「为什么不该手拼」的文字里必然提到那几个字段
    let 无注释: String = 源
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        !无注释.contains("\"retriable\": error.retriable"),
        "错误响应在手拼字段。改用 serde_json::to_value(&error) —— \
         手拼那版漏了 hint"
    );
}
