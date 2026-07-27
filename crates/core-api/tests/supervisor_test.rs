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
