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
        let 话 = probe_runtime::<String>("acp.codex", |_| None, |_| panic!("没装就不该去探测"))
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
        // `provider.api` 从枚举里删掉之后，这条分支**只剩历史数据够得着**：
        // 老库迁移前的行、或者有人手工改过库。够不着不等于可以删 ——
        // 那时用户会拿到一个含糊的失败，而不是「这不是 ACP 运行时」。
        //
        // 所以不再经过 store（它现在会拒绝这个值），直接测那条分支本身。
        let 话 = probe_runtime::<String>(
            "provider.api",
            |_| panic!("非 ACP 就不该去找 adapter"),
            |_| panic!("非 ACP 就不该去探测"),
        )
        .expect_err("非 ACP 的运行时却报告成功");

        assert!(话.contains("ACP"), "没说清是不是 ACP 的问题：{话}");
    }

    #[test]
    fn 测过之后延迟写回模型行() {
        // 图纸的凭据卡里有一行「延迟 · 1.4s（最近一次测试）」。
        //
        // 「探测失败」这个条件由测试自己造（`找_adapter` 返回 None），
        // 不靠一个非 ACP 的 runtime 在第一道分支被挡下 ——
        // 那条路径随 provider.api 一起没了，而这条断言要留下
        let store = Store::open_in_memory().unwrap();
        let id = 模型(&store, "acp.codex");

        let 结果 = aiwf_core_api::model_test_with(&store, id.clone(), |_| None).unwrap();
        assert!(!结果.ok, "adapter 没装却报告成功");

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

/// 错误必须说清「接下来怎么办」。
///
/// `ApiError::with_hint()` **全仓零调用**（含测试），而管道两头都通着：
/// MCP 侧把 hint 拼成「接下来：」，前端 `describeError` 渲染成
/// `${message}（${hint}）`。中间那一段一直是空的。
///
/// 两条最常撞的：
///
/// - **WrongState** —— 连点两次审批必撞。第二次拿到「运行 r_x 当前是
///   running，不能提交审批决定」，没有一个字告诉用户「你的批准已经生效了」
/// - **NotPendingApproval** —— `{expected:?}` 作用在 `Option<String>` 上，
///   用户在界面上看到的是字面的 `Some("n_review")`
mod 错误要说下一步二 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::runner::RunError;
    use aiwf_engine::supervisor::SupervisorError;

    /// 走用户真正会碰到的那条路：RunError 是被 SupervisorError 包着上来的。
    fn 转成_api(error: RunError) -> aiwf_core_api::ApiError {
        SupervisorError::Run(error).into()
    }

    #[test]
    fn 状态不对时告诉用户去哪儿看当前状态() {
        let error = RunError::WrongState {
            run_id: "run_1".to_string(),
            status: "running".to_string(),
            action: "提交审批决定",
        };
        let api = 转成_api(error);

        let hint = api.hint.expect("这是连点两次审批最常撞的一个，必须给出路");
        assert!(!hint.trim().is_empty());
        // 用户此刻最需要知道的是「我刚才那一下到底算没算数」
        assert!(hint.contains("执行记录") || hint.contains("已经"), "{hint}");
    }

    #[test]
    fn 审批指向错节点时不把_rust_的_debug_形态抛给用户() {
        let error = RunError::NotPendingApproval {
            run_id: "run_1".to_string(),
            expected: Some("n_review".to_string()),
            got: "n_other".to_string(),
        };
        let api = 转成_api(error);

        assert!(
            !api.message.contains("Some("),
            "把 Option 的 Debug 形态抛给了用户：{}",
            api.message
        );
        assert!(api.message.contains("n_review"), "{}", api.message);
        assert!(api.hint.is_some(), "没给出下一步");
    }

    #[test]
    fn 没有待审批节点时那句话读得通() {
        // expected 是 None 的情形 —— 「当前等的是节点 None」是句病句
        let error = RunError::NotPendingApproval {
            run_id: "run_1".to_string(),
            expected: None,
            got: "n_other".to_string(),
        };
        let api = 转成_api(error);

        assert!(!api.message.contains("None"), "{}", api.message);
    }
}

/// 发布是**不可变**的，所以进去之前得先看一眼。
///
/// `workflow_publish` 全文三行，从不调 `validate`；界面侧也只拦
/// 「有未保存改动」。于是：
///
/// - `graphJson` 塞一个非 JSON 的串 → create 成功 → 这条草稿从此
///   `workflow_patch` 改不动（报「草稿不是合法 JSON」）→ **publish 照样成功**
/// - 空图 `{}` → validate 报 ENTRY_MISSING → publish 照样成功
///
/// 拿到的是一个 `config_hash` 算在垃圾上的不可变版本，而运行记录
/// 会永远引用它。`workflow_patch` 那套「结构化写入是唯一形态」的防线，
/// 被 create 从侧门绕过了。
mod 发布前先校验 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_store::Store;

    fn 建一条(graph: &str) -> (Store, String) {
        let store = Store::open_in_memory().unwrap();
        let id = store
            .create_workflow_with_graph("测试", None, graph)
            .unwrap();
        (store, id)
    }

    #[test]
    fn 空图发布不了_而且说清缺什么() {
        let (store, id) = 建一条("{}");
        let rev = store.draft_revision(&id).unwrap().unwrap();

        let 错 = match aiwf_core_api::workflow_publish(&store, id, rev) {
            Err(error) => error,
            Ok(_) => panic!("一张没有入口节点的图被发布成了不可变版本"),
        };

        assert!(
            错.message.contains("入口") || 错.message.contains("ENTRY"),
            "没说清缺什么：{}",
            错.message
        );
        assert!(错.hint.is_some(), "没说接下来该干什么");
    }

    #[test]
    fn 合法的图照常发布() {
        let graph = serde_json::json!({
            "nodes": [
                {"id": "entry", "type": "entry", "title": "入口", "position": {"x":0,"y":0},
                 "config": {"trigger": "manual", "inputSchema": {"type": "object"}}},
                {"id": "done", "type": "end", "title": "结束", "position": {"x":1,"y":0},
                 "config": {"outcome": "success"}}
            ],
            "edges": [
                {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
                 "target": {"nodeId": "done", "port": "input"}}
            ],
            "groups": []
        })
        .to_string();
        let (store, id) = 建一条(&graph);
        let rev = store.draft_revision(&id).unwrap().unwrap();

        // 字段是私有的，能发布出来就够了 —— 这条要的是「合法图不被误拦」
        if let Err(错) = aiwf_core_api::workflow_publish(&store, id, rev) {
            panic!("一张合法的图被拦下了：{}", 错.message);
        }
    }

    #[test]
    fn 非_json_的草稿发布不了() {
        let (store, id) = 建一条("这不是 JSON");
        let rev = store.draft_revision(&id).unwrap().unwrap();

        let 错 = match aiwf_core_api::workflow_publish(&store, id, rev) {
            Err(error) => error,
            Ok(_) => panic!("一坨非 JSON 被发布成了不可变版本"),
        };
        assert!(错.message.contains("JSON"), "{}", 错.message);
    }
}

/// 模型清单从 runtime 现问现拿。
///
/// **这是所有模型下拉的唯一数据源。** 写死在契约或界面里的话，
/// 本机 CLI 升级多出来的模型永远看不到 —— 而那种失效是静默的：
/// 界面照常显示旧清单，用户以为那就是全部。
mod 模型同步 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    /// 让 mock adapter 能当成一条命令直接跑。
    ///
    /// `probe_runtime` 的 `找_adapter` 只交出一个命令字符串（没有 args），
    /// 而 mock 是个 .mjs —— 包一层可执行的 shell 脚本把它接起来。
    fn mock_命令() -> (tempfile::TempDir, String) {
        let 脚本 = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("仓库根")
            .join("tests/fixtures/acp-mock.mjs");
        let dir = tempfile::tempdir().expect("临时目录");
        let wrapper = dir.path().join("mock-adapter");
        std::fs::write(
            &wrapper,
            format!("#!/bin/sh\nexec node {} normal\n", 脚本.display()),
        )
        .expect("写 wrapper");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&wrapper).expect("元数据").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&wrapper, perms).expect("加执行权限");
        }
        let 路径 = wrapper.display().to_string();
        (dir, 路径)
    }

    #[test]
    fn 拿到模型与深度两份清单_以及_runtime_自己的当前值() {
        let (_guard, 命令) = mock_命令();
        let 结果 = aiwf_core_api::model_sync_with(
            &aiwf_store::Store::open_in_memory().unwrap(),
            "acp.codex".to_string(),
            |_| Some(命令.clone()),
        )
        .expect("同步失败");

        // 两份清单是**正交**的：模型一份、深度一份。
        // 不是笛卡尔积 —— 那样 5 个模型 × 6 档会平铺成 30 条，
        // 而界面上是两个独立下拉
        assert!(!结果.models.is_empty(), "没拿到模型清单");
        assert!(!结果.efforts.is_empty(), "没拿到推理深度清单");

        // 默认值从 runtime 自己的当前值来，不硬编码 ——
        // CLI 升级后同步一次就跟着变
        assert!(
            !结果.current_model.is_empty(),
            "没拿到 runtime 当前用的模型，默认值就无从谈起"
        );
        assert!(!结果.current_effort.is_empty(), "没拿到当前推理深度");

        // 当前值必须在候选里，否则界面上那个「选中项」指向一个不存在的选项
        assert!(
            结果.models.iter().any(|m| m.value == 结果.current_model),
            "当前模型 {} 不在候选里：{:?}",
            结果.current_model,
            结果.models.iter().map(|m| &m.value).collect::<Vec<_>>()
        );
    }

    #[test]
    fn adapter_没装时说清楚_而不是给一份空清单() {
        // 空清单与「没装」在界面上长得一样（下拉都是空的），
        // 而用户要做的事完全不同
        let 错 = aiwf_core_api::model_sync_with(
            &aiwf_store::Store::open_in_memory().unwrap(),
            "acp.codex".to_string(),
            |_| None,
        )
        .expect_err("adapter 没装却报告成功");
        assert!(
            错.message.contains("adapter"),
            "没说清是 adapter 的问题：{}",
            错.message
        );
    }
}

/// 对**真实** codex 跑一次 model.sync。
///
/// 默认 `#[ignore]`：它会起一个真的 adapter 进程，CI 上没装。
/// 手动跑：`cargo test -p aiwf-core-api --test api_test 真实 -- --ignored --nocapture`
///
/// 「能跑就跑，跑完把原始输出留在仓库里」—— mock 只能证明我们的解析
/// 对得上自己写的 mock。这一条证明它对得上真实 adapter。
#[test]
#[ignore = "要装了 codex-acp 才跑，会起真实进程"]
#[allow(clippy::expect_used, clippy::unwrap_used)]
fn 真实的_codex_能同步出模型清单() {
    let 开始 = std::time::Instant::now();
    let 结果 = aiwf_core_api::model_sync(
        &aiwf_store::Store::open_in_memory().unwrap(),
        "acp.codex".to_string(),
    )
    .expect("同步失败");
    let 耗时 = 开始.elapsed();

    println!("耗时 {耗时:?}");
    println!("当前：{} · {}", 结果.current_model, 结果.current_effort);
    println!(
        "模型（{}）：{}",
        结果.models.len(),
        结果
            .models
            .iter()
            .map(|m| m.value.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    );
    println!(
        "深度（{}）：{}",
        结果.efforts.len(),
        结果
            .efforts
            .iter()
            .map(|e| e.value.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    );

    assert!(!结果.models.is_empty(), "真实 adapter 没给出模型清单");
    assert!(!结果.efforts.is_empty(), "真实 adapter 没给出深度清单");
    assert!(
        结果.models.iter().any(|m| m.value == 结果.current_model),
        "当前模型不在候选里"
    );
    // 「耗时是证据」：一次握手 + 建会话在百毫秒量级。
    // 快到不合理说明它根本没连上
    assert!(耗时.as_millis() > 50, "快得不像真的连上了：{耗时:?}");
}

mod 运行摘要的契约字段 {
    use aiwf_store::Store;

    #[test]
    fn run_list_序列化出_versionId_draftRev_与解析后的_inputs() {
        // 第 3 轮实测 P3 的根因:DTO 只发 inputsJson,客户端 Zod 用默认值
        // 静默补齐(inputs 恒空、draftRev 恒缺),「用相同参数重跑」
        // 拿着空参数和不存在的 rev 0 去跑,报「缺少入口节点」
        let store = Store::open_in_memory().unwrap();
        let wf = store.create_workflow("测试", None).unwrap();
        let run = store
            .create_run(&wf, None, Some(3), r#"{"issue":"7"}"#)
            .unwrap();

        let page = aiwf_core_api::run_list(&store, None, vec![], None, None, None).unwrap();
        let json = serde_json::to_value(&page).unwrap();
        let item = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == serde_json::json!(run))
            .expect("刚建的运行要在列表里");

        assert_eq!(item["draftRev"], serde_json::json!(3));
        assert_eq!(item["inputs"]["issue"], serde_json::json!("7"));
    }
}
