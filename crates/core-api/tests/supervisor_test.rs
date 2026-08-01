//! 主管 AI 回答里的结构化提议。
//!
//! 「AI 的改动一律先进 propose（出 Diff），用户确认才落草稿」——
//! 要出 Diff 就得先有结构化操作，而模型给回来的是一段自然语言文本。
//! 从里面抠出 JSON 是整条链路最脆的一环，所以单独压一层测试。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_core_api::extract_proposal;

#[test]
fn 抠得出围栏代码块里的提议() {
    let answer = r#"我看了一下，这条流程缺一个人工确认。

```aiwf-proposal
{
  "summary": "在「分析」后插入人工审批",
  "operations": [
    {"op": "renameNode", "nodeId": "n1", "title": "分析根因"}
  ]
}
```

接受的话我就写进草稿。"#;

    let (text, proposal) = extract_proposal(answer);
    let proposal = proposal.expect("应当抠得出提议");
    assert_eq!(proposal.summary, "在「分析」后插入人工审批");
    assert_eq!(proposal.operations.len(), 1);
    // 围栏那段要从展示文本里去掉 —— 用户看的是 Diff，不是 JSON
    assert!(!text.contains("aiwf-proposal"), "实际：{text}");
    assert!(text.contains("缺一个人工确认"));
}

#[test]
fn 纯问答不产生提议() {
    let (text, proposal) = extract_proposal("上次失败是因为脚本超时了。");
    assert!(proposal.is_none());
    assert_eq!(text, "上次失败是因为脚本超时了。");
}

#[test]
fn 坏掉的_json_当作没有提议而不是报错() {
    // 模型偶尔会写出不合法的 JSON。整个回答因此报错的话，
    // 用户连那句自然语言解释都看不到 —— 而那句话往往是有用的
    let answer = "试试这个\n\n```aiwf-proposal\n{ 这不是 JSON\n```\n";
    let (text, proposal) = extract_proposal(answer);
    assert!(proposal.is_none());
    assert!(text.contains("试试这个"));
}

// ── 会话内容的脱敏 ──────────────────────────────────────────────────────
//
// 主管 AI 的回答可能带着密钥形态的内容 —— 实测：runtime 上游 502 时,
// codex 把带 `sec-…` 令牌的网关 URL 原样写进回答文本,它随后进库、
// 进界面、进历史。与 run.events 的读取兜底同一条理由:
// 脱敏规则会补新形态,规则加之前写下的历史消息仍带明文。

#[test]
fn 历史会话的消息读取时脱敏() {
    let dir = tempfile::tempdir().unwrap();
    let store = aiwf_store::Store::open_workspace(&dir.path().join("aiwf.sqlite")).unwrap();
    let id = store
        .create_supervisor_session("普通问题", None, None)
        .unwrap();
    store
        .append_supervisor_message(
            &id,
            "agent",
            "上游报错:https://api.example.com/sec-FAKE0123456789abcdef012345/v1/responses",
        )
        .unwrap();

    let detail = aiwf_core_api::supervisor_session(&store, id).unwrap();
    let text = &detail.messages[0].text;
    assert!(
        !text.contains("FAKE0123456789abcdef012345"),
        "sec- 令牌原样送到了界面:{text}"
    );
    assert!(text.contains("上游报错"), "脱敏不该把正文吞掉:{text}");
}

#[test]
fn 会话列表的标题读取时脱敏() {
    // 标题取自第一句提问 —— 用户可能把密钥直接粘进问题里。
    // token 要短于标题的 40 字符截断,否则被切掉一截后正则匹配不上,
    // 这条测试就是假绿(第一版真的犯了这个错)
    let dir = tempfile::tempdir().unwrap();
    let store = aiwf_store::Store::open_workspace(&dir.path().join("aiwf.sqlite")).unwrap();
    store
        .create_supervisor_session("看看 sk-FAKEabcdef0123456 咋回事", None, None)
        .unwrap();

    let sessions = aiwf_core_api::supervisor_sessions(&store, None).unwrap();
    assert!(
        !sessions[0].title.contains("FAKEabcdef0123456"),
        "密钥出现在会话列表标题里:{}",
        sessions[0].title
    );
    assert!(sessions[0].title.contains("咋回事"), "脱敏不该吞掉正文");
}

#[test]
fn 操作不合契约时整个提议作废() {
    // 半个能用的提议比没有更危险：用户看到 Diff 少了一半却以为是全部
    let answer = r#"```aiwf-proposal
{"summary":"乱改","operations":[{"op":"renameNode","nodeId":"n1","title":"好"},{"op":"炸掉一切"}]}
```"#;
    let (_, proposal) = extract_proposal(answer);
    assert!(proposal.is_none(), "有一个操作不合契约就该整个作废");
}

#[test]
fn 空操作列表不算提议() {
    let answer = r#"```aiwf-proposal
{"summary":"什么都没改","operations":[]}
```"#;
    assert!(extract_proposal(answer).1.is_none());
}

#[test]
fn 缺_summary_不算提议() {
    // Diff 上面那句话是用户判断要不要接受的依据
    let answer = r#"```aiwf-proposal
{"operations":[{"op":"removeNode","nodeId":"n1"}]}
```"#;
    assert!(extract_proposal(answer).1.is_none());
}

#[test]
fn 只取第一段提议() {
    // 模型有时会给两个方案。都接受的话它们会互相打架，
    // 而用户以为自己只批准了一个
    let answer = r#"方案一
```aiwf-proposal
{"summary":"方案一","operations":[{"op":"removeNode","nodeId":"a"}]}
```
方案二
```aiwf-proposal
{"summary":"方案二","operations":[{"op":"removeNode","nodeId":"b"}]}
```"#;
    let (_, proposal) = extract_proposal(answer);
    assert_eq!(proposal.expect("应有提议").summary, "方案一");
}

#[test]
fn 普通的_json_代码块不会被当成提议() {
    // 用户问「这个节点的配置长什么样」时，模型会贴一段 JSON ——
    // 那是解释，不是要改东西
    let answer = "配置长这样：\n\n```json\n{\"script\":\"echo hi\"}\n```\n";
    let (text, proposal) = extract_proposal(answer);
    assert!(proposal.is_none());
    assert!(text.contains("```json"), "普通代码块要原样留着");
}

#[test]
fn patch_操作名与契约一致() {
    // Rust 侧不镜像 12 种 op 的完整结构（那等于维护第二份契约），
    // 只留一个名单做最小校验 —— 而名单会漂移，所以对着生成物校一遍。
    //
    // 多出来的会让非法提议被放行，少掉的会让合法提议被整个作废。
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/generated/contracts.meta.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到契约生成物 {}：{e}。先跑 pnpm contracts:gen",
            path.display()
        )
    });
    let meta: serde_json::Value = serde_json::from_str(&raw).unwrap();

    let expected: std::collections::BTreeSet<String> = meta["patchOps"]
        .as_array()
        .expect("契约生成物缺少 patchOps")
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let actual: std::collections::BTreeSet<String> = aiwf_core_api::patch_ops()
        .iter()
        .map(|s| (*s).to_string())
        .collect();

    assert_eq!(actual, expected, "Rust 侧的 patch 操作名与契约不一致");
}

/// 主管 AI 得知道自己在哪。
///
/// codex 第二轮的原话：问它「怎么创建并运行一个最简单的工作流」，
/// 它回答「目前我对这个应用一无所知」，要求放开 `ls`、提供项目路径或截图。
///
/// 而抽屉顶上写着「掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置」——
/// 提示词里一个字都没提这些，那句话就是假的。
mod 应用上下文 {
    use aiwf_core_api::{SupervisorTools, supervisor_prompt};

    #[test]
    fn 开头就说清它是谁_在哪() {
        let prompt = supervisor_prompt(
            "怎么新建工作流？",
            &[],
            None,
            None,
            SupervisorTools::SystemMcp,
        );
        assert!(
            prompt.contains("AI Workflows"),
            "没告诉它应用叫什么：{prompt}"
        );
        assert!(prompt.contains("主管"), "没说明它的角色");
    }

    #[test]
    fn 列出用户能去的每一屏() {
        let prompt = supervisor_prompt(
            "这个应用能做什么？",
            &[],
            None,
            None,
            SupervisorTools::SystemMcp,
        );
        for 屏 in [
            "工作流",
            "画布编辑器",
            "执行记录",
            "记忆",
            "Agent",
            "提示词",
            "模型",
            "设置",
        ] {
            assert!(prompt.contains(屏), "没提到「{屏}」这一屏：{prompt}");
        }
    }

    #[test]
    fn 说清草稿与版本的区别_那是最容易问到的概念() {
        let prompt = supervisor_prompt(
            "rev 和 v 有什么区别？",
            &[],
            None,
            None,
            SupervisorTools::SystemMcp,
        );
        assert!(prompt.contains("草稿"), "没解释草稿");
        assert!(prompt.contains("版本"), "没解释版本");
    }

    #[test]
    fn 有工具时说清它能直接操作_并指路到该先读什么() {
        // 说没有工具而实际有，它会一路建议用户「你去点这里」，
        // 而它本可以自己做完 —— 那正是这条提示词长期的样子
        let prompt = supervisor_prompt(
            "帮我搭一条修 issue 的工作流并跑起来",
            &[],
            None,
            None,
            SupervisorTools::SystemMcp,
        );
        assert!(prompt.contains("系统 MCP"), "没说它有工具：{prompt}");
        for 指路 in [
            "aiwf://guide/build-and-run",
            "aiwf://catalog/nodes",
            "aiwf://workspace/inventory",
        ] {
            assert!(prompt.contains(指路), "没指路到 {指路}");
        }
        // 三条最容易踩的：端口靠猜、baseRevision 硬试、跳过 Dry Run
        assert!(prompt.contains("baseRevision"), "没提版本守卫");
        assert!(prompt.contains("Dry Run"), "没提先做依赖检查");
    }

    #[test]
    fn 没工具时明说没有_而不是假装查过() {
        // 说有而实际没有，它会「调用 workflow_list」然后凭空编一份清单出来
        let prompt =
            supervisor_prompt("现在有哪些工作流？", &[], None, None, SupervisorTools::None);
        assert!(prompt.contains("没有工具可用"), "{prompt}");
        assert!(
            prompt.contains("MCP 与集成"),
            "要告诉用户去哪儿恢复：{prompt}"
        );
        // 不该同时出现「你能直接操作」那一段
        assert!(!prompt.contains("你接着这个应用的系统 MCP"), "两段说反了");
    }

    #[test]
    fn 写操作要不要确认由权限档决定_提示词说清这件事() {
        // 被挡住时反复重试是最常见的失败方式 —— 提示词要先说清
        let prompt = supervisor_prompt("发布这条流程", &[], None, None, SupervisorTools::SystemMcp);
        assert!(prompt.contains("权限档"), "{prompt}");
        assert!(prompt.contains("别反复重试"), "{prompt}");
    }

    #[test]
    fn 用户的问题在最后_不被前面的说明淹掉() {
        let prompt = supervisor_prompt("我的问题", &[], None, None, SupervisorTools::SystemMcp);
        assert!(prompt.trim_end().ends_with("我的问题"), "问题不在末尾");
    }

    #[test]
    fn 有记忆时把记忆也拼进去() {
        let memories = [("worktree.cleanup".to_string(), "PR 合并前保留".to_string())];
        let prompt = supervisor_prompt(
            "怎么清理 worktree？",
            &memories,
            None,
            None,
            SupervisorTools::SystemMcp,
        );
        assert!(prompt.contains("worktree.cleanup"));
        assert!(prompt.contains("PR 合并前保留"));
    }

    #[test]
    fn 有草稿图时才教它怎么提改动() {
        let 无图 = supervisor_prompt("你好", &[], None, None, SupervisorTools::SystemMcp);
        assert!(
            !无图.contains("aiwf-proposal"),
            "没打开任何工作流时教它提改动，它会对着空气提"
        );

        let 有图 = supervisor_prompt(
            "加个审批节点",
            &[],
            None,
            Some(r#"{"nodes":[]}"#),
            SupervisorTools::SystemMcp,
        );
        assert!(有图.contains("aiwf-proposal"));
    }
}

/// 主管 AI 优先用 codex 的 adapter。
///
/// 用户的要求：「测试和尝试不要使用 claude 的 acp，尽可能使用 codex 的 acp」。
/// 这个应用本身跑在 Claude Code 里开发，用 claude 的 adapter 做测试会
/// 与开发环境互相干扰（嵌套的 agent 会话、共用的登录态、同一份配额）。
mod adapter选择 {
    use aiwf_core_api::preferred_acp_runtime;

    #[test]
    fn 两个都装了时选_codex() {
        assert_eq!(
            preferred_acp_runtime(&["acp.claude", "acp.codex"]),
            Some("acp.codex")
        );
    }

    #[test]
    fn 只有_claude_时也能用_它是能跑的() {
        // 「尽可能」不是「绝不」——只装了 claude 的机器上仍要能用
        assert_eq!(preferred_acp_runtime(&["acp.claude"]), Some("acp.claude"));
    }

    #[test]
    fn 一个都没装时返回_none() {
        assert_eq!(preferred_acp_runtime(&[]), None);
    }

    #[test]
    fn 顺序不影响结果() {
        assert_eq!(
            preferred_acp_runtime(&["acp.codex", "acp.claude"]),
            Some("acp.codex")
        );
    }
}
