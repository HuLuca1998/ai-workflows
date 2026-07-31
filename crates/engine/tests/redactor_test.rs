//! Redactor 脱敏用例（质量门禁 §14 点名的单测对象）。
//!
//! 约束来自技术选型 §5 与验收标准 §9：
//! stdout、stderr、AI 输入输出统一过 Redactor 后才落库；
//! Secret 从不出现在事件、日志、预览与导出中，界面不提供绕过脱敏的入口。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::redactor::{REDACTED, Redactor};

#[test]
fn 脱敏_bearer_token() {
    let r = Redactor::with_defaults();
    let out = r.redact("curl -H 'Authorization: Bearer sk-live-abcdef1234567890'");
    assert!(!out.contains("sk-live-abcdef1234567890"));
    assert!(out.contains(REDACTED));
}

#[test]
fn 脱敏各家常见的_token_前缀() {
    let r = Redactor::with_defaults();
    for secret in [
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        "gho_1234567890abcdefghijklmnopqrstuvwxyz",
        "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890",
        "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
        "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx",
        "AKIAIOSFODNN7EXAMPLE",
    ] {
        let out = r.redact(&format!("值是 {secret} 结束"));
        assert!(!out.contains(secret), "{secret} 未被脱敏：{out}");
    }
}

#[test]
fn 脱敏_http_头里的凭据() {
    let r = Redactor::with_defaults();
    let out = r.redact("Authorization: Basic dXNlcjpwYXNzd29yZA==\nX-Api-Key: 9f8e7d6c5b4a3210");
    assert!(!out.contains("dXNlcjpwYXNzd29yZA=="));
    assert!(!out.contains("9f8e7d6c5b4a3210"));
}

#[test]
fn 脱敏环境变量赋值() {
    let r = Redactor::with_defaults();
    let out = r.redact("GITHUB_TOKEN=ghp_realvalue123456\nOPENAI_API_KEY=sk-abc123\nPATH=/usr/bin");
    assert!(!out.contains("ghp_realvalue123456"));
    assert!(!out.contains("sk-abc123"));
    // 非敏感变量不该被误伤
    assert!(
        out.contains("PATH=/usr/bin"),
        "普通环境变量不应被脱敏：{out}"
    );
}

#[test]
fn 已知明文值做精确脱敏_覆盖没有固定形态的密码() {
    let mut r = Redactor::with_defaults();
    r.add_secret_value("p@ssw0rd-没有固定形态");
    let out = r.redact("登录用 p@ssw0rd-没有固定形态 然后继续");
    assert!(!out.contains("p@ssw0rd-没有固定形态"));
    assert!(out.contains(REDACTED));
}

#[test]
fn 太短的已知值不做精确脱敏_否则会把正文打成马赛克() {
    let mut r = Redactor::with_defaults();
    r.add_secret_value("ab");
    let out = r.redact("about above abandon");
    assert_eq!(out, "about above abandon");
}

#[test]
fn 自定义正则可追加() {
    let mut r = Redactor::with_defaults();
    r.add_pattern(r"INTERNAL-[0-9]{6}").unwrap();
    let out = r.redact("工单 INTERNAL-123456 已处理");
    assert!(!out.contains("INTERNAL-123456"));
}

#[test]
fn 非法正则报错而不是静默忽略() {
    let mut r = Redactor::with_defaults();
    assert!(r.add_pattern("([unclosed").is_err());
}

#[test]
fn keychain_引用不是明文_保持可读() {
    let r = Redactor::with_defaults();
    let text = "GITHUB_TOKEN=keychain://gh-cli";
    // 引用形式本来就该出现在界面与日志里，脱敏不能把它也吃掉
    assert_eq!(r.redact(text), text);
}

#[test]
fn 脱敏是幂等的_重复处理不会层层叠加() {
    let r = Redactor::with_defaults();
    let once = r.redact("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    let twice = r.redact(&once);
    assert_eq!(once, twice);
}

#[test]
fn 多行日志逐行处理_不改变行数() {
    let r = Redactor::with_defaults();
    let input = "第一行\nAuthorization: Bearer sk-live-abcdef1234567890\n第三行";
    let out = r.redact(input);
    assert_eq!(out.lines().count(), 3);
    assert!(out.starts_with("第一行"));
    assert!(out.ends_with("第三行"));
}

#[test]
fn 普通文本不被误伤() {
    let r = Redactor::with_defaults();
    for text in [
        "修复了 config.yaml 热重载不生效的问题",
        "Test Files 4 passed (4)",
        "https://github.com/HuLuca1998/ai-workflows",
    ] {
        assert_eq!(r.redact(text), text, "普通文本被误伤：{text}");
    }
}

#[test]
fn 提供检测接口_供导出前做最后一道扫描() {
    let r = Redactor::with_defaults();
    assert!(r.contains_secret("Bearer sk-live-abcdef1234567890"));
    assert!(!r.contains_secret("一切正常"));
}

/// 进程级脱敏器：把「已知明文」那条路接上。
///
/// 形态规则只挡得住有固定形态的那一半。模块开头写着「两条路子并用」，
/// 第二条是「运行时注入过哪些 Secret 就把那些字面量也挡掉 ——
/// **密码没有固定形态**」，而 `add_secret_value` 一直是零调用点。
///
/// 系统里真实存在的那份明文密钥是 MCP 的令牌：它会顺着 adapter 的 stderr、
/// agent 的复述、失败时带整个 URL 的错误信息冒到事件流里，而它只是
/// 一串随机字符，什么形态规则都认不出。
mod 已知明文 {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use aiwf_engine::redactor::{redact_shared, register_secret};

    #[test]
    fn 登记过的密钥在事件文本里被挡掉() {
        // 一串纯随机字母 —— 任何形态规则都认不出它
        let 令牌 = "Kj8mQx2vNp7wRt4yBc6zHd9fLs3aGe5u";
        register_secret(令牌);

        let 脱敏后 = redact_shared(&format!("调用失败：http://127.0.0.1:7423/mcp/{令牌}"));

        assert!(!脱敏后.contains(令牌), "登记过的密钥还是漏出来了：{脱敏后}");
        assert!(脱敏后.contains("127.0.0.1:7423"), "把整段都吞了：{脱敏后}");
    }

    #[test]
    fn 没登记过也仍然走默认规则() {
        // 登记只是补上另一半，不能把原来那半关掉
        let 脱敏后 = redact_shared("Authorization: Bearer abcdefghijklmnop");
        assert!(!脱敏后.contains("abcdefghijklmnop"), "{脱敏后}");
    }

    #[test]
    fn 引用形式不当成明文登记() {
        // `keychain://gh-cli` 本来就该出现在界面与日志里 ——
        // 把它挡掉的话，用户连「引用了哪个凭据」都看不到
        register_secret("keychain://gh-cli");
        let 脱敏后 = redact_shared("凭据：keychain://gh-cli");
        assert!(脱敏后.contains("keychain://gh-cli"), "{脱敏后}");
    }
}

#[test]
fn sec_前缀的_token_会被脱敏_第3轮实测泄漏的形态() {
    // 真实事故:adapter 的 502 报错把上游 API key 带在 URL 路径里
    // (https://…/sec-XXXX/v1/responses),原样进了事件流与产物
    let redactor = Redactor::with_defaults();
    let text =
        "unexpected status 502: url: https://llm.example.com/sec-T00AbCdEfGh123456789/v1/responses";
    let out = redactor.redact(text);
    assert!(!out.contains("sec-T00AbCdEfGh123456789"), "泄漏:{out}");
    assert!(out.contains("v1/responses"), "URL 其余部分要保留:{out}");
}
