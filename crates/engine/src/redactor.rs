//! 脱敏器。
//!
//! stdout、stderr、AI 输入输出统一过这里才落库（技术选型 §5）。
//! 验收标准要求：Secret 从不出现在事件、日志、预览与导出中，界面也不提供绕过入口。
//!
//! **落库前**的那道在 `runner::emit_full`（唯一的事件写入口）——
//! 只在读取点脱的话，数据库文件本身仍然带着明文走备份。
//! 这句话曾经有一阵是假的：模块文档写着「统一过这里才落库」，
//! 而事件那条链路上一次都没调过它，脚本里一句 `echo $TOKEN`
//! 就让明文躺进 `run_event.summary` 与全文索引，
//! 而界面上写着「Secret 值在写入事件存储前已脱敏」。
//!
//! 两条路子并用：
//! 1. 形态规则——按已知 Token 形态与 header / 环境变量赋值语法匹配；
//! 2. 已知明文——运行时注入过哪些 Secret，就把那些字面量也挡掉（密码没有固定形态）。

use regex::{Captures, Regex};

/// 脱敏后的占位符。导出前的扫描也认它，所以别随意改。
pub const REDACTED: &str = "[已脱敏]";

/// 短于这个长度的已知明文不做精确匹配，否则会把正文打成马赛克。
const MIN_LITERAL_LEN: usize = 8;

/// 引用形式本来就该出现在界面与日志里（数据库只存引用），不算明文。
const REFERENCE_PREFIX: &str = "keychain://";

#[derive(Debug, thiserror::Error)]
pub enum RedactorError {
    #[error("正则不合法：{0}")]
    InvalidPattern(#[from] regex::Error),
}

#[derive(Clone, Copy)]
enum Mode {
    /// 保留第 1 组（键名 / header 名），替换第 2 组（值）。
    KeepPrefix,
    /// 整段替换。
    Whole,
}

struct Rule {
    re: Regex,
    mode: Mode,
}

pub struct Redactor {
    rules: Vec<Rule>,
    literals: Vec<String>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::with_defaults()
    }
}

impl Redactor {
    pub fn empty() -> Self {
        Self {
            rules: Vec::new(),
            literals: Vec::new(),
        }
    }

    /// 默认规则集。新增形态时补在这里，并在 tests/redactor_test.rs 里加用例。
    pub fn with_defaults() -> Self {
        let specs: &[(&str, Mode)] = &[
            // Authorization / Proxy-Authorization 头
            (
                r"(?i)((?:proxy-)?authorization:\s*(?:bearer|basic|token|digest)\s+)(\S+)",
                Mode::KeepPrefix,
            ),
            // 各类 API Key 头
            (
                r"(?i)((?:x-api-key|x-auth-token|api-key|private-token):\s*)(\S+)",
                Mode::KeepPrefix,
            ),
            // 环境变量 / 配置项赋值：键名里带 token / secret / key / password 才算
            (
                r"(?i)([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*\s*[=:]\s*)([^\s'\x22]+)",
                Mode::KeepPrefix,
            ),
            // 裸 Bearer
            (r"(?i)(bearer\s+)([A-Za-z0-9._\-+/=]{8,})", Mode::KeepPrefix),
            // 常见 Token 形态
            (r"\bgh[pousr]_[A-Za-z0-9]{16,}\b", Mode::Whole),
            (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", Mode::Whole),
            (r"\bsk-[A-Za-z0-9_-]{16,}\b", Mode::Whole),
            (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", Mode::Whole),
            (r"\bAKIA[0-9A-Z]{16}\b", Mode::Whole),
            (r"\bAIza[0-9A-Za-z_-]{30,}\b", Mode::Whole),
            // PEM 私钥块
            (
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
                Mode::Whole,
            ),
        ];

        let rules = specs
            .iter()
            .filter_map(|(pattern, mode)| {
                Regex::new(pattern).ok().map(|re| Rule { re, mode: *mode })
            })
            .collect();

        Self {
            rules,
            literals: Vec::new(),
        }
    }

    /// 追加自定义正则（节点配置里的「脱敏规则」）。整段匹配都会被替换。
    pub fn add_pattern(&mut self, pattern: &str) -> Result<(), RedactorError> {
        let re = Regex::new(pattern)?;
        self.rules.push(Rule {
            re,
            mode: Mode::Whole,
        });
        Ok(())
    }

    /// 登记一个已知的 Secret 明文。注入子进程时调用，之后它的输出就挡得住。
    pub fn add_secret_value(&mut self, value: &str) {
        let trimmed = value.trim();
        if trimmed.len() < MIN_LITERAL_LEN || trimmed.starts_with(REFERENCE_PREFIX) {
            return;
        }
        if !self.literals.iter().any(|l| l == trimmed) {
            self.literals.push(trimmed.to_string());
        }
    }

    /// 脱敏。幂等：对已脱敏文本再跑一次结果不变。
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_string();

        for literal in &self.literals {
            if out.contains(literal.as_str()) {
                out = out.replace(literal.as_str(), REDACTED);
            }
        }

        for rule in &self.rules {
            out = match rule.mode {
                Mode::Whole => rule.re.replace_all(&out, REDACTED).into_owned(),
                Mode::KeepPrefix => rule
                    .re
                    .replace_all(&out, |caps: &Captures<'_>| {
                        let prefix = caps.get(1).map_or("", |m| m.as_str());
                        let value = caps.get(2).map_or("", |m| m.as_str());
                        // 引用不是明文，原样保留，否则界面上连「引用了哪个凭据」都看不到
                        if value.starts_with(REFERENCE_PREFIX) || value == REDACTED {
                            caps.get(0)
                                .map_or(String::new(), |m| m.as_str().to_string())
                        } else {
                            format!("{prefix}{REDACTED}")
                        }
                    })
                    .into_owned(),
            };
        }

        out
    }

    /// 导出前的最后一道扫描：只判断有没有，不改内容。
    pub fn contains_secret(&self, text: &str) -> bool {
        self.redact(text) != text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空脱敏器不改动文本() {
        let r = Redactor::empty();
        assert_eq!(
            r.redact("Bearer sk-live-abcdef1234567890"),
            "Bearer sk-live-abcdef1234567890"
        );
    }

    #[test]
    fn 已知明文去重登记() {
        let mut r = Redactor::empty();
        r.add_secret_value("s3cret-value-长一点");
        r.add_secret_value("s3cret-value-长一点");
        assert_eq!(r.literals.len(), 1);
    }

    #[test]
    fn 引用形式不登记为明文() {
        let mut r = Redactor::empty();
        r.add_secret_value("keychain://gh-cli");
        assert!(r.literals.is_empty());
    }
}
