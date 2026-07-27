//! 变量插值：`${input.repo}` / `${run.id}` / `${节点id.端口}`。
//!
//! 图纸里的模板到处是这种引用。插值错了不会报错，只会安静地把
//! 字面量 `${input.repo}` 传给 git —— 所以未解析的引用必须是硬错误。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::interp::{Scope, interpolate};

fn scope() -> Scope {
    let mut scope = Scope::new("run_123");
    scope.set_inputs(serde_json::json!({
        "repo": "/Users/luca/work/demo",
        "issue": "42",
        "base": "main"
    }));
    scope.set_node_output(
        "read_issue",
        "success",
        serde_json::json!({"title": "登录失败", "labels": ["bug"]}),
    );
    scope
}

#[test]
fn 输入字段被替换() {
    assert_eq!(
        interpolate("cd ${input.repo}", &scope()).unwrap(),
        "cd /Users/luca/work/demo"
    );
}

#[test]
fn 运行元数据被替换() {
    assert_eq!(
        interpolate("fix/${input.issue}-${run.id}", &scope()).unwrap(),
        "fix/42-run_123"
    );
}

#[test]
fn 节点输出按端口取值() {
    let result = interpolate("${read_issue.success}", &scope()).unwrap();
    assert!(result.contains("登录失败"), "实际：{result}");
}

#[test]
fn 节点输出支持点路径深取() {
    assert_eq!(
        interpolate("${read_issue.success.title}", &scope()).unwrap(),
        "登录失败"
    );
}

#[test]
fn 未定义的引用是硬错误而不是留下字面量() {
    // 安静地把 ${input.nope} 传给 shell 是最坏的结果：
    // 脚本会带着一个看起来像变量的字符串跑下去
    let error = interpolate("echo ${input.nope}", &scope())
        .unwrap_err()
        .to_string();
    assert!(error.contains("input.nope"), "错误信息实际：{error}");
}

#[test]
fn 没有引用的字符串原样返回() {
    assert_eq!(interpolate("pnpm test", &scope()).unwrap(), "pnpm test");
}

#[test]
fn 同一个引用出现多次都被替换() {
    assert_eq!(
        interpolate("${input.issue}-${input.issue}", &scope()).unwrap(),
        "42-42"
    );
}

#[test]
fn 未闭合的花括号不当成引用() {
    assert_eq!(
        interpolate("echo ${unclosed", &scope()).unwrap(),
        "echo ${unclosed"
    );
}

#[test]
fn 字符串值不带引号而对象值序列化为_json() {
    // 字符串带上引号会让 `cd ${input.repo}` 变成 `cd "/path"`——在 shell 里能跑，
    // 但拼进 URL 或文件名时就错了
    let s = scope();
    assert_eq!(interpolate("${input.base}", &s).unwrap(), "main");
    assert!(
        interpolate("${read_issue.success}", &s)
            .unwrap()
            .starts_with('{')
    );
}

#[test]
fn 插值环境变量表把输入摊平成_aiwf_前缀() {
    // 脚本里用 $AIWF_ISSUE 比用 ${input.issue} 自然，两条路都要通
    let env = scope().env_vars();
    let issue = env.iter().find(|(k, _)| k == "AIWF_ISSUE");
    assert_eq!(issue.map(|(_, v)| v.as_str()), Some("42"));
    let run_id = env.iter().find(|(k, _)| k == "AIWF_RUN_ID");
    assert_eq!(run_id.map(|(_, v)| v.as_str()), Some("run_123"));
}
