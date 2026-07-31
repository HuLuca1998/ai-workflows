//! 系统级 MCP 的工具清单。
//!
//! 「一键把本地 ACP 模型接进来，拿到系统的全部知识与能力」——
//! 这条测试守的是那个「全部」：清单由契约派生，不手工维护第二份，
//! 漏一个的症状是「界面上能做的事，Agent 说它做不到」。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_mcp::catalog::{self, WriteGate};

/// 契约里 `scope: null` 的方法 —— 本地专属，不对 MCP 开放。
///
/// 这份名单**只是把契约里的事实抄过来**，抄错了下面那条测试会红。
/// 不直接读生成物是因为要在断言里说清「为什么这个不在」。
const 本地专属: &[&str] = &[
    "mcp_pending_confirms",
    "mcp_decide_confirm",
    // 回答只能由本地 UI 给 —— 开给远端等于让 agent 自己回答自己的问题，
    // 与 decide_confirm 是同一条理由
    "mcp_answer_ask",
    // 把 MCP 自己的接线情况暴露给 MCP，等于让 Agent 看得见自己的令牌，
    // 而那个令牌就是它的全部权限
    "mcp_status",
    "mcp_connect",
    "model_test",
    // 会在这台机器上拉起 adapter 进程 —— 与 model_test 同一条理由。
    // 开给远端等于让它反复起本机进程，而回报只是一份模型清单
    "model_sync",
    "run_diagnostics",
    "env_diagnostics",
    // 探测本机文件系统。开给外部客户端的话，一个 Agent 能拿它
    // 把用户的目录结构扫一遍 —— 每次调用都是一次
    // 「这个路径存不存在、写不写得进去」的确定回答
    "env_check_directory",
    // 一键初始化。这不是「怕 Agent 扩权」，是这条命令的语义本身 ——
    // 它把用户全部的工作流、运行记录与产物清掉重来。权限档挡不住它，
    // 因为它压根不属于「文件读写 / 执行命令 / 访问网络」里的任何一档。
    // 预览一并挡住：它报的是用户机器上的真实路径
    "workspace_reset",
    "workspace_reset_preview",
];

#[test]
fn 每个可分派的命令都是一个工具() {
    let 暴露: Vec<&str> = catalog::tools().iter().map(|t| t.name.as_str()).collect();

    let 漏掉的: Vec<&str> = aiwf_core_api::COMMANDS
        .iter()
        .copied()
        .filter(|name| !暴露.contains(name))
        .filter(|name| !catalog::DELIBERATELY_HIDDEN.contains(name))
        .filter(|name| !本地专属.contains(name))
        .collect();

    assert!(
        漏掉的.is_empty(),
        "这些能力界面上有、MCP 里没有：{漏掉的:?}。\
         真要藏就写进 DELIBERATELY_HIDDEN 并说明理由"
    );
}

#[test]
fn 本地专属那份名单与契约一致() {
    // 名单是手抄的，会过期。契约里给某个方法补了 scope 之后，
    // 它就该自动出现在 MCP 里 —— 那时这条会红，提醒把它从名单里划掉
    let schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/generated/core-api.schema.json"
    ))
    .expect("契约生成物读不出来");

    let 契约说的: Vec<String> = schema
        .as_object()
        .expect("生成物不是对象")
        .iter()
        .filter(|(_, entry)| entry["scope"].is_null())
        .map(|(method, _)| {
            let (head, tail) = method.split_once('.').unwrap_or((method.as_str(), ""));
            let mut out = format!("{head}_");
            for ch in tail.chars() {
                if ch.is_ascii_uppercase() {
                    out.push('_');
                    out.push(ch.to_ascii_lowercase());
                } else {
                    out.push(ch);
                }
            }
            out
        })
        // 契约里有、但引擎压根不能分派的（env_install）不算数
        .filter(|name| aiwf_core_api::COMMANDS.contains(&name.as_str()))
        .collect();

    let mut 期望: Vec<String> = 契约说的;
    期望.sort();
    let mut 实际: Vec<String> = 本地专属.iter().map(|s| (*s).to_string()).collect();
    实际.sort();

    assert_eq!(实际, 期望, "本地专属名单与契约的 scope: null 对不上");
}

#[test]
fn 确认通道自己不能当工具暴露() {
    // 把 mcp_decide_confirm 给 Agent，等于让它批准自己的写操作 ——
    // 「AI 建议 ≠ 执行」当场作废，而且用户看不出来
    for name in [
        "mcp_decide_confirm",
        "mcp_request_confirm",
        "mcp_confirm_status",
        "mcp_pending_confirms",
    ] {
        assert!(
            catalog::tool(name).is_none(),
            "{name} 不该出现在 MCP 工具清单里"
        );
        assert!(
            catalog::DELIBERATELY_HIDDEN.contains(&name),
            "{name} 得写进 DELIBERATELY_HIDDEN，否则下一个人会以为是漏了"
        );
    }
}

#[test]
fn 整份回写不对_agent_开放() {
    // workflow_save_draft 是留给界面的那条路：界面在本地已经走过一次
    // applyPatch，Diff 给用户看过了。开给 Agent 等于给 workflow_patch
    // 的版本守卫与结构化审计开了一条旁路
    assert!(catalog::tool("workflow_save_draft").is_none());
    assert!(catalog::tool("workflow_patch").is_some(), "改图得有路走");
}

#[test]
fn 每个工具都有可用的入参_schema() {
    for tool in catalog::tools() {
        assert!(!tool.description.is_empty(), "{} 没有描述", tool.name);
        assert_eq!(
            tool.input_schema.get("type").and_then(|v| v.as_str()),
            Some("object"),
            "{} 的入参 schema 不是 object —— MCP 客户端只认这种",
            tool.name
        );
        // $schema 留在里面会让部分客户端拒绝加载整份清单
        assert!(
            tool.input_schema.get("$schema").is_none(),
            "{} 的入参 schema 还带着 $schema",
            tool.name
        );
    }
}

#[test]
fn 工具名只用安全字符() {
    // MCP 客户端会把工具名拼进自己的命名空间（Claude Code 是
    // `mcp__<server>__<tool>`）。点号在部分客户端里会被当成路径分隔
    for tool in catalog::tools() {
        assert!(
            tool.name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "{} 里有不安全的字符",
            tool.name
        );
    }
}

#[test]
fn 只读工具标了_read_only_hint() {
    let list = catalog::tool("workflow_list").expect("workflow_list 应该在");
    assert!(list.read_only, "列清单是只读的");
    assert!(!list.mutates);

    let publish = catalog::tool("workflow_publish").expect("workflow_publish 应该在");
    assert!(!publish.read_only, "发布会改状态");
    assert!(publish.mutates);
}

#[test]
fn 权限档决定写操作要不要先确认() {
    let 读 = catalog::tool("workflow_list").unwrap();
    let 改草稿 = catalog::tool("workflow_patch").unwrap();
    let 发布 = catalog::tool("workflow_publish").unwrap();
    let 起运行 = catalog::tool("run_start").unwrap();

    // 最严：任何写都要人点一下
    for tool in [改草稿, 发布, 起运行] {
        assert_eq!(
            catalog::gate_for(tool, "review_every_change"),
            WriteGate::NeedsConfirm,
            "{} 在 review_every_change 下必须确认",
            tool.name
        );
    }

    // 中间档：改草稿放行（可回滚、有 Diff），发布与运行仍要确认
    assert_eq!(
        catalog::gate_for(改草稿, "workspace_safe"),
        WriteGate::Allow
    );
    assert_eq!(
        catalog::gate_for(发布, "workspace_safe"),
        WriteGate::NeedsConfirm
    );
    assert_eq!(
        catalog::gate_for(起运行, "workspace_safe"),
        WriteGate::NeedsConfirm
    );

    // 最宽：全放行
    for tool in [改草稿, 发布, 起运行] {
        assert_eq!(
            catalog::gate_for(tool, "trusted_workflow"),
            WriteGate::Allow
        );
    }

    // 只读的一律直接放行，与档位无关
    for preset in ["review_every_change", "workspace_safe", "trusted_workflow"] {
        assert_eq!(catalog::gate_for(读, preset), WriteGate::Allow);
    }
}

#[test]
fn 认不出来的权限档按最严处理() {
    // 数据库里躺着一个拼错的值、或者以后加了新档而这里没跟上 ——
    // 两种情况都该是「先问用户」，而不是「放行」
    let 发布 = catalog::tool("workflow_publish").unwrap();
    for preset in ["", "TRUSTED_WORKFLOW", "随便写的"] {
        assert_eq!(
            catalog::gate_for(发布, preset),
            WriteGate::NeedsConfirm,
            "认不出的档位 {preset:?} 必须按最严处理"
        );
    }
}

#[test]
fn 工具描述里带上了_scope_与副作用() {
    // Agent 选工具时只看得到 description。不写清楚的话它会拿
    // workflow_delete 去「清理一下」，而那是不可逆的
    let 删除 = catalog::tool("workflow_delete").unwrap();
    assert!(
        删除.description.contains("写操作"),
        "写操作要在描述里说出来：{}",
        删除.description
    );
}

/// 会改变安全边界本身的工具，任何档位下都要先问用户。
///
/// `gate_for` 只看 scope 与 destructive。而 `workspace.updateSettings`
/// 的 scope 是 `workflow:write-draft` 且不在 destructive 名单里 ——
/// 于是 `workspace_safe` 档下它直接 Allow。
///
/// 实测：一次免确认调用就能把权限档改成 `trusted_workflow`，
/// 之后 `workflow_delete` 不再需要确认、`workdir` 还能被改成 `/`。
/// 而这一档的含义本来写着「改草稿放行……发布、运行、删除仍要确认」——
/// 三条一次性全解除了。
///
/// 用户在设置页选的是「中间档」，得到的是一个可被单方面升级的档。
mod 改边界的工具任何档位都要确认 {
    use super::*;

    /// 这些工具改的不是数据，是**这个系统还会不会拦你**。
    const 改边界的: &[&str] = &["workspace_update_settings", "supervisor_ask"];

    #[test]
    fn 中间档下也拦() {
        for name in 改边界的 {
            let tool = catalog::tool(name).unwrap_or_else(|| panic!("没有 {name} 这个工具"));
            assert_eq!(
                catalog::gate_for(tool, "workspace_safe"),
                catalog::WriteGate::NeedsConfirm,
                "{name} 在 workspace_safe 下被放行了 —— 一次调用就能把这一档自己解除"
            );
        }
    }

    #[test]
    fn 最松那档仍然放行_那是用户明说过的() {
        // trusted_workflow 的含义就是「这条工作流我信得过」。
        // 连它都拦的话，这一档就没有存在的意义了
        for name in 改边界的 {
            let Some(tool) = catalog::tool(name) else {
                continue;
            };
            assert_eq!(
                catalog::gate_for(tool, "trusted_workflow"),
                catalog::WriteGate::Allow,
                "{name}"
            );
        }
    }

    #[test]
    fn 名单里的工具都真实存在() {
        // 拼错一个名字，那条防线就静默失效了 —— 而 gate_for 照常返回 Allow
        for name in 改边界的 {
            assert!(catalog::tool(name).is_some(), "{name} 不在工具清单里");
        }
    }
}

/// 以后新加一个能改设置的写工具而忘了进名单时，这条会红。
///
/// 名单是手写的，手写的名单会过时 —— 而它过时的方式恰好是
/// 「新的提权口子没被拦住」。按名字启发式地扫一遍：
/// scope 是 write-draft、名字里带 setting/config/preset 的写工具，
/// 都该在 `CHANGES_THE_BOUNDARY` 里。
///
/// 误判了就把那个工具加进名单（多问一次用户），或者改它的 scope ——
/// 两种都比漏掉一个提权口子好。
#[test]
fn 新的改设置工具必须进名单() {
    let 可疑: Vec<&str> = catalog::tools()
        .iter()
        .filter(|tool| tool.mutates)
        .filter(|tool| tool.scope.as_deref() == Some("workflow:write-draft"))
        .filter(|tool| {
            ["setting", "config", "preset", "permission"]
                .iter()
                .any(|词| tool.name.contains(词))
        })
        .filter(|tool| {
            catalog::gate_for(tool, "workspace_safe") != catalog::WriteGate::NeedsConfirm
        })
        .map(|tool| tool.name.as_str())
        .collect();

    assert!(
        可疑.is_empty(),
        "这些工具看着能改配置，却在 workspace_safe 下免确认 —— \
         要么加进 CHANGES_THE_BOUNDARY，要么给它一个更合适的 scope：{可疑:?}"
    );
}
