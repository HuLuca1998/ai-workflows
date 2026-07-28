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
    fn adapter_没装时不算报错_而是_ok_false_加原因() {
        // 这是最常见的情况，用户需要的是「装什么」，不是一个红色的异常
        let store = Store::open_in_memory().unwrap();
        let id = 模型(&store, "acp.codex");

        let 结果 = aiwf_core_api::model_test(&store, id).unwrap();
        assert!(!结果.ok);
        assert!(
            结果.detail.contains("adapter"),
            "没说清是 adapter 的问题：{}",
            结果.detail
        );
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
        // 图纸的凭据卡里有一行「延迟 · 1.4s（最近一次测试）」
        let store = Store::open_in_memory().unwrap();
        let id = 模型(&store, "acp.codex");

        let _ = aiwf_core_api::model_test(&store, id.clone()).unwrap();
        let 模型行 = store.get_model(&id).unwrap().unwrap();

        // 失败也记：那同样是「最近一次测试」的结果
        assert!(模型行.last_latency_ms.is_some(), "没记下延迟");
    }
}
