//! 生产代码里的标识符必须是英文。
//!
//! CLAUDE.md 的风格规定：「注释与文档用中文，标识符用英文」。
//! TS 侧一直有 `no-internal-jargon.test.ts` 守着，**Rust 侧没有** ——
//! 于是这条规定在 Rust 里被违反了 168 处，没有任何一次门禁变红。
//!
//! 中文标识符的代价不是「不好看」：
//!
//! - `cargo` 的报错、`rustc` 的建议、panic 的栈都会变成半中半英；
//! - IDE 的符号搜索、`grep -w`、正则边界（`\b`）对中文的处理各不相同，
//!   重构工具会漏改而编译器未必抓得到（`format!("{中文变量}")` 就是一例）；
//! - 换一个不读中文的协作者或工具链，这些名字全是不可读的。
//!
//! **只管生产代码**：测试函数名用中文是这个仓库刻意的选择
//! （`fn 握手拿到协议版本与能力()` 比任何英文名都说得清它在验什么），
//! 那一条与本测试无关。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

/// 要扫的生产代码目录。测试目录不在其中 —— 见文件头。
const PRODUCTION_DIRS: &[&str] = &[
    "crates/engine/src",
    "crates/core-api/src",
    "crates/store/src",
    "crates/mcp/src",
    "crates/devserver/src",
    "apps/desktop/src-tauri/src",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("仓库根")
        .to_path_buf()
}

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// 找出一份源码里的中文标识符。
///
/// **必须跳过注释与字符串**：中文在那两处是对的。这里用的是
/// 一个够用的状态机 —— 跨行字符串（seed.rs 的 SQL、executor.rs 的
/// 提示词）如果按行处理会被误判成代码，那正是写这份守卫时踩过的坑。
///
/// 抽成函数是为了能喂假数据 —— 门禁证明不了自己会红就不是门禁。
pub fn find_chinese_idents(src: &str) -> Vec<String> {
    let bytes: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let mut current = String::new();

    let flush = |current: &mut String, out: &mut Vec<String>| {
        if !current.is_empty() {
            out.push(std::mem::take(current));
        }
    };

    while i < bytes.len() {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied().unwrap_or('\0');

        // 行注释
        if ch == '/' && next == '/' {
            flush(&mut current, &mut out);
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        // 块注释（可嵌套）
        if ch == '/' && next == '*' {
            flush(&mut current, &mut out);
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == '*' && bytes.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // 原始字符串 r"..." / r#"..."#
        if ch == 'r' && (next == '"' || next == '#') {
            let mut hashes = 0;
            let mut j = i + 1;
            while bytes.get(j) == Some(&'#') {
                hashes += 1;
                j += 1;
            }
            if bytes.get(j) == Some(&'"') {
                flush(&mut current, &mut out);
                j += 1;
                loop {
                    if j >= bytes.len() {
                        break;
                    }
                    if bytes[j] == '"' {
                        let closed = (1..=hashes).all(|k| bytes.get(j + k) == Some(&'#'));
                        if closed {
                            j += hashes + 1;
                            break;
                        }
                    }
                    j += 1;
                }
                i = j;
                continue;
            }
        }
        // 字符字面量 `'x'` / `'\n'` / `'"'`。
        //
        // **必须认它**，否则 `quote != '"'` 里那个双引号会被当成字符串开始，
        // 从此整份文件的引号全部错位 —— 后面所有字符串内容都会被当成代码。
        // 这份守卫第一版就是这么误报了两个文件的。
        //
        // 生命周期标注（`'a`）长得像但不是：它不闭合。
        if ch == '\'' {
            let closes_at_2 = bytes.get(i + 2) == Some(&'\'');
            let escaped_closes_at_3 = next == '\\' && bytes.get(i + 3) == Some(&'\'');
            if closes_at_2 || escaped_closes_at_3 {
                flush(&mut current, &mut out);
                i += if closes_at_2 { 3 } else { 4 };
                continue;
            }
        }

        // 普通字符串
        if ch == '"' {
            flush(&mut current, &mut out);
            i += 1;
            while i < bytes.len() {
                if bytes[i] == '\\' {
                    i += 2;
                } else if bytes[i] == '"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }

        // 标识符：中文起头，可夹英文数字下划线
        if ('\u{4e00}'..='\u{9fa5}').contains(&ch) {
            current.push(ch);
            i += 1;
            continue;
        }
        if !current.is_empty() && (ch.is_ascii_alphanumeric() || ch == '_') {
            current.push(ch);
            i += 1;
            continue;
        }
        flush(&mut current, &mut out);
        i += 1;
    }
    flush(&mut current, &mut out);
    out
}

/// `#[cfg(test)]` 之后的内容不算生产代码。
///
/// 测试函数名用中文是这个仓库的选择，而它们就写在 src 文件末尾的
/// `mod tests` 里 —— 不切掉的话这条守卫会要求把它们一起改掉。
fn strip_test_mod(src: &str) -> &str {
    match src.find("#[cfg(test)]") {
        Some(at) => &src[..at],
        None => src,
    }
}

#[test]
fn 生产代码里没有中文标识符() {
    let root = repo_root();
    let mut offenders: Vec<String> = Vec::new();

    for dir in PRODUCTION_DIRS {
        let mut files = Vec::new();
        rs_files(&root.join(dir), &mut files);
        for file in files {
            let src = std::fs::read_to_string(&file).unwrap_or_default();
            let found = find_chinese_idents(strip_test_mod(&src));
            if !found.is_empty() {
                let rel = file.strip_prefix(&root).unwrap_or(&file);
                offenders.push(format!("{}: {}", rel.display(), found.join(" ")));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "这些生产代码里有中文标识符（CLAUDE.md：注释与文档用中文，标识符用英文）。\n\
         中文名会让 rustc 的报错与 panic 栈变成半中半英，\n\
         而 `format!(\"{{中文变量}}\")` 这种引用连重构工具都改不干净：\n{}",
        offenders.join("\n")
    );
}

#[test]
fn 守卫认得出中文标识符() {
    // 门禁证明不了自己会红就不是门禁
    let found = find_chinese_idents("let 材料 = 1; let ok = 2;");
    assert_eq!(found, vec!["材料".to_string()]);
}

#[test]
fn 注释与字符串里的中文不算() {
    // 中文在这两处是**对的** —— 一并报出来的话，这条守卫会逼着
    // 把注释也改成英文，而 CLAUDE.md 要的正好相反
    assert!(find_chinese_idents("// 这是注释，说明为什么这么写").is_empty());
    assert!(find_chinese_idents("/// 文档注释同样不算").is_empty());
    assert!(find_chinese_idents("/* 块注释 */").is_empty());
    assert!(find_chinese_idents(r#"let msg = "用户可见的中文文案";"#).is_empty());
}

#[test]
fn 跨行字符串不会被当成代码() {
    // 这是写这份守卫时真踩过的坑：按行处理的话，多行 SQL 与提示词
    // 中间那些行会被当成代码，于是整份 seed.rs 全是「中文标识符」
    let src = "let sql = \"SELECT 名称\nFROM 表\nWHERE id = 1\";";
    assert!(
        find_chinese_idents(src).is_empty(),
        "跨行字符串被当成代码了：{:?}",
        find_chinese_idents(src)
    );

    let raw = "let q = r#\"\n多行\n原始字符串\n\"#;";
    assert!(find_chinese_idents(raw).is_empty());
}

#[test]
fn 字符字面量里的引号不会让后面全部错位() {
    // `quote != '"'` 里那个双引号如果被当成字符串开始，
    // 从此整份文件的引号全部错位 —— 后面每一段字符串内容都会
    // 被当成代码报出来。这条测试就是那次误报的化石。
    let src = "if quote != '\"' { let 名字 = 1; }";
    assert_eq!(
        find_chinese_idents(src),
        vec!["名字".to_string()],
        "字符字面量里的引号把后面的解析带偏了"
    );

    // 生命周期标注长得像字符字面量，但它不闭合
    let lifetime = "fn f<'a>(x: &'a str) -> &'a str { x }";
    assert!(find_chinese_idents(lifetime).is_empty());
}
