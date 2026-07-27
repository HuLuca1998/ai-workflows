//! 产物存储。
//!
//! 技术选型：大 payload 落 artifacts/，事件只留摘要与引用。
//! 一条 200KB 的脚本输出塞进事件表，会让整个事件流的查询都变慢，
//! 而事件流是执行记录页每秒都在读的东西。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_engine::artifacts::{ArtifactKind, ArtifactStore};

fn store(name: &str) -> (ArtifactStore, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("aiwf_art_{name}"));
    let _ = std::fs::remove_dir_all(&root);
    (ArtifactStore::new(root.clone()), root)
}

#[test]
fn 写入产物返回路径_内容能原样读回() {
    let (store, _root) = store("write");
    let saved = store
        .save(
            "run_1",
            "node_a",
            ArtifactKind::Log,
            "stdout.log",
            b"hello\n",
        )
        .unwrap();

    assert_eq!(std::fs::read(&saved.path).unwrap(), b"hello\n");
    assert_eq!(saved.bytes, 6);
}

#[test]
fn 每个运行一个目录_不同运行的产物互不混杂() {
    let (store, root) = store("isolate");
    let a = store
        .save("run_a", "n", ArtifactKind::Log, "out.log", b"a")
        .unwrap();
    let b = store
        .save("run_b", "n", ArtifactKind::Log, "out.log", b"b")
        .unwrap();

    assert_ne!(a.path, b.path);
    assert!(a.path.starts_with(root.join("run_a")));
    assert!(b.path.starts_with(root.join("run_b")));
}

#[test]
fn 同名产物按节点分开_同一运行里两个节点都写_output_不会互相覆盖() {
    let (store, _root) = store("samename");
    let a = store
        .save("run_1", "node_a", ArtifactKind::Log, "out.log", b"a")
        .unwrap();
    let b = store
        .save("run_1", "node_b", ArtifactKind::Log, "out.log", b"bb")
        .unwrap();

    assert_ne!(a.path, b.path);
    assert_eq!(std::fs::read(&a.path).unwrap(), b"a");
    assert_eq!(std::fs::read(&b.path).unwrap(), b"bb");
}

#[test]
fn 记录_sha256_让产物可校验() {
    let (store, _root) = store("hash");
    let saved = store
        .save("run_1", "n", ArtifactKind::Log, "x.log", b"hello")
        .unwrap();
    // sha256("hello")
    assert_eq!(
        saved.sha256,
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

#[test]
fn 文件名里的路径分隔符不会写到目录外() {
    // 一个 AI 生成的文件名带上 ../../ 就能写到用户主目录去
    let (store, root) = store("escape");
    let saved = store
        .save("run_1", "n", ArtifactKind::Report, "../../evil.txt", b"x")
        .unwrap();
    assert!(
        saved.path.starts_with(&root),
        "产物写到了 {} —— 逃出了产物根目录",
        saved.path.display()
    );
}

#[test]
fn 空文件名被拒绝而不是写出一个无名文件() {
    let (store, _root) = store("empty");
    assert!(
        store
            .save("run_1", "n", ArtifactKind::Log, "", b"x")
            .is_err()
    );
}

#[test]
fn 列出一次运行的全部产物() {
    let (store, _root) = store("list");
    store
        .save("run_1", "a", ArtifactKind::Log, "one.log", b"1")
        .unwrap();
    store
        .save("run_1", "b", ArtifactKind::Diff, "two.patch", b"22")
        .unwrap();
    store
        .save("run_2", "c", ArtifactKind::Log, "other.log", b"3")
        .unwrap();

    let items = store.list("run_1").unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|item| item.run_id == "run_1"));
}

#[test]
fn 列出不存在的运行返回空而不是报错() {
    let (store, _root) = store("none");
    assert_eq!(store.list("run_nope").unwrap().len(), 0);
}

#[test]
fn 读取产物内容有大小上限_不把几百兆读进内存() {
    let (store, _root) = store("read");
    let big = vec![b'x'; 300_000];
    let saved = store
        .save("run_1", "n", ArtifactKind::Log, "big.log", &big)
        .unwrap();

    let preview = store.preview(&saved.path, 1000).unwrap();
    assert_eq!(preview.text.len(), 1000);
    assert!(preview.truncated);
}

#[test]
fn 预览小文件时不标记截断() {
    let (store, _root) = store("small");
    let saved = store
        .save("run_1", "n", ArtifactKind::Log, "s.log", b"short")
        .unwrap();
    let preview = store.preview(&saved.path, 1000).unwrap();
    assert_eq!(preview.text, "short");
    assert!(!preview.truncated);
}

#[test]
fn 预览产物根目录之外的文件被拒绝() {
    // 界面传来的路径不能无条件相信
    let (store, _root) = store("guard");
    let error = store
        .preview(std::path::Path::new("/etc/passwd"), 100)
        .unwrap_err()
        .to_string();
    assert!(error.contains("产物"), "错误信息实际：{error}");
}

#[test]
fn 预先摆好的符号链接不能把产物写到根目录外() {
    // 攻击面：谁能在产物目录里放符号链接？——上一次运行的脚本就能。
    // create_dir_all 与 write 都跟随链接，日志会写到 /outside 去。
    let (store, root) = store("symlink");
    std::fs::create_dir_all(&root).unwrap();

    let outside = std::env::temp_dir().join("aiwf_art_outside");
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).unwrap();

    // run_evil 这个「运行目录」其实是通往外面的链接
    std::os::unix::fs::symlink(&outside, root.join("run_evil")).unwrap();

    let result = store.save("run_evil", "node", ArtifactKind::Log, "leak.log", b"x");
    assert!(
        result.is_err() || !outside.join("node/leak.log").exists(),
        "产物顺着符号链接写到了 {}",
        outside.display()
    );
}

#[test]
fn 节点_id_里的点分量不能逃出运行目录() {
    // node_id=".." 会写到 <root>/stdout.log，跑出这次运行的目录
    let (store, root) = store("dots");
    let saved = store.save("run_1", "..", ArtifactKind::Log, "out.log", b"x");

    // 拒绝也是正确答案；接受了就必须还在 run_1 目录里
    if let Ok(item) = saved {
        assert!(
            item.path.starts_with(root.join("run_1")),
            "写到了 {}，逃出了 run_1 目录",
            item.path.display()
        );
    }
}

#[test]
fn 节点_id_清洗后不能互相碰撞() {
    // a/b 与 ab 都被过滤成 ab，两个节点的日志会互相覆盖
    let (store, _root) = store("collide");
    let first = store.save("run_1", "a/b", ArtifactKind::Log, "out.log", b"aaa");
    let second = store.save("run_1", "ab", ArtifactKind::Log, "out.log", b"bbb");

    if let (Ok(a), Ok(b)) = (&first, &second) {
        assert_ne!(a.path, b.path, "两个不同节点的日志落到了同一个文件");
        assert_eq!(std::fs::read(&a.path).unwrap(), b"aaa", "先写的被覆盖了");
    }
}
