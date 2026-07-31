//! 内置模板的**执行路径**端到端。
//!
//! 在这之前，`github-issue-fix` 只被「能搭出、校验通过、发布为 v1」测过 ——
//! 那些验的是图的形状。而形状全对的一张图可以在运行到第二个节点时就死掉：
//! 用户实测 `run_18c740d6394b3c70` 在 4.3 秒后失败，脚本拿到两个空串。
//!
//! 这里跑的是**真的 gh、真的 git、真的 worktree**，对着真实仓库
//! `HuLuca1998/aiwf-e2e-fixture`。AI 节点不跑（那要真实模型与配额）——
//! 它们由 `executor_test` 用 mock adapter 覆盖。
//!
//! ## 为什么不用 mock 掉 gh
//!
//! 要验的恰恰是「配置里写的那个引用，插值之后交给 gh 能不能用」。
//! mock 掉 gh 就只剩下「插值函数会不会插值」，而那已经有单测了。
//!
//! ## 跳过条件
//!
//! 没装 gh、没登录、或没有网络时**跳过而不是失败** —— 这条测试
//! 在 CI 与离线开发机上都跑不了，让它红只会教人忽略红灯。
//! 但跳过要**说出来**：静默通过的话，没人知道这条从来没跑过。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::executor::NodeExecutor;
use aiwf_engine::graph::{GraphNode, WorkflowGraph};
use aiwf_engine::interp::Scope;
use aiwf_engine::runner::NodeOutcome;

const SAMPLE: &str = include_str!("../../../packages/contracts/generated/sample-workflow.json");

/// 真实的测试仓库与 issue。
const REPO: &str = "HuLuca1998/aiwf-e2e-fixture";
const ISSUE: &str = "8";

#[derive(serde::Deserialize)]
struct 生成物 {
    graph: WorkflowGraph,
}

fn 模板图() -> WorkflowGraph {
    serde_json::from_str::<生成物>(SAMPLE)
        .expect("sample-workflow.json 读不动 —— 跑 pnpm contracts:gen")
        .graph
}

fn 取节点(graph: &WorkflowGraph, id: &str) -> GraphNode {
    graph
        .nodes
        .iter()
        .find(|n| n.id == id)
        .unwrap_or_else(|| panic!("模板里没有节点 {id}"))
        .clone()
}

/// gh 能不能用。用不了就跳过 —— 但要说出来。
fn gh_可用() -> bool {
    let ok = aiwf_engine::tooling::command("gh")
        .args(["auth", "token"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("[跳过] gh 没装或没登录 —— 这条端到端没有跑");
    }
    ok
}

fn workdir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aiwf_tpl_e2e_{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 与启动表单会给的一样的输入。
fn 输入(repo_path: &str) -> serde_json::Value {
    serde_json::json!({
        "issue": ISSUE,
        "repo": { "name": REPO, "branch": "main" },
        "repoPath": repo_path,
    })
}

#[test]
fn 读_issue_那一步真的读得到() {
    // **这就是用户那次失败的那一步。**
    //
    // 旧模板写的是 `gh issue view "$ISSUE" --repo "$REPO"`，而引擎注入的
    // 环境变量叫 `AIWF_ISSUE` / `AIWF_REPO` —— 两个都是空串，
    // gh 报 `invalid issue format: ""`
    if !gh_可用() {
        return;
    }

    let graph = 模板图();
    let mut scope = Scope::new("run_tpl_read");
    scope.set_inputs(输入("/tmp"));

    let outcome = NodeExecutor::new(workdir("read"))
        .with_permission_preset("human_approval")
        .execute(&取节点(&graph, "read_issue"), &mut scope)
        .unwrap();

    match &outcome {
        NodeOutcome::Succeeded { port } => assert_eq!(port, "success"),
        NodeOutcome::Failed { message } => {
            panic!("读 Issue 失败了 —— 用户那次就死在这一步：{message}")
        }
        other => panic!("实际：{other:?}"),
    }

    // 拿到的是**那个 issue 的真实内容**，不是一段空 JSON。
    // 只断言「成功」的话，一个返回空对象的实现也全绿。
    //
    // 脚本节点的输出形状是 `{stdout, stderr, parsed, parseError, truncated}`——
    // `outputParse: "json"` 时解析结果在 `parsed` 里
    let snapshot = scope.snapshot();
    let 输出 = snapshot["outputs"]["read_issue.success"].clone();
    let parsed = &输出["parsed"];
    assert!(
        parsed["title"]
            .as_str()
            .unwrap_or_default()
            .contains("退避"),
        "读回来的不是 issue #{ISSUE} 的内容：{输出}"
    );
    assert!(
        parsed["body"]
            .as_str()
            .unwrap_or_default()
            .contains("baseDelayMs"),
        "issue 正文没读全 —— 下游分析拿到的会是半份材料"
    );

    // 下游分析师引用的那个路径必须真的取得到东西。
    // 模板写 `${read_issue.success}` 的话，AI 收到的是一坨
    // 带转义的 JSON（stdout 字段里那份原文又出现一次）——
    // 能用，但它要先从里面把 issue 正文挖出来
    let 给分析师的 = aiwf_engine::interp::interpolate(
        取节点(&graph, "analyze").config["target"].as_str().unwrap(),
        &scope,
    )
    .expect("分析对象解析不开");
    assert!(
        给分析师的.contains("baseDelayMs"),
        "分析师拿不到 issue 正文：{给分析师的}"
    );
    // **脚本执行的元信息不该出现在分析对象里。**
    //
    // 引用整个 `.success` 的话，发过去的是
    // `{stdout, stderr, parsed, parseError, truncated}` —— issue 正文
    // 在 `stdout` 与 `parsed` 里各有一份（一份带转义），分析师得先
    // 自己判断该看哪份。实测那次整个对象 1.6KB，一半是重复的。
    //
    // 判据用这几个键而不是数正文出现几次：正文里本来就可能重复提到
    // 同一个标识符（这个 issue 里 `baseDelayMs` 就出现两次）
    for 元信息 in ["stdout", "stderr", "truncated", "parseError"] {
        assert!(
            !给分析师的.contains(元信息),
            "分析对象里混进了脚本执行的元信息「{元信息}」—— \
             引用的是整个 .success 而不是 .parsed：{给分析师的}"
        );
    }

    // 标题也要带上：只给 body 的话，分析师不知道这个 issue 叫什么
    assert!(
        给分析师的.contains("title"),
        "分析对象里没有 issue 标题：{给分析师的}"
    );
}

#[test]
fn 读_issue_是只读的_最严档下也不该被拦() {
    // 用户的原话：「现在连读取 issue 都需要用户审批」。
    // 这条不需要网络 —— 它只问「拦不拦」
    let graph = 模板图();
    let executor = NodeExecutor::new(workdir("gate")).with_permission_preset("human_approval");

    assert!(
        executor.precheck(&取节点(&graph, "read_issue")).is_none(),
        "读 Issue 被拦了"
    );

    // 而模板里那两道门**要**拦得住
    assert!(
        matches!(
            executor.precheck(&取节点(&graph, "approve_diff")),
            Some(NodeOutcome::NeedsApproval)
        ),
        "开 PR 前那道门没拦住 —— 权限全靠它"
    );
}

#[test]
fn worktree_那一步在真实仓库上建得起来() {
    // 旧模板的 repoRoot 填的是 `${input.repo.name}`（GitHub 的 owner/repo），
    // 而 git 要的是本地路径 —— 它会去找一个叫 `HuLuca1998/aiwf-e2e-fixture`
    // 的相对目录
    let 仓库 = 克隆一份("worktree");
    let Some(仓库) = 仓库 else { return };

    let graph = 模板图();
    let mut scope = Scope::new("run_tpl_wt");
    scope.set_inputs(输入(&仓库.display().to_string()));

    let dir = workdir("worktree_run");
    let outcome = NodeExecutor::new(dir.clone())
        .with_permission_preset("human_approval")
        .execute(&取节点(&graph, "worktree"), &mut scope)
        .unwrap();

    match &outcome {
        NodeOutcome::Succeeded { .. } => {}
        NodeOutcome::Failed { message } => panic!("worktree 建不起来：{message}"),
        other => panic!("实际：{other:?}"),
    }

    // 路径要真的存在，而且是一份能改的检出 —— 只看返回值的话，
    // 一个返回假路径的实现也全绿
    let snapshot = scope.snapshot();
    let path = snapshot["outputs"]["worktree.success"]["path"]
        .as_str()
        .expect("worktree 没有返回 path")
        .to_string();
    let checkout = std::path::Path::new(&path);
    assert!(checkout.is_dir(), "worktree 路径不存在：{path}");
    assert!(
        checkout.join("src/retry.js").exists(),
        "worktree 里没有仓库的文件 —— 它检出的不是那个仓库"
    );

    // 下游那个 push 脚本会 `cd ${worktree.success.path}`。
    // 插值出来的东西必须能直接 cd 进去
    let 插值 = aiwf_engine::interp::interpolate("${worktree.success.path}", &scope).unwrap();
    assert_eq!(插值, path);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 提交脚本的插值在真实上下文里全部解析得开() {
    // `push_pr` 那段脚本引用了 `${input.issue}` 与 `${worktree.success.path}`。
    // 少一个都会让节点在**执行时**失败，而那时 worktree 已经建好了
    let 仓库 = 克隆一份("interp");
    let Some(仓库) = 仓库 else { return };

    let graph = 模板图();
    let mut scope = Scope::new("run_tpl_interp");
    scope.set_inputs(输入(&仓库.display().to_string()));
    // 假装 worktree 已经跑过
    scope.set_node_output(
        "worktree",
        "success",
        serde_json::json!({ "path": 仓库.display().to_string(), "branch": "fix/8" }),
    );

    let push = 取节点(&graph, "push_pr");
    let script = push.config["script"].as_str().expect("push_pr 没有脚本");

    // 用 shell_quote 那条路径插值 —— 与执行时走的是同一个函数
    let 结果 =
        aiwf_engine::interp::interpolate_with(script, &scope, aiwf_engine::interp::shell_quote);
    let 展开 = 结果.unwrap_or_else(|e| panic!("提交脚本里有解析不开的引用：{e}"));

    assert!(
        展开.contains(&format!("'{ISSUE}'")),
        "issue 编号没插进去：{展开}"
    );
    assert!(
        展开.contains(&仓库.display().to_string()),
        "worktree 路径没插进去：{展开}"
    );
    // `${…}` 一个都不该剩下
    assert!(!展开.contains("${"), "还有没展开的引用：{展开}");
}

/// 克隆一份测试仓库。gh 用不了时返回 None（调用方跳过）。
fn 克隆一份(name: &str) -> Option<std::path::PathBuf> {
    if !gh_可用() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("aiwf_tpl_repo_{name}"));
    let _ = std::fs::remove_dir_all(&dir);

    let ok = aiwf_engine::tooling::command("gh")
        .args([
            "repo",
            "clone",
            REPO,
            &dir.display().to_string(),
            "--",
            "--quiet",
            "--depth=1",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !ok {
        eprintln!("[跳过] 克隆 {REPO} 失败 —— 这条端到端没有跑");
        return None;
    }
    Some(dir)
}
