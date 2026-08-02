//! Dry Run 依赖检查。
//!
//! 图纸的启动表单里有一块「Dry Run 依赖检查 · N 项通过 · M 项缺失」。
//! 这里只列**真的查过**的项：查不了的（ACP 握手、网络白名单）
//! 不出现在结果里，绝不放一个永远显示「通过」的假条目。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::graph::WorkflowGraph;
use aiwf_engine::preflight::{CheckStatus, dry_run};

fn graph(json: serde_json::Value) -> WorkflowGraph {
    serde_json::from_value(json).unwrap()
}

fn minimal() -> serde_json::Value {
    serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "run", "type": "script.shell", "title": "跑",
             "config": {"interpreter": "bash", "script": "echo hi"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "run", "port": "input"}}
        ],
        "groups": []
    })
}

#[test]
fn 图结构没问题时给出通过的检查项() {
    let workdir = std::env::temp_dir();
    let report = dry_run(&graph(minimal()), &workdir);

    let structure = report
        .checks
        .iter()
        .find(|c| c.label.contains("图结构"))
        .expect("应当有图结构检查");
    assert_eq!(structure.status, CheckStatus::Passed);
    assert!(report.ok);
}

#[test]
fn 有环的图在_dry_run_就被拦下_不必等到跑起来() {
    let cyclic = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A", "config": {"script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B", "config": {"script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}},
            {"id": "e3", "source": {"nodeId": "b", "port": "success"}, "target": {"nodeId": "a", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(cyclic), &std::env::temp_dir());
    assert!(!report.ok);
    let failed = report
        .checks
        .iter()
        .find(|c| c.status == CheckStatus::Failed)
        .unwrap();
    assert!(failed.detail.contains("环"), "详情实际：{}", failed.detail);
}

#[test]
fn 缺少入口节点时明确指出() {
    let no_entry = serde_json::json!({
        "nodes": [{"id": "a", "type": "script.shell", "title": "A", "config": {"script": "x"}}],
        "edges": [],
        "groups": []
    });
    let report = dry_run(&graph(no_entry), &std::env::temp_dir());
    assert!(!report.ok);
    assert!(
        report.checks.iter().any(|c| c.detail.contains("入口")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 工作目录不存在是缺失而不是通过() {
    let report = dry_run(
        &graph(minimal()),
        std::path::Path::new("/definitely/not/here"),
    );
    let workdir = report
        .checks
        .iter()
        .find(|c| c.label.contains("工作目录"))
        .expect("应当有工作目录检查");
    assert_eq!(workdir.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 图里用到的解释器会被逐个检查() {
    let with_zsh = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A",
             "config": {"interpreter": "bash", "script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B",
             "config": {"interpreter": "definitely-not-a-shell", "script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_zsh), &std::env::temp_dir());

    let bash = report
        .checks
        .iter()
        .find(|c| c.label.contains("bash"))
        .unwrap();
    assert_eq!(bash.status, CheckStatus::Passed);
    let missing = report
        .checks
        .iter()
        .find(|c| c.label.contains("definitely-not-a-shell"))
        .unwrap();
    assert_eq!(missing.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn 同一个解释器用在多个节点上只检查一次() {
    let repeated = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "a", "type": "script.shell", "title": "A", "config": {"interpreter": "bash", "script": "x"}},
            {"id": "b", "type": "script.shell", "title": "B", "config": {"interpreter": "bash", "script": "y"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "a", "port": "input"}},
            {"id": "e2", "source": {"nodeId": "a", "port": "success"}, "target": {"nodeId": "b", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(repeated), &std::env::temp_dir());
    assert_eq!(
        report
            .checks
            .iter()
            .filter(|c| c.label.contains("bash"))
            .count(),
        1
    );
}

#[test]
fn git_worktree_节点会检查_git_可用() {
    let with_git = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "wt", "type": "git.worktree", "title": "worktree",
             "config": {"repoRoot": "/tmp", "baseBranch": "main"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "wt", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_git), &std::env::temp_dir());
    assert!(
        report.checks.iter().any(|c| c.label.contains("git")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 没有_git_节点时不检查_git_不列无关条目() {
    // 列一堆与这个工作流无关的检查项，会让用户以为自己缺东西
    let report = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert!(!report.checks.iter().any(|c| c.label.contains("git ")));
}

#[test]
fn 尚未实现的节点类型在_dry_run_就说清楚() {
    // 跑到一半才说「这个类型没实现」太晚了，那时已经产生了副作用
    // 例子用 branch：subworkflow 的 sync 调用已经实现了
    // （`runner.rs` 的 `run_subworkflow`），拿它当反例这条测试永远不红
    let with_sub = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "sub", "type": "branch", "title": "条件分支",
             "config": {"cases": [{"port": "a", "when": "x"}]}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "sub", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_sub), &std::env::temp_dir());
    let unimplemented = report
        .checks
        .iter()
        .find(|c| c.label.contains("branch"))
        .expect("应当指出未实现的节点类型");
    assert_eq!(unimplemented.status, CheckStatus::Failed);
    assert!(!report.ok);
}

#[test]
fn ai_节点检查的是_adapter_装没装_而不是类型没实现() {
    // 两件事说的话不一样：「类型没实现」是我们的问题，
    // 「adapter 没装」是用户能自己解决的
    let with_ai = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ai", "type": "ai.execute", "title": "修复",
             "config": {"instruction": "修", "runtime": "acp.claude"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "ai", "port": "input"}}
        ],
        "groups": []
    });
    let report = dry_run(&graph(with_ai), &std::env::temp_dir());

    // 不该再报「ai.execute 尚未实现」
    assert!(
        !report.checks.iter().any(|c| c.detail.contains("尚未实现")),
        "检查项：{:?}",
        report.checks
    );
    // 该有一条关于 adapter 的检查
    assert!(
        report
            .checks
            .iter()
            .any(|c| c.label.contains("ACP adapter")),
        "检查项：{:?}",
        report.checks
    );
}

#[test]
fn 汇总计数与检查项一致() {
    let report = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert_eq!(
        report.passed,
        report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Passed)
            .count()
    );
    assert_eq!(
        report.failed,
        report
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Failed)
            .count()
    );
}

#[test]
fn 从入口到不了的节点要在_dry_run_就报出来() {
    // codex 的用户测试发现的：拖了三个节点忘了连线，
    // 校验说「通过」、Dry Run 说「3 个节点可依次执行」，
    // 然后引擎真的把那个孤立的脚本跑了 —— 用户没料到它会执行。
    let disconnected = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "orphan", "type": "script.shell", "title": "忘了连线的脚本",
             "config": {"interpreter": "bash", "script": "rm -rf /tmp/important"}},
            {"id": "end", "type": "end", "title": "结束", "config": {"outcome": "success"}}
        ],
        "edges": [],
        "groups": []
    });

    let report = dry_run(&graph(disconnected), &std::env::temp_dir());
    assert!(!report.ok, "有孤立节点时不该说「通过」");

    let unreachable = report
        .checks
        .iter()
        .find(|c| c.label.contains("可达"))
        .expect("应当有一条可达性检查");
    assert_eq!(unreachable.status, CheckStatus::Failed);
    assert!(
        unreachable.detail.contains("忘了连线的脚本") || unreachable.detail.contains("orphan"),
        "详情要指出是哪个节点：{}",
        unreachable.detail
    );
}

#[test]
fn 全部连通时可达性检查通过() {
    let connected = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "run", "type": "script.shell", "title": "跑",
             "config": {"interpreter": "bash", "script": "echo hi"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"},
             "target": {"nodeId": "run", "port": "input"}}
        ],
        "groups": []
    });

    let report = dry_run(&graph(connected), &std::env::temp_dir());
    let check = report
        .checks
        .iter()
        .find(|c| c.label.contains("可达"))
        .expect("应当有一条可达性检查");
    assert_eq!(check.status, CheckStatus::Passed);
}

// ── 脚本里的引号陷阱 ────────────────────────────────────────────────────────
//
// 端到端验证抓到的真问题：AI 写出 `gh issue view "${input.issue}"`，
// 而引擎替进去的值已经加过 shell 引号，命令收到的是 `"'1'"`，
// 报「invalid issue format」—— 错误信息离原因隔着一层引号。
//
// 引擎加引号是对的（单引号内没有元字符会被解释）。坏在这件事只有
// 跑起来才发现，而那时脚本可能已经产生了别的副作用。

fn 脚本图(script: &str) -> aiwf_engine::graph::WorkflowGraph {
    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"sh","type":"script.shell","title":"跑一下","position":{"x":1,"y":0},
             "config":{"interpreter":"zsh","script":script}}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},
             "target":{"nodeId":"sh","port":"input"}}
        ],
        "groups": []
    });
    serde_json::from_value(graph).expect("图解析不了")
}

fn 找检查<'a>(
    report: &'a aiwf_engine::preflight::DryRunReport,
    关键词: &str,
) -> Option<&'a str> {
    report
        .checks
        .iter()
        .find(|c| c.label.contains(关键词))
        .map(|c| c.detail.as_str())
}

#[test]
fn 变量被重复加引号时_dry_run_就拦下() {
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(
        &脚本图(r#"gh issue view "${input.issue}" --repo "${input.repo}""#),
        dir.path(),
    );

    let detail = 找检查(&report, "引号").expect("该有一条引号检查");
    // 要用用户起的名字,不是内部 id —— 用户给节点起名「跑一下」,
    // 提示里写 `sh` 他对不上号(第 2 轮实测 P13)
    assert!(
        detail.contains("跑一下"),
        "要用节点标题说清是哪个节点：{detail}"
    );
    assert!(detail.contains("input.issue"), "要说清是哪个变量：{detail}");
    assert!(!report.ok, "这条该让 Dry Run 不通过");
}

#[test]
fn 单引号里的变量同样会被重复加引号() {
    let dir = tempfile::tempdir().unwrap();
    let report =
        aiwf_engine::preflight::dry_run(&脚本图("echo '${input.name}' > out.txt"), dir.path());
    assert!(找检查(&report, "引号").is_some(), "单引号也要认");
}

#[test]
fn 没套引号的变量不报() {
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(
        &脚本图("gh issue view ${input.issue} --repo ${input.repo}"),
        dir.path(),
    );
    assert!(找检查(&report, "引号").is_none(), "这是正确的写法，不该报");
}

#[test]
fn 引号里没有变量的照样不报() {
    // 「脚本里有引号」不是问题，「引号包着一个变量」才是
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(
        &脚本图("echo \"固定的一句话\" && echo '另一句'"),
        dir.path(),
    );
    assert!(找检查(&report, "引号").is_none());
}

#[test]
fn 变量只是挨着引号而不是被包住_不报() {
    // `echo "前缀"${input.x}` 是合法写法：引号闭合在变量之前
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run(&脚本图("echo \"前缀\"${input.x}"), dir.path());
    assert!(找检查(&report, "引号").is_none(), "这不是重复加引号");
}

// ── Dry Run 查的必须是执行时真会用的那个 adapter ──────────────────────────
//
// `check_acp` 原本只读 `node.config["runtime"]`，缺省 `acp.claude`；
// 而执行时 `resolved_runtime` **以角色为准**，缺省 `acp.codex`。
// 界面新建的 AI 节点不写 node.runtime（那是 M2 时期的字段），只挂角色 ——
// 于是每一个 AI 节点，Dry Run 查的都是另一个 adapter：
//
// - 角色是 codex（默认）而机器上只装了 codex → Dry Run 报「claude 没安装」。
//   假警报，用户会去装一个根本用不上的东西。
// - 角色是 claude 而节点上留着旧的 `runtime: acp.codex` → Dry Run 说通过，
//   一跑就挂在「连不上 adapter」。**漏报更糟** —— Dry Run 的全部价值
//   就是「跑之前告诉我它会不会挂」。

fn 挂角色的_ai_图(node_runtime: Option<&str>) -> aiwf_engine::graph::WorkflowGraph {
    let mut config = serde_json::json!({
        "agentProfileId": "ap_1",
        "instruction": "看看这个",
        "target": "issue"
    });
    if let Some(runtime) = node_runtime {
        config["runtime"] = serde_json::json!(runtime);
    }
    let graph = serde_json::json!({
        "nodes": [
            {"id":"entry","type":"entry","title":"入口","position":{"x":0,"y":0},"config":{}},
            {"id":"a","type":"ai.analyze","title":"分析","position":{"x":1,"y":0},
             "config": config}
        ],
        "edges": [
            {"id":"e1","source":{"nodeId":"entry","port":"success"},
             "target":{"nodeId":"a","port":"input"}}
        ],
        "groups": []
    });
    serde_json::from_value(graph).expect("图解析不了")
}

fn 角色(runtime: &str) -> aiwf_engine::executor::AgentProfile {
    aiwf_engine::executor::AgentProfile {
        id: "ap_1".to_string(),
        name: "分析师".to_string(),
        role: "分析".to_string(),
        goal: String::new(),
        persona: String::new(),
        runtime: runtime.to_string(),
        model_ref: "model:codex".to_string(),
        fallback_model_ref: String::new(),
        output_contract: String::new(),
        capabilities_json:
            r#"{"file":"read","command":"none","network":"none","memory":"read","secret":[]}"#
                .to_string(),
        timeout_ms: 900_000,
    }
}

fn adapter标签(report: &aiwf_engine::preflight::DryRunReport) -> Vec<String> {
    report
        .checks
        .iter()
        .filter(|c| c.label.starts_with("ACP adapter"))
        .map(|c| c.label.clone())
        .collect()
}

#[test]
fn 角色的_runtime_压过节点上写的那个_dry_run_也要认() {
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run_with_profiles(
        &挂角色的_ai_图(Some("acp.claude")),
        dir.path(),
        &[角色("acp.codex")],
    );

    assert_eq!(
        adapter标签(&report),
        vec!["ACP adapter acp.codex".to_string()],
        "查的不是执行时真会用的那个 —— 节点上那个 runtime 是 M2 遗留字段，角色说了算"
    );
}

#[test]
fn 只挂角色不写节点_runtime_时按角色查() {
    // 界面新建的 AI 节点就长这样。
    //
    // 角色特意选 codex：选 claude 的话，就算实现退回「自己读
    // node.runtime、缺省 acp.claude」这条测试也绿 —— 一条靠巧合
    // 通过的断言守不住任何东西
    let dir = tempfile::tempdir().unwrap();
    let report = aiwf_engine::preflight::dry_run_with_profiles(
        &挂角色的_ai_图(None),
        dir.path(),
        &[角色("acp.codex")],
    );

    assert_eq!(
        adapter标签(&report),
        vec!["ACP adapter acp.codex".to_string()]
    );
}

#[test]
fn 查不到角色时退回节点上写的_再退回默认() {
    let dir = tempfile::tempdir().unwrap();

    let 有节点字段 = aiwf_engine::preflight::dry_run_with_profiles(
        &挂角色的_ai_图(Some("acp.claude")),
        dir.path(),
        &[],
    );
    assert_eq!(
        adapter标签(&有节点字段),
        vec!["ACP adapter acp.claude".to_string()]
    );

    // 两处都没有 → 与执行时同一个缺省。契约把 acp.codex 排在第一位，
    // 缺省跟着它（CLAUDE.md「ACP：测试与试验优先用 codex」）
    let 都没有 =
        aiwf_engine::preflight::dry_run_with_profiles(&挂角色的_ai_图(None), dir.path(), &[]);
    assert_eq!(
        adapter标签(&都没有),
        vec!["ACP adapter acp.codex".to_string()],
        "缺省与 resolved_runtime 不一致 —— 两处各有一个默认值，迟早对不上"
    );
}

#[test]
fn dry_run_与执行器解出同一个_runtime() {
    // 上面三条钉的是具体场景，这条钉的是**两个 API 不许分叉**。
    //
    // 各自断言一个硬编码的期望值，守不住「两边一起改错」；
    // 直接比对才守得住。四种组合覆盖解析链的每一环
    let dir = tempfile::tempdir().unwrap();
    let 组合: [(Option<&str>, Option<&str>); 4] = [
        (None, Some("acp.claude")),              // 只挂角色 —— 界面新建的形状
        (Some("acp.claude"), Some("acp.codex")), // 两处都有，角色赢
        (Some("acp.claude"), None),              // 只有节点上那个 M2 字段
        (None, None),                            // 都没有，看缺省
    ];

    for (节点上的, 角色的) in 组合 {
        let graph = 挂角色的_ai_图(节点上的);
        let profiles: Vec<_> = 角色的.map(角色).into_iter().collect();

        let 执行器解的 = aiwf_engine::executor::NodeExecutor::new(dir.path().to_path_buf())
            .with_agent_profiles(&profiles)
            .resolved_runtime(&graph.nodes[1]);

        let report = aiwf_engine::preflight::dry_run_with_profiles(&graph, dir.path(), &profiles);

        assert_eq!(
            adapter标签(&report),
            vec![format!("ACP adapter {执行器解的}")],
            "节点上 {节点上的:?} / 角色 {角色的:?} 时，Dry Run 查的 adapter 与执行时用的不是一个"
        );
    }
}

#[test]
fn 引用不存在的_agent_角色在_dry_run_就报出来() {
    // 第 2 轮实测:「Agent 角色」填 TEST-ROLE 这种不存在的角色,
    // 保存 ✓ 发布 ✓ Dry Run「全部通过」✓ —— 直到真跑到那个节点才炸。
    // 加载器查不到的引用不会进 profiles,Dry Run 必须抓住这个落差
    let with_ghost = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ai", "type": "ai.execute", "title": "修复",
             "config": {"instruction": "修", "agentProfileId": "TEST-ROLE"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "ai", "port": "input"}}
        ],
        "groups": []
    });
    let report = aiwf_engine::preflight::dry_run_with_profiles(
        &graph(with_ghost),
        &std::env::temp_dir(),
        &[],
    );

    let check = report
        .checks
        .iter()
        .find(|c| c.label.contains("Agent 角色"))
        .expect("应当有 Agent 角色引用检查");
    assert_eq!(check.status, CheckStatus::Failed);
    assert!(
        check.detail.contains("TEST-ROLE"),
        "要说清是哪个引用坏了：{}",
        check.detail
    );
    assert!(!report.ok);
}

#[test]
fn 角色引用齐全时检查通过_无引用时不列条目() {
    let no_ref = dry_run(&graph(minimal()), &std::env::temp_dir());
    assert!(
        !no_ref.checks.iter().any(|c| c.label.contains("Agent 角色")),
        "没有引用就不列无关条目"
    );

    let with_ai = serde_json::json!({
        "nodes": [
            {"id": "entry", "type": "entry", "title": "入口", "config": {}},
            {"id": "ai", "type": "ai.execute", "title": "修复",
             "config": {"instruction": "修", "agentProfileId": "builtin:fixer"}}
        ],
        "edges": [
            {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "ai", "port": "input"}}
        ],
        "groups": []
    });
    let profile = aiwf_engine::executor::AgentProfile {
        id: "builtin:fixer".to_string(),
        name: "修复者".to_string(),
        role: "fixer".to_string(),
        goal: String::new(),
        persona: String::new(),
        runtime: "acp.codex".to_string(),
        model_ref: String::new(),
        fallback_model_ref: String::new(),
        output_contract: String::new(),
        capabilities_json: "{}".to_string(),
        timeout_ms: 0,
    };
    let report = aiwf_engine::preflight::dry_run_with_profiles(
        &graph(with_ai),
        &std::env::temp_dir(),
        &[profile],
    );
    let check = report
        .checks
        .iter()
        .find(|c| c.label.contains("Agent 角色"))
        .expect("有引用就要有检查项");
    assert_eq!(check.status, CheckStatus::Passed);
}

#[test]
fn 只当审批者的角色也会被加载_不被误报不存在() {
    // codex 复核抓到的接缝:check_agent_profiles 查 deciderAgentProfileId,
    // 而加载器只收 agentProfileId —— 一个真实存在、只当 AI 审批者的角色
    // 会被 Dry Run 误报「不存在」,运行时 gate_runtime 也拿不到它
    let store = aiwf_store::Store::open_in_memory().unwrap();
    store
        .create_agent(&aiwf_store::NewAgent {
            name: "把关人".to_string(),
            role: "审批".to_string(),
            goal: String::new(),
            persona: String::new(),
            runtime: "acp.codex".to_string(),
            model_ref: String::new(),
            fallback_model_ref: None,
            tools: Vec::new(),
            capabilities_json: "{}".to_string(),
            output_contract: String::new(),
            turn_limit: 6,
            timeout_ms: 60000,
        })
        .map(|id| {
            let graph = graph(serde_json::json!({
                "nodes": [
                    {"id": "entry", "type": "entry", "title": "入口", "config": {}},
                    {"id": "gate", "type": "approval", "title": "把关",
                     "config": {"title": "确认", "decider": "agent", "deciderAgentProfileId": id}}
                ],
                "edges": [
                    {"id": "e1", "source": {"nodeId": "entry", "port": "success"}, "target": {"nodeId": "gate", "port": "input"}}
                ],
                "groups": []
            }));
            let profiles = aiwf_engine::runner::agent_profiles_for_graph(&store, &graph).unwrap();
            assert_eq!(profiles.len(), 1, "审批者角色要被加载");

            let report = aiwf_engine::preflight::dry_run_with_profiles(
                &graph,
                &std::env::temp_dir(),
                &profiles,
            );
            let check = report
                .checks
                .iter()
                .find(|c| c.label.contains("Agent 角色"))
                .expect("有引用就有检查");
            assert_eq!(
                check.status,
                CheckStatus::Passed,
                "真实存在的审批者角色不该被误报:{}",
                check.detail
            );
        })
        .unwrap();
}
