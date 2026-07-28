//! 节点执行器：把节点配置真的变成副作用。
//!
//! Runner 之前用闭包注入结果，能验证调度但验证不了「script.shell 节点
//! 真的会跑那段脚本」。这里补上那一段。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::executor::NodeExecutor;
use aiwf_engine::graph::GraphNode;
use aiwf_engine::interp::{Scope, interpolate};
use aiwf_engine::runner::NodeOutcome;

fn node(id: &str, node_type: &str, config: serde_json::Value) -> GraphNode {
    GraphNode {
        id: id.to_string(),
        node_type: node_type.to_string(),
        title: id.to_string(),
        config,
        join: None,
    }
}

fn workdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("aiwf_exec_workdir");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 测节点本身行为的用例都用这个：显式声明 workspace_safe。
///
/// 默认档是 review_every_change（有副作用的节点先挂起等审批）——
/// 那是**有意**的默认，但它会让「shell 节点真的执行脚本」这类用例
/// 停在审批上。声明档位比放宽默认好：默认放宽等于替用户做了一个
/// 他不知道自己做过的决定。
/// 测节点本身行为的用例都用这个：显式声明 workspace_safe。
///
/// 默认档是 review_every_change（有副作用的节点先挂起等审批）——
/// 那是**有意**的默认，但它会让「shell 节点真的执行脚本」这类用例
/// 停在审批上。声明档位比放宽默认好：默认放宽等于替用户做了一个
/// 他不知道自己做过的决定。
fn executor() -> NodeExecutor {
    NodeExecutor::new(workdir()).with_permission_preset("workspace_safe")
}

#[test]
fn shell_节点真的执行脚本并把_stdout_带回() {
    let mut scope = Scope::new("run_exec_1");
    let outcome = executor()
        .execute(
            &node(
                "greet",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "echo 你好", "timeoutMs": 5000}),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "实际：{outcome:?}"
    );
    // 输出必须进 scope，否则下游节点引用 ${greet.success} 会失败
    let piped = interpolate("${greet.success.stdout}", &scope).unwrap();
    assert_eq!(piped.trim(), "你好");
}

#[test]
fn shell_节点非零退出走_failure_端口() {
    let outcome = executor()
        .execute(
            &node(
                "boom",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "exit 7", "timeoutMs": 5000}),
            ),
            &mut Scope::new("run_exec_2"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => assert!(message.contains('7'), "实际：{message}"),
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn shell_节点的脚本会先做变量插值() {
    let mut scope = Scope::new("run_exec_3");
    scope.set_inputs(serde_json::json!({"name": "Luca"}));
    executor()
        .execute(
            &node(
                "hi",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo hello ${input.name}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let out = interpolate("${hi.success.stdout}", &scope).unwrap();
    assert_eq!(out.trim(), "hello Luca");
}

#[test]
fn 入口节点直接通过() {
    let mut scope = Scope::new("run_exec_4");
    scope.set_inputs(serde_json::json!({"repo": "demo"}));
    let outcome = executor()
        .execute(&node("entry", "entry", serde_json::json!({})), &mut scope)
        .unwrap();
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

#[test]
fn 结束节点按配置的_outcome_收尾() {
    let outcome = executor()
        .execute(
            &node("done", "end", serde_json::json!({"outcome": "success"})),
            &mut Scope::new("run_exec_5"),
        )
        .unwrap();
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

#[test]
fn 尚未实现的节点类型明确报未实现_而不是假装成功() {
    // 「宁可页面留空，也不要做假的」：没实现的节点类型必须说出来，
    // 假装成功会让用户以为工作流跑通了。
    // AI 节点已在 M3 接上 ACP，这里换一个真没实现的类型
    let outcome = executor()
        .execute(
            &node(
                "sub",
                "subworkflow",
                serde_json::json!({"workflowId": "wf_1"}),
            ),
            &mut Scope::new("run_exec_6"),
        )
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("尚未"), "实际：{message}");
            assert!(message.contains("subworkflow"), "实际：{message}");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 审批节点交回引擎处理_不在执行器里决定() {
    let outcome = executor()
        .execute(
            &node("ap", "approval", serde_json::json!({"title": "确认"})),
            &mut Scope::new("run_exec_7"),
        )
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::NeedsApproval),
        "实际：{outcome:?}"
    );
}

#[test]
fn 未定义的插值引用让节点失败_而不是把字面量喂给_shell() {
    let outcome = executor()
        .execute(
            &node(
                "bad",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "rm -rf ${input.nope}/x",
                    "timeoutMs": 5000
                }),
            ),
            &mut Scope::new("run_exec_8"),
        )
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("input.nope"), "实际：{message}")
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 脚本超时报告成超时而不是普通失败() {
    let outcome = executor()
        .execute(
            &node(
                "slow",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "sleep 30", "timeoutMs": 300}),
            ),
            &mut Scope::new("run_exec_9"),
        )
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => assert!(message.contains("超时"), "实际：{message}"),
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 通知节点在无桌面环境下也不应崩溃() {
    let outcome = executor()
        .execute(
            &node(
                "notify",
                "notify",
                serde_json::json!({"title": "完成", "body": "PR 已创建"}),
            ),
            &mut Scope::new("run_exec_10"),
        )
        .unwrap();
    // 通知的实际发送在 Tauri 壳里做，引擎只负责记录意图
    assert!(matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"));
}

// ── 输出落产物 ────────────────────────────────────────────────────────────

#[test]
fn 脚本输出落成产物文件_事件里只留摘要() {
    // 技术选型：大 payload 落 artifacts/，事件只留摘要与引用
    let dir = std::env::temp_dir().join("aiwf_exec_art");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = NodeExecutor::new(dir.clone())
        .with_run_id("run_art")
        .with_permission_preset("workspace_safe");
    let mut scope = Scope::new("run_art");
    executor
        .execute(
            &node(
                "logger",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo 第一行; echo 第二行 >&2",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let artifacts = executor.artifacts().list("run_art").unwrap();
    let names: Vec<_> = artifacts.iter().map(|a| a.name.as_str()).collect();
    assert!(names.contains(&"stdout.log"), "实际产物：{names:?}");
    assert!(names.contains(&"stderr.log"), "实际产物：{names:?}");

    let stdout = artifacts.iter().find(|a| a.name == "stdout.log").unwrap();
    assert_eq!(
        std::fs::read_to_string(&stdout.path).unwrap().trim(),
        "第一行"
    );
}

#[test]
fn 没有输出的脚本不留空产物文件() {
    // 一堆 0 字节的 stdout.log 只会让产物列表变噪音
    let dir = std::env::temp_dir().join("aiwf_exec_art2");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = NodeExecutor::new(dir)
        .with_run_id("run_art2")
        .with_permission_preset("workspace_safe");
    executor
        .execute(
            &node(
                "quiet",
                "script.shell",
                serde_json::json!({"interpreter": "bash", "script": "true", "timeoutMs": 5000}),
            ),
            &mut Scope::new("run_art2"),
        )
        .unwrap();

    assert_eq!(executor.artifacts().list("run_art2").unwrap().len(), 0);
}

#[test]
fn 失败的脚本也要留下日志产物() {
    // 端到端测试抓到的：失败分支提前 return，产物没保存 ——
    // 而脚本失败时恰恰是最需要看 stderr 的时候
    let dir = std::env::temp_dir().join("aiwf_exec_fail_art");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let executor = NodeExecutor::new(dir)
        .with_run_id("run_fail")
        .with_permission_preset("workspace_safe");
    let outcome = executor
        .execute(
            &node(
                "boom",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo 诊断信息 >&2; exit 3",
                    "timeoutMs": 5000
                }),
            ),
            &mut Scope::new("run_fail"),
        )
        .unwrap();

    assert!(matches!(outcome, NodeOutcome::Failed { .. }));

    let artifacts = executor.artifacts().list("run_fail").unwrap();
    let stderr = artifacts
        .iter()
        .find(|a| a.name == "stderr.log")
        .expect("失败的脚本必须留下 stderr.log");
    assert!(
        std::fs::read_to_string(&stderr.path)
            .unwrap()
            .contains("诊断信息")
    );
}

// ── 命令注入（codex 审查指出，验证后确认属实）─────────────────────────────

#[test]
fn 启动参数里的分号不能变成另一条命令() {
    // 工作流作者写脚本是本来就有的权限；但只拥有「运行工作流」能力的人
    // 不该借启动参数拿到同样的权限。M4 的主管 AI 也会启动运行 ——
    // 那时这个口子等于把命令执行权交给了模型的输出。
    let dir = std::env::temp_dir().join("aiwf_inject");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("pwned.txt");

    let mut scope = Scope::new("run_inject");
    scope.set_inputs(serde_json::json!({
        "name": format!("x; touch {} #", marker.display()),
    }));

    NodeExecutor::new(dir.clone())
        .execute(
            &node(
                "greet",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo hello ${input.name}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(
        !marker.exists(),
        "启动参数里的 `; touch` 被当成了另一条命令执行"
    );
}

#[test]
fn 上游节点的输出里的反引号不会被求值() {
    let dir = std::env::temp_dir().join("aiwf_inject2");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("subshell.txt");

    let mut scope = Scope::new("run_inject2");
    scope.set_node_output(
        "up",
        "success",
        serde_json::json!({ "stdout": format!("$(touch {})", marker.display()) }),
    );

    NodeExecutor::new(dir.clone())
        .execute(
            &node(
                "consume",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo ${up.success.stdout}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(!marker.exists(), "上游输出里的 $() 被当成命令替换执行了");
}

#[test]
fn 插值出的值原样传给脚本_不因转义而变形() {
    // 转义不能把值改掉：脚本里 echo 出来的必须还是用户填的那串
    let dir = std::env::temp_dir().join("aiwf_inject3");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut scope = Scope::new("run_inject3");
    scope.set_inputs(serde_json::json!({ "text": "a b'c\"d;e$f" }));

    NodeExecutor::new(dir)
        .with_permission_preset("workspace_safe")
        .execute(
            &node(
                "echo",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "printf '%s' ${input.text}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let out = interpolate("${echo.success.stdout}", &scope).unwrap();
    assert_eq!(out, "a b'c\"d;e$f", "转义把值改坏了");
}

#[test]
fn 换行也不能拆出新的一行命令() {
    let dir = std::env::temp_dir().join("aiwf_inject4");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("newline.txt");

    let mut scope = Scope::new("run_inject4");
    scope.set_inputs(serde_json::json!({
        "name": format!("x\ntouch {}", marker.display()),
    }));

    NodeExecutor::new(dir.clone())
        .execute(
            &node(
                "greet",
                "script.shell",
                serde_json::json!({
                    "interpreter": "bash",
                    "script": "echo ${input.name}",
                    "timeoutMs": 5000
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(!marker.exists(), "换行被当成了命令分隔符");
}

// ── AI 节点（M3）──────────────────────────────────────────────────────────

/// 夹具里那几个 AI 节点引用的内置角色。
///
/// 节点写了 `agentProfileId` 而执行器查不到就是硬错误 ——
/// 那正是「界面上显示着审查者，实际跑的是一个没有人设的模型」的防线。
/// 所以凡是用了角色 id 的夹具，都得把角色一起给它。
fn 内置角色() -> Vec<aiwf_engine::executor::AgentProfile> {
    ["builtin:analyst", "builtin:reviewer", "builtin:builder", "builtin:operator"]
        .into_iter()
        .map(|id| aiwf_engine::executor::AgentProfile {
            id: id.to_string(),
            name: id.to_string(),
            role: String::new(),
            goal: String::new(),
            persona: String::new(),
            // 空串表示「角色没指定 runtime」，于是听节点的 —— 这些夹具
            // 测的是别的东西，不该被 runtime 的归属搅进来
            runtime: String::new(),
            model_ref: "model:codex".to_string(),
            output_contract: String::new(),
            capabilities_json: r#"{"file":"read-write","command":"any","network":"any","memory":"read-write","secret":[]}"#.to_string(),
            timeout_ms: 900_000,
        })
        .collect()
}

/// 让执行器用 mock adapter 而不是真的 claude-agent-acp。
fn with_mock_adapter(dir: std::path::PathBuf) -> NodeExecutor {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .join("tests/fixtures/acp-mock.mjs");
    NodeExecutor::new(dir)
        .with_agent_profiles(&内置角色())
        .with_acp_command(
            "node",
            &[script.display().to_string(), "normal".to_string()],
        )
}

fn ai_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aiwf_ai_{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn ai_分析节点真的走一轮_acp_会话() {
    let dir = ai_dir("analyze");
    let mut scope = Scope::new("run_ai_1");
    scope.set_inputs(serde_json::json!({ "issue": "561" }));

    let outcome = with_mock_adapter(dir)
        .execute(
            &node(
                "analyze",
                "ai.analyze",
                serde_json::json!({
                    "agentProfileId": "builtin:analyst",
                    "instruction": "定位 ${input.issue} 的根因",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { port } if port == "success"),
        "实际：{outcome:?}"
    );

    // agent 的回答进 scope，下游节点才能引用
    let answer = interpolate("${analyze.success.text}", &scope).unwrap();
    assert!(answer.contains("分析结果"), "实际：{answer}");
}

#[test]
fn ai_节点的指令会先做变量插值() {
    let dir = ai_dir("interp");
    let mut scope = Scope::new("run_ai_2");
    scope.set_inputs(serde_json::json!({ "target": "缓存模块" }));

    with_mock_adapter(dir)
        .execute(
            &node(
                "review",
                "ai.review",
                serde_json::json!({
                    "agentProfileId": "builtin:reviewer",
                    "instruction": "审查 ${input.target}",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    // mock 把收到的提示词原样回显不了，但插值失败会直接报错，
    // 所以能跑通就说明 ${input.target} 解析出来了
    // ai.review 的端口是 passed / changes_requested，没有 success
    assert!(interpolate("${review.passed.text}", &scope).is_ok());
}

#[test]
fn ai_节点把工具调用次数记进输出() {
    // 图纸对话视图要显示「工具活动 · 6 次读取，2 次搜索」
    let dir = ai_dir("tools");
    let mut scope = Scope::new("run_ai_3");

    with_mock_adapter(dir)
        .execute(
            &node(
                "exec",
                "ai.execute",
                serde_json::json!({
                    "agentProfileId": "builtin:builder",
                    "instruction": "改一下",
                    "runtime": "acp.claude",
                    // ai.execute 的 workdirSource 默认是 worktree，而这条用例
                    // 测的是工具调用次数，不该被工作目录的来源搅进来
                    "workdirSource": "inherit"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    let tools = interpolate("${exec.success.toolCalls}", &scope).unwrap();
    assert_eq!(tools, "1", "工具调用次数实际：{tools}");
}

#[test]
fn 未插值的引用不会被发给_agent() {
    // 把 `${input.nope}` 原样发给 agent，它会当成字面量去理解 ——
    // 得到的分析基于一个不存在的东西
    let dir = ai_dir("badvar");
    let outcome = with_mock_adapter(dir)
        .execute(
            &node(
                "analyze",
                "ai.analyze",
                serde_json::json!({
                    "agentProfileId": "builtin:analyst",
                    "instruction": "分析 ${input.nope}",
                    "runtime": "acp.claude"
                }),
            ),
            &mut Scope::new("run_ai_4"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("input.nope"), "实际：{message}")
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn adapter_没装时说清楚要装什么_而不是假装成功() {
    let dir = ai_dir("noadapter");
    let executor = NodeExecutor::new(dir)
        .with_agent_profiles(&内置角色())
        .with_acp_command("definitely-not-an-adapter", &[])
        .with_permission_preset("workspace_safe");

    let outcome = executor
        .execute(
            &node(
                "analyze",
                "ai.analyze",
                serde_json::json!({
                    "agentProfileId": "builtin:analyst",
                    "instruction": "分析",
                    "runtime": "acp.claude"
                }),
            ),
            &mut Scope::new("run_ai_5"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("adapter"), "实际：{message}");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn ai_决策节点把结论放进输出的_decision_字段() {
    let dir = ai_dir("decide");
    let mut scope = Scope::new("run_ai_6");

    with_mock_adapter(dir)
        .execute(
            &node(
                "decide",
                "ai.decide",
                serde_json::json!({
                    "agentProfileId": "builtin:operator",
                    "instruction": "按影响面分级",
                    "runtime": "acp.claude"
                }),
            ),
            &mut scope,
        )
        .unwrap();

    // 决策节点的输出要能被下游的条件分支引用
    // ai.decide 的端口是 auto_decided / escalated
    assert!(interpolate("${decide.auto_decided.text}", &scope).is_ok());
}

// ── 记忆注入与溯源（M4 出口标准）──────────────────────────────────────────
//
// 「记忆注入可在事件中溯源」——记忆会改变 AI 的行为，
// 而用户看到一个出乎意料的结果时，第一个要问的就是「它凭什么这么干」。
// 答案必须在运行记录里，而不是让他去猜当时有哪几条记忆生效。

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

fn ai_节点() -> GraphNode {
    node(
        "analyze",
        "ai.analyze",
        serde_json::json!({
            "instruction": "看看这段代码",
            "runtime": "acp.claude",
            "outputSchema": {}
        }),
    )
}

/// 从 mock 回显的输出里拿到它实际收到的提示词。
///
/// mock 的 echo-prompt 场景把收到的提示词原样当成回答发回来，
/// 于是它落在 `outputs.<node>.success.text` 里。
/// snapshot 是 Scope 唯一的读出口 —— 内部结构是私有的，测试也不该依赖它。
fn 收到的提示词(scope: &Scope, node_id: &str) -> String {
    // 端口按节点类型不同：ai.review 走 passed、ai.decide 走 auto_decided。
    // 写死 `.success` 的话，这个助手只对 ai.analyze / ai.execute 有效
    let snapshot = scope.snapshot();
    let outputs = snapshot["outputs"].as_object().cloned().unwrap_or_default();
    outputs
        .iter()
        .find(|(key, _)| key.starts_with(&format!("{node_id}.")))
        .and_then(|(_, value)| value["text"].as_str())
        .unwrap_or_default()
        .to_string()
}

#[test]
fn ai_节点把记忆拼进提示词() {
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_memories(&[
            ("style.commit".to_string(), "提交信息用中文".to_string()),
            (
                "worktree.cleanup".to_string(),
                "PR 合并前保留 worktree".to_string(),
            ),
        ]);

    let mut scope = Scope::new("run_mem");
    let outcome = executor.execute(&ai_节点(), &mut scope).unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );

    let prompt = 收到的提示词(&scope, "analyze");
    assert!(
        prompt.contains("提交信息用中文"),
        "记忆没进提示词：{prompt}"
    );
    assert!(prompt.contains("PR 合并前保留 worktree"));
}

#[test]
fn 注入的记忆记在执行器上_供上层写事件() {
    // 执行器不碰数据库（它连 store 都没有），所以把「注入了哪几条」
    // 报给上层，由 runner 写成 system.memory_injected 事件
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_memories(&[("style.commit".to_string(), "用中文".to_string())]);

    let mut scope = Scope::new("run_mem");
    executor.execute(&ai_节点(), &mut scope).unwrap();

    assert_eq!(
        executor.injected_memory_keys(),
        vec!["style.commit".to_string()],
        "要能说出注入了哪几条"
    );
}

#[test]
fn 没有记忆时提示词里不留空段() {
    // 留一句「已知的长期上下文：」后面什么都没有，
    // 模型会以为上下文被截断了
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("workspace_safe");

    let mut scope = Scope::new("run_mem");
    executor.execute(&ai_节点(), &mut scope).unwrap();

    let prompt = 收到的提示词(&scope, "analyze");
    assert!(
        !prompt.contains("长期上下文"),
        "没记忆就不该有这一段：{prompt}"
    );
}

#[test]
fn 非_ai_节点不注入记忆() {
    // 脚本节点拿记忆没有意义，而拼进环境变量反而会泄露
    let executor = NodeExecutor::new(workdir())
        .with_memories(&[("style.commit".to_string(), "用中文".to_string())]);

    let node = node(
        "sh",
        "script.shell",
        serde_json::json!({"interpreter": "bash", "script": "echo hi", "timeoutMs": 10000}),
    );
    let mut scope = Scope::new("run_mem");
    executor.execute(&node, &mut scope).unwrap();

    assert!(executor.injected_memory_keys().is_empty());
}

/// 权限档真的改变引擎的行为 —— 否则设置屏那三档只是三个好看的卡片。
///
/// 图纸「05 设置与环境」的权限策略：
/// - Review Every Change：文件写入、命令与外部写操作**逐项审批**
/// - Workspace Safe：授权目录内可读写与执行已声明命令
/// - Trusted Workflow：对指定已发布版本沿用保存策略
///
/// 界面能选而引擎不按档位拦截的话，那是假的安全感 —— 比没有更糟。
mod 权限档改变行为 {
    use super::*;

    fn shell节点(script: &str) -> GraphNode {
        node(
            "s1",
            "script.shell",
            serde_json::json!({ "interpreter": "zsh", "script": script }),
        )
    }

    #[test]
    fn review_every_change_下命令要先审批() {
        let dir = tempfile::tempdir().unwrap();
        let executor = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("review_every_change");
        let mut scope = Scope::new("run_perm");

        let outcome = executor
            .execute(&shell节点("echo hello"), &mut scope)
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::NeedsApproval),
            "这一档要求命令逐项审批，实际：{outcome:?}"
        );
    }

    #[test]
    fn workspace_safe_下已声明的命令直接跑() {
        // 「授权目录内可读写与执行已声明命令」—— 节点配置里写死的 script
        // 就是已声明的，每次都问等于把这一档变成上一档
        let dir = tempfile::tempdir().unwrap();
        let executor =
            NodeExecutor::new(dir.path().to_path_buf()).with_permission_preset("workspace_safe");
        let mut scope = Scope::new("run_perm");

        let outcome = executor
            .execute(&shell节点("echo hello"), &mut scope)
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "已声明的命令不该被拦，实际：{outcome:?}"
        );
    }

    #[test]
    fn 没设过权限档时按最严的一档办() {
        // 首次配置写的就是 review_every_change，但万一没有 ——
        // 默认放宽等于替用户做了一个他不知道自己做过的决定
        let dir = tempfile::tempdir().unwrap();
        let executor = NodeExecutor::new(dir.path().to_path_buf());
        let mut scope = Scope::new("run_perm");

        let outcome = executor
            .execute(&shell节点("echo hello"), &mut scope)
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::NeedsApproval),
            "没设过就该按最严的办，实际：{outcome:?}"
        );
    }

    #[test]
    fn 审批过的命令不再问第二次() {
        // 用户在审批那一步点了通过，恢复执行时不该又停在同一个节点上
        let dir = tempfile::tempdir().unwrap();
        let executor = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("review_every_change")
            .with_approved_nodes(&["s1".to_string()]);
        let mut scope = Scope::new("run_perm");

        let outcome = executor
            .execute(&shell节点("echo hello"), &mut scope)
            .unwrap();

        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "批准过还再问，运行会永远卡在这里：{outcome:?}"
        );
    }

    #[test]
    fn 不涉及副作用的节点不受影响() {
        // 入口只是起点，逐项审批它没有任何意义 ——
        // 每个节点都弹一次的话用户会直接把最严那一档关掉
        let dir = tempfile::tempdir().unwrap();
        let executor = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("review_every_change");
        let mut scope = Scope::new("run_perm");

        let outcome = executor
            .execute(&node("e1", "entry", serde_json::json!({})), &mut scope)
            .unwrap();

        assert!(matches!(outcome, NodeOutcome::Succeeded { .. }));
    }
}

/// 能力声明由引擎强制 —— 图纸「05 Agent 角色」的原话是
/// 「权限（引擎强制，Prompt 无法越权）」。
///
/// 契约的说法：节点声明自己需要什么，Agent 角色声明自己允许什么，
/// 运行时取两者交集。不在引擎里拦的话，那两句话都是空的：
/// 界面上摆着一排权限，而 Agent 想干什么还是干什么。
mod 能力声明是硬的 {
    use super::*;

    fn shell(script: &str) -> GraphNode {
        node(
            "s1",
            "script.shell",
            serde_json::json!({ "interpreter": "zsh", "script": script }),
        )
    }

    /// 只允许 file 读、不允许执行命令的一份能力。
    fn 只读能力() -> serde_json::Value {
        serde_json::json!({
            "file": "read",
            "command": "none",
            "network": "none",
            "memory": "none",
            "secret": []
        })
    }

    fn 可执行能力() -> serde_json::Value {
        serde_json::json!({
            "file": "read-write",
            "command": "declared",
            "network": "none",
            "memory": "none",
            "secret": []
        })
    }

    #[test]
    fn command_为_none_时脚本节点被拒() {
        let dir = tempfile::tempdir().unwrap();
        let executor = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("workspace_safe")
            .with_capabilities(&只读能力());
        let mut scope = Scope::new("run_cap");

        let outcome = executor.execute(&shell("echo hi"), &mut scope).unwrap();

        match outcome {
            NodeOutcome::Failed { message } => {
                assert!(
                    message.contains("命令") || message.contains("command"),
                    "错误信息要说清是哪一项能力不够：{message}"
                );
            }
            other => panic!("command=none 却让脚本跑了：{other:?}"),
        }
    }

    #[test]
    fn command_为_declared_时放行() {
        let dir = tempfile::tempdir().unwrap();
        let executor = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("workspace_safe")
            .with_capabilities(&可执行能力());
        let mut scope = Scope::new("run_cap2");

        let outcome = executor.execute(&shell("echo hi"), &mut scope).unwrap();
        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn 没声明能力时不拦_那是没配过角色的运行() {
        // 直接跑一条脚本工作流（不挂 Agent）时没有能力声明，
        // 拦下来的话所有现成的工作流都跑不了了
        let dir = tempfile::tempdir().unwrap();
        let executor =
            NodeExecutor::new(dir.path().to_path_buf()).with_permission_preset("workspace_safe");
        let mut scope = Scope::new("run_cap3");

        let outcome = executor.execute(&shell("echo hi"), &mut scope).unwrap();
        assert!(
            matches!(outcome, NodeOutcome::Succeeded { .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn 拒绝发生在执行之前_不留副作用() {
        // 「拦」必须在起进程之前，否则脚本已经写了文件才报错
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("不该出现.txt");
        let executor = NodeExecutor::new(dir.path().to_path_buf())
            .with_permission_preset("workspace_safe")
            .with_capabilities(&只读能力());
        let mut scope = Scope::new("run_cap4");

        let _ = executor
            .execute(&shell(&format!("touch '{}'", marker.display())), &mut scope)
            .unwrap();

        assert!(!marker.exists(), "脚本已经跑了才拦，副作用已经发生");
    }
}

// ── Agent 角色真的生效（M3 出口标准）────────────────────────────────────────
//
// 图纸「05 Agent 角色」把角色画成四块：角色与目标、性格与指令、
// 模型与 Runtime、权限与工具。而 `run_ai` 长期只读 `instruction` 与
// `runtime` —— 用户在那一屏上填的目标、人设、输出契约、能力，
// 一个字都没到过模型面前。
//
// 症状不是报错，是「界面上摆着一排设置，改了没有任何区别」。
// 而运行记录里那句「用了哪个角色」也就无从谈起。

fn 角色(id: &str) -> aiwf_engine::executor::AgentProfile {
    aiwf_engine::executor::AgentProfile {
        id: id.to_string(),
        name: "审查者".to_string(),
        role: "审查".to_string(),
        goal: "只读检查改动，按严重度排序".to_string(),
        persona: "挑毛病，但每条都要能落到具体某一行".to_string(),
        runtime: "acp.claude".to_string(),
        model_ref: "model:codex".to_string(),
        output_contract: "问题清单：严重度、文件与行、复现方式".to_string(),
        capabilities_json:
            r#"{"file":"read","command":"none","network":"none","memory":"read","secret":[]}"#
                .to_string(),
        timeout_ms: 900_000,
    }
}

fn 挂角色的_ai_节点(profile_id: &str) -> GraphNode {
    node(
        "review",
        "ai.review",
        serde_json::json!({
            "agentProfileId": profile_id,
            "instruction": "看看这段改动",
            "target": "diff",
            "outputSchema": {}
        }),
    )
}

#[test]
fn 角色的目标人设与输出契约都进了提示词() {
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&[角色("builtin:reviewer")]);

    let mut scope = Scope::new("run_role");
    let outcome = executor
        .execute(&挂角色的_ai_节点("builtin:reviewer"), &mut scope)
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );

    let prompt = 收到的提示词(&scope, "review");
    for 片段 in [
        "只读检查改动，按严重度排序",
        "挑毛病，但每条都要能落到具体某一行",
        "问题清单：严重度、文件与行、复现方式",
    ] {
        assert!(
            prompt.contains(片段),
            "角色的「{片段}」没进提示词：\n{prompt}"
        );
    }
    // 节点自己的指令仍然要在，而且在最后 —— 它是这一次要干的事
    assert!(prompt.trim_end().ends_with("看看这段改动"), "{prompt}");
}

#[test]
fn 角色不存在时当场失败_而不是悄悄按没有角色跑() {
    // 悄悄跑下去的话，用户得到的分析是一个没有人设、没有输出契约、
    // 也没有权限约束的模型给的 —— 而界面上显示的是「审查者」
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir()).with_acp_command(&command, &args);

    let mut scope = Scope::new("run_role");
    let outcome = executor
        .execute(&挂角色的_ai_节点("builtin:nobody"), &mut scope)
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("builtin:nobody"), "{message}");
            assert!(
                message.contains("Agent 角色"),
                "要说清缺的是什么：{message}"
            );
        }
        other => panic!("角色不存在该失败，实得 {other:?}"),
    }
}

#[test]
fn 角色声明的能力被引擎强制_提示词改不了它() {
    // 「权限（引擎强制，Prompt 无法越权）」——审查者是 command: none，
    // 那么挂着它的节点就不该能执行命令，哪怕节点自己说要
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_permission_preset("trusted_workflow")
        .with_agent_profiles(&[角色("builtin:reviewer")]);

    let 脚本 = node(
        "sh",
        "script.shell",
        serde_json::json!({
            "interpreter": "zsh",
            "script": "echo hi",
            "agentProfileId": "builtin:reviewer"
        }),
    );

    let outcome = executor
        .execute(&脚本, &mut Scope::new("run_caps"))
        .unwrap();
    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("命令"), "要说清是哪一项权限：{message}");
        }
        other => panic!("审查者不该能执行命令，实得 {other:?}"),
    }
}

#[test]
fn 角色的_runtime_压过节点上写的那个() {
    // 节点上的 runtime 是 M2 时期的写法（那时还没有角色）。
    // 两处都写着时以角色为准 —— 界面上用户改的是角色那一栏
    let profiles = [aiwf_engine::executor::AgentProfile {
        runtime: "acp.codex".to_string(),
        ..角色("builtin:reviewer")
    }];
    let executor = NodeExecutor::new(workdir()).with_agent_profiles(&profiles);

    assert_eq!(
        executor.resolved_runtime(&挂角色的_ai_节点("builtin:reviewer")),
        "acp.codex",
        "节点上写的是 acp.claude，但角色说 acp.codex"
    );
}

#[test]
fn 解析结果记在执行器上_供上层写可解释性事件() {
    // 「用了哪个模型 / 哪条提示词 / 哪个角色」是运行记录要回答的问题。
    // 执行器不碰数据库，所以把它报给上层去写 system.model_resolved
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&[角色("builtin:reviewer")]);

    executor
        .execute(
            &挂角色的_ai_节点("builtin:reviewer"),
            &mut Scope::new("run_x"),
        )
        .unwrap();

    let 记录 = executor.resolutions();
    assert_eq!(记录.len(), 1, "一个 AI 节点该留一条解析记录");
    let 一条 = &记录[0];
    assert_eq!(一条.node_id, "review");
    assert_eq!(一条.agent_profile_id, "builtin:reviewer");
    assert_eq!(一条.model_ref, "model:codex");
    assert_eq!(一条.runtime, "acp.claude");
}

#[test]
fn 没挂角色的_ai_节点照旧能跑() {
    // 已经存在的工作流里有一堆没写 agentProfileId 的 AI 节点。
    // 一刀切要求挂角色的话，它们会在这次升级之后全部跑不了
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir()).with_acp_command(&command, &args);

    let outcome = executor
        .execute(&ai_节点(), &mut Scope::new("run_plain"))
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );
}

#[test]
fn worktree_的相对路径按运行工作目录算_不是进程的_cwd() {
    // 端到端验证抓到的第二个真问题：上一个脚本节点
    // `gh repo clone … repo` 把仓库克隆进运行工作目录，
    // 下一个 worktree 节点写 `repoRoot: "repo"` —— 报「不是一个 Git 仓库」。
    //
    // 原因是 `PathBuf::from("repo")` 按**进程的 CWD** 解析，而那是
    // 应用自己的目录。脚本节点的 cwd 是运行工作目录，两个节点对
    // 「相对路径相对于谁」的理解不一致，而错误信息里看不出这件事。
    // 自己的临时目录，不用共用的那个：worktree 会**在仓库里留下一个分支**，
    // 共用目录跨次运行还在，第二次跑就报「分支已存在」——
    // 而那是这条用例本身的残留，不是被测行为
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "测试"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }
    std::fs::write(repo.join("README.md"), "hi").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-qm", "初始"]] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&repo)
            .output()
            .unwrap();
    }

    let outcome = NodeExecutor::new(dir.clone())
        .with_permission_preset("workspace_safe")
        .execute(
            &node(
                "wt",
                "git.worktree",
                serde_json::json!({
                    "repoRoot": "repo",
                    "baseBranch": "main",
                    "branchTemplate": "fix/相对路径"
                }),
            ),
            &mut Scope::new("run_wt_rel"),
        )
        .unwrap();

    assert!(
        matches!(&outcome, NodeOutcome::Succeeded { .. }),
        "相对路径该按运行工作目录算：{outcome:?}"
    );
}

#[test]
fn worktree_的绝对路径原样使用() {
    // 相对路径改了解析基准，绝对路径不能跟着变
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let outcome = NodeExecutor::new(dir.clone())
        .with_permission_preset("workspace_safe")
        .execute(
            &node(
                "wt",
                "git.worktree",
                serde_json::json!({
                    "repoRoot": "/definitely/not/here",
                    "baseBranch": "main",
                    "branchTemplate": "x"
                }),
            ),
            &mut Scope::new("run_wt_abs"),
        )
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => assert!(
            message.contains("/definitely/not/here"),
            "报错要说的是用户给的那个路径：{message}"
        ),
        other => panic!("实际：{other:?}"),
    }
}

// ── workdirSource 是承诺，不是装饰 ──────────────────────────────────────────
//
// `ai.execute` 的这个字段在契约里写着「工作目录来源\n由引擎强制，
// Prompt 不能改变安全边界」，图纸里也写着「Fix Agent 的 cwd 固定为
// $GIT_WORKTREE_PATH，不会污染你当前分支」。
//
// 而 `run_ai` 一直把运行工作目录直接当 cwd 交给 ACP 会话 ——
// 那句「由引擎强制」是空的，而且它是**安全**声明。

fn 执行节点(workdir_source: &str) -> GraphNode {
    node(
        "fix",
        "ai.execute",
        serde_json::json!({
            "agentProfileId": "builtin:builder",
            "instruction": "改一下",
            "workdirSource": workdir_source
        }),
    )
}

#[test]
fn 声明了_worktree_却没有上游_worktree_时当场失败() {
    // 悄悄退回运行工作目录的话，Agent 会直接在克隆出来的仓库里改 ——
    // 那正是「不会污染你当前分支」要防的事，而用户不会知道它发生了
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&内置角色());

    let outcome = executor
        .execute(&执行节点("worktree"), &mut Scope::new("run_wds"))
        .unwrap();

    match outcome {
        NodeOutcome::Failed { message } => {
            assert!(message.contains("worktree"), "{message}");
        }
        other => panic!("没有上游 worktree 就不该跑，实得 {other:?}"),
    }
}

#[test]
fn 声明了_worktree_时_cwd_就是那个_worktree() {
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&内置角色());

    let mut scope = Scope::new("run_wds2");
    // 上游 worktree 节点的输出形状
    scope.set_node_output(
        "wt",
        "success",
        serde_json::json!({ "path": "/tmp/某个/worktree", "branch": "fix/1" }),
    );

    let outcome = executor.execute(&执行节点("worktree"), &mut scope).unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );
    assert_eq!(
        executor.resolutions().first().map(|r| r.workdir.clone()),
        Some("/tmp/某个/worktree".to_string()),
        "cwd 该是 worktree 的路径"
    );
}

#[test]
fn 声明了_inherit_时_cwd_是运行工作目录() {
    let (command, args) = mock_acp();
    let dir = workdir();
    let executor = NodeExecutor::new(dir.clone())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&内置角色());

    executor
        .execute(&执行节点("inherit"), &mut Scope::new("run_wds3"))
        .unwrap();

    assert_eq!(
        executor.resolutions().first().map(|r| r.workdir.clone()),
        Some(dir.display().to_string()),
    );
}

#[test]
fn 分析与审查节点不受_worktree_约束() {
    // 只有 ai.execute 有 workdirSource。分析、审查、决策是只读的，
    // 强制要求上游有 worktree 会让一条纯分析的工作流跑不了
    let (command, args) = mock_acp();
    let executor = NodeExecutor::new(workdir())
        .with_acp_command(&command, &args)
        .with_agent_profiles(&内置角色());

    let outcome = executor
        .execute(&ai_节点(), &mut Scope::new("run_wds4"))
        .unwrap();
    assert!(
        matches!(outcome, NodeOutcome::Succeeded { .. }),
        "{outcome:?}"
    );
}

// ── AI 节点走的端口必须真的存在 ─────────────────────────────────────────────
//
// `run_ai` 一直硬编码 `port: "success"`。而契约里：
// - ai.review 的端口是 passed / changes_requested
// - ai.decide 的端口是 auto_decided / escalated
//
// 于是事件流里写着「审查修复 完成 · 走 success 分支」—— 一个不存在的分支；
// 输出也落在 `outputs.review.success` 上，而下游写 `${review.passed}`
// 会解析不出来。两样都是**记录不准确**。
//
// 注意这修的不是「按模型的结论选端口」（那是条件路由，还没做），
// 修的是「说出来的那个端口至少得存在」。

#[test]
fn 各类_ai_节点走的端口都在节点目录里() {
    let (command, args) = mock_acp();

    for (node_type, extra) in [
        ("ai.analyze", serde_json::json!({ "target": "x" })),
        ("ai.review", serde_json::json!({ "target": "x" })),
        ("ai.decide", serde_json::json!({})),
        (
            "ai.execute",
            serde_json::json!({ "workdirSource": "inherit" }),
        ),
    ] {
        let mut config = serde_json::json!({
            "agentProfileId": "builtin:builder",
            "instruction": "干活"
        });
        for (key, value) in extra.as_object().unwrap() {
            config[key] = value.clone();
        }

        let executor = NodeExecutor::new(workdir())
            .with_acp_command(&command, &args)
            .with_agent_profiles(&内置角色());
        let mut scope = Scope::new("run_ports");
        let outcome = executor
            .execute(&node("n", node_type, config), &mut scope)
            .unwrap();

        let NodeOutcome::Succeeded { port } = outcome else {
            panic!("{node_type} 没跑成功：{outcome:?}");
        };

        let 合法 = aiwf_engine::catalog::outputs(node_type, &serde_json::Value::Null);
        assert!(
            合法.iter().any(|p| p.id == port),
            "{node_type} 走了 {port}，而它的端口是 {:?}",
            合法.iter().map(|p| &p.id).collect::<Vec<_>>()
        );

        // 输出也要落在那个端口上，下游才引用得到
        assert!(
            scope.snapshot()["outputs"]
                .get(format!("n.{port}"))
                .is_some(),
            "{node_type} 的输出没落在 {port} 上"
        );
    }
}
