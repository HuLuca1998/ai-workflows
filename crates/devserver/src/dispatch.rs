//! 命令名 → `aiwf-core-api` 函数的分派。
//!
//! 参数从 JSON 里按名字取，缺了必填项就报 VALIDATION——
//! 让 serde 直接反序列化成结构体会更短，但错误信息会变成
//! 「missing field」这种对使用者毫无帮助的话。

use std::sync::Mutex;

use aiwf_core_api::{self as api, ApiError, ApiResult};
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
    let store = store.lock().map_err(|_| ApiError {
        code: "INTERNAL".to_string(),
        message: "数据库锁已损坏，需要重启服务".to_string(),
        retriable: false,
    })?;

    match command {
        "supervisor_ask" => to_value(api::supervisor_ask(
            &store,
            data_dir,
            string(input, "question")?,
            input.get("context").map(ToString::to_string),
            opt_string(input, "sessionId"),
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
        "env_health" => to_value(api::env_health(
            opt_bool(input, "recheck").unwrap_or(false),
        )?),
        "workspace_stats" => to_value(api::workspace_stats(&store, Some(data_dir))?),
        "workspace_settings" => to_value(api::workspace_settings(&store)?),
        "workspace_update_settings" => to_value(api::workspace_update_settings(
            &store,
            input.get("workdir").and_then(|v| v.as_str()),
            input.get("permissionPreset").and_then(|v| v.as_str()),
            input.get("envCheckedAt").and_then(|v| v.as_str()),
        )?),
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
        }),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> ApiResult<Value> {
    serde_json::to_value(value).map_err(|error| ApiError {
        code: "INTERNAL".to_string(),
        message: format!("序列化返回值失败：{error}"),
        retriable: false,
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
        })
}

fn opt_int(input: &Value, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

fn boolean(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
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
