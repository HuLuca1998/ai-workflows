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
