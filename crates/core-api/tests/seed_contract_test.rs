//! 内置种子数据必须过契约。
//!
//! 用户在界面上看到的是一条红字：「prompt.list 的返回值不合契约」，
//! 而这是一个**刚装好的应用第一屏**就撞上的 —— 提示词库与记忆两页全空。
//!
//! 坏的不是 DTO：字段一个不少。坏在种子 SQL 写进去的**值**：
//! `datetime('now')` 出的是 `2026-07-29 08:15:26`（契约要 ISO 8601），
//! prompt 的 vars 写成 `{required, description}`（契约要 `{source, onMissing}`），
//! memory 的 source 写 `'builtin'`（契约枚举里只有 user / ai_proposed / system）。
//!
//! `packages/contracts/tests/dto-drift.test.ts` 那条守卫只比**字段名**
//! （「引擎有而契约没有」），值层面的格式与枚举它看不见。这条补上那一半：
//! 拿 TypeScript 生成的 JSON Schema 校验引擎的真实输出，
//! 走的是与界面同一份 schema，所以界面报什么这里就红什么。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;
use serde_json::Value;

const 契约: &str = include_str!("../../../packages/contracts/generated/core-api.schema.json");

fn 新库() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_workspace(&dir.path().join("aiwf.sqlite")).unwrap();
    (dir, store)
}

/// 拿契约里某个方法的 output schema 校验一份返回值，返回人能读的错误清单。
///
/// 空清单就是通过。返回清单而不是 bool，是因为红的时候要能一眼看出
/// **哪个字段**违约 —— 只说「不合契约」的话，下一步还得自己去比对。
fn 违约处(method: &str, 返回值: &Value) -> Vec<String> {
    let root: Value = serde_json::from_str(契约).expect("契约生成物不是合法 JSON");
    let schema = root
        .get(method)
        .and_then(|spec| spec.get("output"))
        .unwrap_or_else(|| panic!("契约里没有 {method} 的 output"));

    let validator = jsonschema::validator_for(schema).expect("契约的 schema 编译不了");
    validator
        .iter_errors(返回值)
        .map(|e| format!("{} — {e}", e.instance_path()))
        .collect()
}

fn 转成_json<T: serde::Serialize>(值: &T) -> Value {
    serde_json::to_value(值).unwrap()
}

#[test]
fn prompt_list_的返回值过契约() {
    let (_dir, store) = 新库();
    let 页 = aiwf_core_api::prompt_list(&store, None, None, Some(50), Some(0)).unwrap();
    assert!(
        !页.items.is_empty(),
        "种子里一条提示词都没有，这条测试没在测"
    );

    let 错 = 违约处("prompt.list", &转成_json(&页));
    assert!(错.is_empty(), "内置提示词不合契约：\n{}", 错.join("\n"));
}

#[test]
fn memory_list_的返回值过契约() {
    let (_dir, store) = 新库();
    let 页 = aiwf_core_api::memory_list(&store, None, None, Some(50), Some(0)).unwrap();
    assert!(!页.items.is_empty(), "种子里一条记忆都没有，这条测试没在测");

    let 错 = 违约处("memory.list", &转成_json(&页));
    assert!(错.is_empty(), "内置记忆不合契约：\n{}", 错.join("\n"));
}

#[test]
fn agent_list_的返回值过契约() {
    let (_dir, store) = 新库();
    let 页 = aiwf_core_api::agent_list(&store, None, Some(50), Some(0)).unwrap();
    assert!(!页.items.is_empty(), "种子里一个角色都没有，这条测试没在测");

    let 错 = 违约处("agent.list", &转成_json(&页));
    assert!(
        错.is_empty(),
        "内置 Agent 角色不合契约：\n{}",
        错.join("\n")
    );
}

#[test]
fn model_list_的返回值过契约() {
    let (_dir, store) = 新库();
    let 页 = aiwf_core_api::model_list(&store, false, None, Some(50), Some(0)).unwrap();
    assert!(!页.items.is_empty(), "种子里一个模型都没有，这条测试没在测");

    let 错 = 违约处("model.list", &转成_json(&页));
    assert!(错.is_empty(), "内置模型不合契约：\n{}", 错.join("\n"));
}

/// 门禁证明不了自己会红，就不是门禁。
///
/// 下面四条都是**真实发生过**的违约形态，逐条塞进去看守卫认不认得。
/// 少了这条元测试，`违约处` 哪天因为路径写错而永远返回空清单，
/// 上面四条会一起变绿 —— 而那正是「两侧绿灯合起来像一条通的链路」。
#[test]
fn 守卫认得出每一种违约() {
    let 合法记忆 = serde_json::json!({
        "id": "m1", "scope": "workspace", "key": "k", "value": "v",
        "source": "system", "createdBy": "system",
        "createdAt": "2026-07-29T08:15:26.000Z",
        "updatedAt": "2026-07-29T08:15:26.000Z",
        "sensitivity": "internal", "ver": 1, "tags": [], "enabled": true
    });
    assert!(
        违约处(
            "memory.list",
            &serde_json::json!({ "items": [合法记忆], "total": 1 })
        )
        .is_empty(),
        "基准数据本身就不合契约，后面几条断言证明不了什么"
    );

    let 坏例: &[(&str, Value)] = &[
        // 种子写的 'builtin' —— 契约枚举里没有这一档
        (
            "memory.list",
            serde_json::json!({ "items": [{ "id": "m1", "scope": "workspace", "key": "k",
                "value": "v", "source": "builtin", "createdBy": "system",
                "createdAt": "2026-07-29T08:15:26.000Z", "updatedAt": "2026-07-29T08:15:26.000Z",
                "sensitivity": "internal", "ver": 1, "tags": [], "enabled": true }], "total": 1 }),
        ),
        // datetime('now') 出的形状：少了 T 与时区
        (
            "memory.list",
            serde_json::json!({ "items": [{ "id": "m1", "scope": "workspace", "key": "k",
                "value": "v", "source": "system", "createdBy": "system",
                "createdAt": "2026-07-29 08:15:26", "updatedAt": "2026-07-29 08:15:26",
                "sensitivity": "internal", "ver": 1, "tags": [], "enabled": true }], "total": 1 }),
        ),
        // prompt 的变量缺 source
        (
            "prompt.list",
            serde_json::json!({ "items": [{ "id": "p1", "group": "分析", "name": "n",
                "sections": [], "vars": [{ "name": "target", "required": true }], "ver": 1,
                "builtin": true, "updatedAt": "2026-07-29T08:15:26.000Z" }], "total": 1 }),
        ),
        // onMissing 不在枚举里
        (
            "prompt.list",
            serde_json::json!({ "items": [{ "id": "p1", "group": "分析", "name": "n",
                "sections": [], "vars": [{ "name": "target", "source": "input",
                "onMissing": "explode" }], "ver": 1, "builtin": true,
                "updatedAt": "2026-07-29T08:15:26.000Z" }], "total": 1 }),
        ),
    ];

    for (method, 坏数据) in 坏例 {
        assert!(
            !违约处(method, 坏数据).is_empty(),
            "{method} 的这份坏数据没被认出来：{坏数据}"
        );
    }
}
