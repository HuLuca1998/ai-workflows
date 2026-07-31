//! 命令名 → `aiwf-core-api` 函数的分派。
//!
//! 参数从 JSON 里按名字取，缺了必填项就报 VALIDATION——
//! 让 serde 直接反序列化成结构体会更短，但错误信息会变成
//! 「missing field」这种对使用者毫无帮助的话。
//!
//! **住在 core-api 里而不是某个调用方里。** 原先它在 devserver 下，
//! 于是「按名字调一个命令」这件事只有开发桥接会做；系统级 MCP
//! 也要按名字调同一批命令，抄一份的话两份会各自漂移 ——
//! 而漂移的症状是「Claude Code 里某个工具报未知命令，界面上却好用」。
//! `parity_test` 盯着这里与桌面壳的命令表一致。

use std::sync::Mutex;

use crate as api;
use crate::{ApiError, ApiResult};
use aiwf_engine::supervisor::Supervisor;
use aiwf_store::Store;
use serde_json::Value;

pub fn dispatch(
    command: &str,
    input: &Value,
    store: &Mutex<Store>,
    supervisor: &Supervisor,
    data_dir: &std::path::Path,
) -> ApiResult<Value> {
    // mut 是给 workspace_reset 的：它要在同一条连接上 DROP 再重建
    let mut store = store.lock().map_err(|_| ApiError {
        code: "INTERNAL".to_string(),
        message: "数据库锁已损坏，需要重启服务".to_string(),
        retriable: false,
        hint: None,
    })?;

    match command {
        "supervisor_ask" => to_value(api::supervisor_ask(
            &store,
            data_dir,
            string(input, "question")?,
            // 两个名字都认：桌面壳的 IPC 映射发的是 contextJson，
            // 而这里原先只读 context —— Web 形态下上下文整段丢失
            // （`docs/acp/07-violations.md` H-10）
            input
                .get("context")
                .map(ToString::to_string)
                .or_else(|| opt_string(input, "contextJson")),
            opt_string(input, "sessionId"),
            opt_string(input, "modelRef"),
        )?),
        "supervisor_sessions" => {
            to_value(api::supervisor_sessions(&store, opt_int(input, "limit"))?)
        }
        "supervisor_session" => to_value(api::supervisor_session(
            &store,
            string(input, "sessionId")?,
        )?),
        "memory_list" => to_value(api::memory_list(
            &store,
            opt_string(input, "scope"),
            opt_string(input, "query"),
            opt_int(input, "limit"),
            opt_int(input, "offset"),
        )?),
        "memory_create" => to_value(api::memory_create(
            &store,
            string(input, "scope")?,
            opt_string(input, "scopeId"),
            string(input, "key")?,
            string(input, "value")?,
            opt_string(input, "source"),
            opt_string(input, "createdBy"),
            strings(input, "tags"),
        )?),
        "memory_update" => to_value(api::memory_update(
            &store,
            string(input, "id")?,
            int(input, "baseVer")?,
            opt_string(input, "value"),
            opt_strings(input, "tags"),
        )?),
        "memory_toggle" => to_value(api::memory_toggle(
            &store,
            string(input, "id")?,
            boolean(input, "enabled"),
        )?),
        "memory_delete" => to_value(api::memory_delete(&store, string(input, "id")?)?),
        "prompt_list" => to_value(api::prompt_list(
            &store,
            opt_string(input, "group"),
            opt_string(input, "query"),
            opt_int(input, "limit"),
            opt_int(input, "offset"),
        )?),
        "prompt_create" => to_value(api::prompt_create(
            &store,
            string(input, "group")?,
            string(input, "name")?,
            string(input, "sectionsJson")?,
            opt_string(input, "varsJson"),
        )?),
        "prompt_versions" => to_value(api::prompt_versions(&store, string(input, "promptId")?)?),
        "prompt_update" => to_value(api::prompt_update(
            &store,
            string(input, "id")?,
            int(input, "ver")?,
            opt_string(input, "name"),
            opt_string(input, "sectionsJson"),
            opt_string(input, "varsJson"),
            opt_string(input, "changedBy"),
        )?),
        "prompt_duplicate" => to_value(api::prompt_duplicate(
            &store,
            string(input, "id")?,
            string(input, "name")?,
        )?),
        "prompt_delete" => to_value(api::prompt_delete(&store, string(input, "id")?)?),
        "agent_list" => to_value(api::agent_list(
            &store,
            opt_string(input, "query"),
            opt_int(input, "limit"),
            opt_int(input, "offset"),
        )?),
        "agent_create" => to_value(api::agent_create(
            &store,
            string(input, "name")?,
            string(input, "role")?,
            opt_string(input, "goal").unwrap_or_default(),
            opt_string(input, "persona").unwrap_or_default(),
            string(input, "runtime")?,
            string(input, "modelRef")?,
            opt_string(input, "fallbackModelRef"),
            strings(input, "tools"),
            input.get("capabilities").map(ToString::to_string),
            opt_string(input, "outputContract").unwrap_or_default(),
            opt_int(input, "turnLimit"),
            opt_int(input, "timeoutMs"),
        )?),
        "agent_update" => to_value(api::agent_update(
            &store,
            string(input, "id")?,
            int(input, "ver")?,
            api::AgentEdit {
                name: opt_string(input, "name"),
                goal: opt_string(input, "goal"),
                persona: opt_string(input, "persona"),
                model_ref: opt_string(input, "modelRef"),
                fallback_model_ref: opt_string(input, "fallbackModelRef"),
                // capabilities 是对象，原样序列化回字符串交给存储层 ——
                // 让 serde 解一个任意 Value 会把「能力长什么样」从契约里糊掉
                capabilities_json: input.get("capabilities").map(ToString::to_string),
                tools: input
                    .get("tools")
                    .and_then(|value| value.as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|item| item.as_str().map(str::to_string))
                            .collect()
                    }),
                output_contract: opt_string(input, "outputContract"),
            },
        )?),
        "agent_duplicate" => to_value(api::agent_duplicate(
            &store,
            string(input, "id")?,
            string(input, "name")?,
        )?),
        "agent_delete" => to_value(api::agent_delete(&store, string(input, "id")?)?),
        "model_list" => to_value(api::model_list(
            &store,
            boolean(input, "enabledOnly"),
            opt_string(input, "query"),
            opt_int(input, "limit"),
            opt_int(input, "offset"),
        )?),
        "model_create" => to_value(api::model_create(
            &store,
            string(input, "name")?,
            string(input, "runtime")?,
            string(input, "modelId")?,
            string(input, "effort")?,
            int(input, "contextWindow")?,
            strings(input, "capabilities"),
            opt_string(input, "credentialRef"),
            boolean(input, "enabled"),
        )?),
        "model_test" => to_value(api::model_test(&store, string(input, "id")?)?),
        "model_update" => to_value(api::model_update(
            &store,
            string(input, "id")?,
            opt_string(input, "name"),
            opt_string(input, "runtime"),
            opt_string(input, "modelId"),
            opt_string(input, "effort"),
            opt_int(input, "contextWindow"),
            opt_strings(input, "capabilities"),
            opt_string(input, "credentialRef"),
            opt_bool(input, "enabled"),
        )?),
        "model_delete" => to_value(api::model_delete(&store, string(input, "id")?)?),
        "run_start" => to_value(api::run_start(
            &store,
            supervisor,
            data_dir,
            string(input, "workflowId")?,
            opt_string(input, "versionId"),
            opt_int(input, "draftRev"),
            string(input, "inputsJson")?,
            opt_string(input, "workdir"),
        )?),
        "run_dry_run" => to_value(api::run_dry_run(
            &store,
            data_dir,
            string(input, "workflowId")?,
            opt_string(input, "versionId"),
            opt_int(input, "draftRev"),
            opt_string(input, "workdir"),
        )?),
        "run_list" => to_value(api::run_list(
            &store,
            opt_string(input, "workflowId"),
            strings(input, "statuses"),
            opt_string(input, "query"),
            opt_int(input, "limit"),
            opt_int(input, "offset"),
        )?),
        "run_get" => to_value(api::run_get(&store, string(input, "runId")?)?),
        "run_events" => to_value(api::run_events(
            &store,
            string(input, "runId")?,
            int(input, "fromSeq")?,
            int(input, "limit")?,
        )?),
        "run_artifacts" => to_value(api::run_artifacts(&store, string(input, "runId")?)?),
        "run_cancel" => to_value(api::run_cancel(
            &store,
            supervisor,
            string(input, "runId")?,
        )?),
        "run_rewind_to_approval" => to_value(api::run_rewind_to_approval(
            &store,
            string(input, "runId")?,
        )?),
        "run_resume" => to_value(api::run_resume(
            &store,
            supervisor,
            string(input, "runId")?,
        )?),
        "approval_decide" => to_value(api::approval_decide(
            &store,
            supervisor,
            string(input, "runId")?,
            string(input, "nodeId")?,
            string(input, "decision")?,
        )?),
        "workflow_list" => to_value(api::workflow_list(
            &store,
            opt_string(input, "status"),
            opt_string(input, "query"),
            opt_int(input, "limit"),
            opt_int(input, "offset"),
        )?),
        // 数据库同级的 data 目录就是运行工作目录，与 run_start 的默认一致
        "run_diagnostics" => to_value(api::run_diagnostics(
            &store,
            &data_dir.join("diagnostics"),
            string(input, "runId")?,
        )?),
        "env_diagnostics" => to_value(api::env_diagnostics(&data_dir.join("diagnostics"))?),
        "env_check_directory" => to_value(api::env::check_directory(&string(input, "path")?)?),
        "env_health" => to_value(api::env_health(
            opt_bool(input, "recheck").unwrap_or(false),
        )?),
        "github_repos" => to_value(api::github::repos(
            opt_string(input, "query"),
            opt_int(input, "limit"),
        )?),
        "github_branches" => to_value(api::github::branches(string(input, "repo")?)?),
        "workspace_stats" => to_value(api::workspace_stats(&store, Some(data_dir))?),
        "mcp_request_confirm" => to_value(api::mcp_request_confirm(
            &store,
            string(input, "tool")?,
            string(input, "inputJson")?,
        )?),
        "mcp_confirm_status" => to_value(api::mcp_confirm_status(&store, string(input, "id")?)?),
        "mcp_pending_confirms" => to_value(api::mcp_pending_confirms(&store)?),
        "mcp_decide_confirm" => to_value(api::mcp_decide_confirm(
            &store,
            string(input, "id")?,
            boolean(input, "approved"),
        )?),
        // 工具与资源的条数由 MCP crate 那边知道（它依赖 core-api，反过来不行），
        // 所以由调用方传进来。传 0 只会让界面显示 0，不会说谎成别的数
        "mcp_status" => to_value(api::mcp_status(
            data_dir,
            opt_int(input, "toolCount").unwrap_or(0),
            opt_int(input, "resourceCount").unwrap_or(0),
        )?),
        "mcp_connect" => to_value(api::mcp_connect(
            data_dir,
            string(input, "client")?,
            boolean(input, "disconnect"),
        )?),
        "workspace_settings" => to_value(api::workspace_settings(&store)?),
        "workspace_update_settings" => to_value(api::workspace_update_settings(
            &store,
            input.get("workdir").and_then(|v| v.as_str()),
            input.get("permissionPreset").and_then(|v| v.as_str()),
            input.get("envCheckedAt").and_then(|v| v.as_str()),
        )?),
        "workspace_reset_preview" => {
            let workdir = 授权目录(&store);
            to_value(api::workspace_reset_preview(
                &store,
                data_dir,
                workdir.as_deref(),
            )?)
        }
        "workspace_reset" => {
            // 契约那侧 confirm 是 z.literal(true)，但 MCP 与 HTTP 不都经过 Zod。
            // 这条命令删得掉用户全部的东西，不能指望上游都校验过
            if !boolean(input, "confirm") {
                return Err(ApiError::validation(
                    "一键初始化需要显式确认：带上 confirm: true".to_string(),
                ));
            }
            let workdir = 授权目录(&store);
            to_value(api::workspace_reset(
                &mut store,
                data_dir,
                workdir.as_deref(),
                boolean(input, "includeArtifacts"),
            )?)
        }
        "run_artifact_content" => to_value(api::run_artifact_content(
            &store,
            string(input, "runId")?,
            string(input, "path")?,
            opt_int(input, "maxBytes"),
        )?),
        // name 缺席时由引擎编号 —— 界面自己算只能看到当前页
        "workflow_create" => to_value(api::workflow_create(
            &store,
            opt_string(input, "name"),
            opt_string(input, "graphJson"),
        )?),
        "workflow_get" => to_value(api::workflow_get(&store, string(input, "id")?)?),
        "workflow_save_draft" => to_value(api::workflow_save_draft(
            &store,
            string(input, "id")?,
            int(input, "baseRev")?,
            string(input, "graphJson")?,
        )?),
        // operations 是数组，原样序列化回字符串交给引擎 ——
        // 在这一层解成结构体会把「合法操作长什么样」从契约里糊掉
        "workflow_patch" => to_value(api::workflow_patch(
            &store,
            string(input, "id")?,
            int(input, "baseRevision")?,
            input
                .get("operations")
                .map(ToString::to_string)
                .ok_or_else(|| ApiError {
                    code: "VALIDATION".to_string(),
                    message: "缺少参数 operations".to_string(),
                    retriable: false,
                    hint: None,
                })?,
            opt_string(input, "graphJson"),
        )?),
        "workflow_validate" => to_value(api::workflow_validate(
            &store,
            string(input, "id")?,
            opt_int(input, "rev"),
        )?),
        "workflow_diff" => to_value(api::workflow_diff(
            &store,
            string(input, "id")?,
            string(input, "from")?,
            string(input, "to")?,
        )?),
        "workflow_publish" => to_value(api::workflow_publish(
            &store,
            string(input, "id")?,
            int(input, "rev")?,
        )?),
        "workflow_version_graph" => to_value(api::workflow_version_graph(
            &store,
            string(input, "versionId")?,
        )?),
        "workflow_rollback" => to_value(api::workflow_rollback(
            &store,
            string(input, "id")?,
            string(input, "versionId")?,
        )?),
        "workflow_discard_if_empty" => to_value(api::workflow_discard_if_empty(
            &store,
            string(input, "id")?,
        )?),
        "workflow_rename" => to_value(api::workflow_rename(
            &store,
            string(input, "id")?,
            string(input, "name")?,
        )?),
        "workflow_delete" => to_value(api::workflow_delete(&store, string(input, "id")?)?),
        other => Err(ApiError {
            code: "VALIDATION".to_string(),
            message: format!("未知命令 {other}"),
            retriable: false,
            hint: None,
        }),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> ApiResult<Value> {
    serde_json::to_value(value).map_err(|error| ApiError {
        code: "INTERNAL".to_string(),
        message: format!("序列化返回值失败：{error}"),
        retriable: false,
        hint: None,
    })
}

fn string(input: &Value, key: &str) -> ApiResult<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError {
            code: "VALIDATION".to_string(),
            message: format!("缺少参数 {key}"),
            retriable: false,
            hint: None,
        })
}

fn opt_string(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_string)
}

fn int(input: &Value, key: &str) -> ApiResult<i64> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError {
            code: "VALIDATION".to_string(),
            message: format!("缺少参数 {key}"),
            retriable: false,
            hint: None,
        })
}

fn opt_int(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

fn boolean(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// 用户授权的工作目录。产物就落在它下面的 `.aiwf-artifacts` 里。
///
/// 读不到一律当「还没授权」：那种情况下产物目录本来就不存在，
/// 让一键初始化因为读不到设置而整个失败没有道理。
fn 授权目录(store: &Store) -> Option<std::path::PathBuf> {
    store
        .workspace_settings()
        .ok()
        .and_then(|s| s.workdir)
        .map(std::path::PathBuf::from)
}

fn opt_bool(input: &Value, key: &str) -> Option<bool> {
    input.get(key).and_then(Value::as_bool)
}

fn strings(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn opt_strings(input: &Value, key: &str) -> Option<Vec<String>> {
    input.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}
