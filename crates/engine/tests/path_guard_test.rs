//! PathGuard 逃逸用例（质量门禁 §14 点名的单测对象）。
//!
//! 规则来自技术选型 §5：
//! 路径先 canonicalize 再判断是否位于授权根目录；拒绝根目录、Home、未解析变量
//! 与宽泛 glob；单独防护符号链接逃逸。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use aiwf_engine::path_guard::{GuardError, PathGuard};

fn workspace() -> (tempfile::TempDir, PathGuard) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
    let guard = PathGuard::new(vec![root]).unwrap();
    (dir, guard)
}

// ── 授权根本身的合法性 ─────────────────────────────────────────────────────

#[test]
fn 拒绝把文件系统根目录设为授权根() {
    let err = PathGuard::new(vec![PathBuf::from("/")]).unwrap_err();
    assert!(
        matches!(err, GuardError::ForbiddenRoot { .. }),
        "实际：{err:?}"
    );
}

#[test]
fn 拒绝把_home_设为授权根() {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/nobody".to_string());
    let err = PathGuard::new(vec![PathBuf::from(&home)]).unwrap_err();
    assert!(
        matches!(err, GuardError::ForbiddenRoot { .. }),
        "实际：{err:?}"
    );
}

#[test]
fn 拒绝系统目录作为授权根() {
    for dir in ["/etc", "/usr", "/System", "/var"] {
        let result = PathGuard::new(vec![PathBuf::from(dir)]);
        assert!(result.is_err(), "{dir} 不应被允许作为授权根");
    }
}

#[test]
fn 没有授权根时一切路径都被拒() {
    let guard = PathGuard::new(vec![]).unwrap();
    assert!(guard.resolve("/tmp/anything").is_err());
}

// ── 路径解析 ───────────────────────────────────────────────────────────────

#[test]
fn 授权根内的已存在路径通过() {
    let (dir, guard) = workspace();
    let resolved = guard
        .resolve(&dir.path().join("src/main.rs").to_string_lossy())
        .unwrap();
    assert!(resolved.ends_with("src/main.rs"));
}

#[test]
fn 授权根内尚不存在的文件也允许_因为要新建() {
    let (dir, guard) = workspace();
    let target = dir.path().join("src/new_file.rs");
    let resolved = guard.resolve(&target.to_string_lossy()).unwrap();
    assert!(resolved.ends_with("src/new_file.rs"));
}

#[test]
fn 父目录不存在时拒绝_避免误建深层目录() {
    let (dir, guard) = workspace();
    let target = dir.path().join("a/b/c/d.txt");
    assert!(guard.resolve(&target.to_string_lossy()).is_err());
}

#[test]
fn 用_dotdot_跳出授权根被拒() {
    let (dir, guard) = workspace();
    let escape = dir.path().join("src/../../etc/passwd");
    let err = guard.resolve(&escape.to_string_lossy()).unwrap_err();
    assert!(matches!(err, GuardError::Escape { .. }), "实际：{err:?}");
}

#[test]
fn 绝对路径指向授权根之外被拒() {
    let (_dir, guard) = workspace();
    let err = guard.resolve("/etc/hosts").unwrap_err();
    assert!(matches!(err, GuardError::Escape { .. }), "实际：{err:?}");
}

#[test]
fn 符号链接指向根外被拒_这是最容易漏的一条() {
    let (dir, guard) = workspace();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "s3cret").unwrap();

    let link = dir.path().join("src/leak");
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link).unwrap();

    let err = guard.resolve(&link.to_string_lossy()).unwrap_err();
    assert!(
        matches!(err, GuardError::Escape { .. }),
        "符号链接必须按解析后的真实路径判断，实际：{err:?}"
    );
}

#[test]
fn 指向授权根内部的符号链接允许() {
    let (dir, guard) = workspace();
    let link = dir.path().join("link_to_src");
    std::os::unix::fs::symlink(dir.path().join("src"), &link).unwrap();
    assert!(guard.resolve(&link.to_string_lossy()).is_ok());
}

// ── 明显危险的输入 ─────────────────────────────────────────────────────────

#[test]
fn 未解析的变量被拒_不做二次求值() {
    let (_dir, guard) = workspace();
    for input in ["${input.repoPath}/src", "$HOME/code", "~/code/atlas-api"] {
        let err = guard.resolve(input).unwrap_err();
        assert!(
            matches!(err, GuardError::Unresolved { .. }),
            "{input} 应报未解析变量，实际：{err:?}"
        );
    }
}

#[test]
fn 宽泛_glob_被拒() {
    let (dir, guard) = workspace();
    for suffix in ["/**", "/*", "/src/**/*"] {
        let input = format!("{}{suffix}", dir.path().to_string_lossy());
        let err = guard.resolve(&input).unwrap_err();
        assert!(
            matches!(err, GuardError::Overbroad { .. }),
            "{input} 应被拒，实际：{err:?}"
        );
    }
}

#[test]
fn 空路径与空白路径被拒() {
    let (_dir, guard) = workspace();
    assert!(guard.resolve("").is_err());
    assert!(guard.resolve("   ").is_err());
}

#[test]
fn 相对路径不被接受_必须由引擎给出绝对路径() {
    let (_dir, guard) = workspace();
    let err = guard.resolve("src/main.rs").unwrap_err();
    assert!(
        matches!(err, GuardError::NotAbsolute { .. }),
        "实际：{err:?}"
    );
}

// ── 多授权根 ───────────────────────────────────────────────────────────────

#[test]
fn 多个授权根时任一命中即可() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let guard = PathGuard::new(vec![
        fs::canonicalize(a.path()).unwrap(),
        fs::canonicalize(b.path()).unwrap(),
    ])
    .unwrap();

    assert!(
        guard
            .resolve(&a.path().join("x.txt").to_string_lossy())
            .is_ok()
    );
    assert!(
        guard
            .resolve(&b.path().join("y.txt").to_string_lossy())
            .is_ok()
    );
    assert!(guard.resolve("/etc/hosts").is_err());
}

#[test]
fn 前缀相同但不是子目录的路径不算在根内() {
    // /tmp/work 与 /tmp/work-evil：字符串前缀匹配会误判，必须按路径分量比较
    let parent = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(parent.path()).unwrap();
    let root = base.join("work");
    let sibling = base.join("work-evil");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&sibling).unwrap();

    let guard = PathGuard::new(vec![root]).unwrap();
    let err = guard
        .resolve(&sibling.join("x.txt").to_string_lossy())
        .unwrap_err();
    assert!(matches!(err, GuardError::Escape { .. }), "实际：{err:?}");
}
