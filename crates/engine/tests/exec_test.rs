//! 脚本执行器：真实起进程、真实收输出、真实超时。
//!
//! 这些测试刻意不 mock 进程 —— 「宁可页面留空，也不要做假的」同样适用于测试：
//! 一个 mock 掉 Command 的测试证明不了脚本节点真的能跑。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use aiwf_engine::exec::{ExecOutcome, ScriptRequest, run_script};

fn request(script: &str) -> ScriptRequest {
    ScriptRequest {
        interpreter: "bash".to_string(),
        script: script.to_string(),
        workdir: std::env::temp_dir(),
        env: vec![],
        timeout: Duration::from_secs(10),
        output_parse: "text".to_string(),
    }
}

#[test]
fn 成功的脚本返回_stdout_与退出码零() {
    let result = run_script(request("echo hello")).unwrap();
    match result {
        ExecOutcome::Completed { code, stdout, .. } => {
            assert_eq!(code, 0);
            assert_eq!(stdout.trim(), "hello");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 失败的脚本保留退出码与_stderr() {
    let result = run_script(request("echo oops >&2; exit 3")).unwrap();
    match result {
        ExecOutcome::Completed { code, stderr, .. } => {
            assert_eq!(code, 3);
            assert!(stderr.contains("oops"), "stderr 实际：{stderr}");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 超时的脚本被杀掉而不是挂住整个引擎() {
    let mut req = request("sleep 30");
    req.timeout = Duration::from_millis(300);
    let started = std::time::Instant::now();
    let result = run_script(req).unwrap();
    assert!(
        matches!(result, ExecOutcome::TimedOut { .. }),
        "实际：{result:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "超时没有真的中断进程，耗时 {:?}",
        started.elapsed()
    );
}

#[test]
fn 环境变量传进脚本() {
    let mut req = request("echo \"$AIWF_ISSUE\"");
    req.env = vec![("AIWF_ISSUE".to_string(), "42".to_string())];
    let result = run_script(req).unwrap();
    match result {
        ExecOutcome::Completed { stdout, .. } => assert_eq!(stdout.trim(), "42"),
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 工作目录就是节点指定的目录() {
    let dir = std::env::temp_dir().join("aiwf_exec_cwd");
    std::fs::create_dir_all(&dir).unwrap();
    let mut req = request("pwd");
    req.workdir = dir.clone();
    let result = run_script(req).unwrap();
    match result {
        ExecOutcome::Completed { stdout, .. } => {
            let printed = std::fs::canonicalize(stdout.trim()).unwrap();
            assert_eq!(printed, std::fs::canonicalize(&dir).unwrap());
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn json_解析模式产出结构化输出() {
    let mut req = request(r#"echo '{"title":"修复登录","count":2}'"#);
    req.output_parse = "json".to_string();
    let result = run_script(req).unwrap();
    match result {
        ExecOutcome::Completed { parsed, .. } => {
            let parsed = parsed.expect("json 模式应当有解析结果");
            assert_eq!(parsed["title"], "修复登录");
            assert_eq!(parsed["count"], 2);
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn json_解析失败不当成脚本失败_但要说清楚() {
    // 脚本本身退出码是 0，只是输出不是 JSON。
    // 把这个当成脚本失败会误导用户去查脚本，实际该查的是 outputParse 配置。
    let mut req = request("echo not-json");
    req.output_parse = "json".to_string();
    let result = run_script(req).unwrap();
    match result {
        ExecOutcome::Completed {
            code,
            parsed,
            parse_error,
            ..
        } => {
            assert_eq!(code, 0);
            assert!(parsed.is_none());
            assert!(parse_error.is_some(), "应当带上解析失败的原因");
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 不存在的工作目录给出可操作的错误() {
    let mut req = request("echo hi");
    req.workdir = std::path::PathBuf::from("/definitely/not/here/aiwf");
    let error = run_script(req).unwrap_err().to_string();
    assert!(error.contains("工作目录"), "错误信息实际：{error}");
}

#[test]
fn 超长输出被截断而不是撑爆内存() {
    // 一个 AI Agent 跑飞了刷几百 MB 日志是真会发生的事
    let result = run_script(request(
        "for i in $(seq 1 200000); do echo aaaaaaaaaaaaaaaaaaaa; done",
    ))
    .unwrap();
    match result {
        ExecOutcome::Completed {
            stdout, truncated, ..
        } => {
            assert!(truncated, "应当标记已截断");
            assert!(stdout.len() <= 1_100_000, "实际 {} 字节", stdout.len());
        }
        other => panic!("实际：{other:?}"),
    }
}

#[test]
fn 未知解释器给出可操作的错误而不是_panic() {
    let mut req = request("echo hi");
    req.interpreter = "definitely-not-a-shell".to_string();
    let error = run_script(req).unwrap_err().to_string();
    assert!(
        error.contains("definitely-not-a-shell"),
        "错误信息实际：{error}"
    );
}
