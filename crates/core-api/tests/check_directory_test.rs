//! 「这个目录能不能用」。
//!
//! 引导页选完工作目录要验一次，启动表单填本地仓库路径也要验 ——
//! 不验的话，错误发生在运行跑到第四个节点时，而原因在第一屏填的东西里。
//!
//! **判据必须是真探测**：`stat` 说得出「存在」，说不出「你有没有权限
//! 往里写」。macOS 的 TCC 恰恰是后者 —— 目录在 `~/Documents` 下时，
//! App 读得到、写不了，而 `exists` 返回 true。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_core_api::env::check_directory;

#[test]
fn 能写的目录判为可用() {
    let dir = tempfile::tempdir().unwrap();
    let 结果 = check_directory(&dir.path().display().to_string()).unwrap();

    assert!(结果.exists);
    assert!(结果.writable, "临时目录写不进去？{:?}", 结果.message);
    assert!(
        结果.message.is_none(),
        "可用时不该有提示：{:?}",
        结果.message
    );
}

#[test]
fn 探针文件不留在目录里() {
    // 探测本身是有副作用的操作。留下一个 .aiwf-probe 的话，
    // 用户选中自己的仓库目录时会看到一个莫名其妙的文件，
    // 而 git status 会把它算成未跟踪改动
    let dir = tempfile::tempdir().unwrap();
    check_directory(&dir.path().display().to_string()).unwrap();

    let 剩下: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(std::result::Result::ok)
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(剩下.is_empty(), "探测留下了文件：{剩下:?}");
}

#[test]
fn 不存在的目录说清楚它不存在() {
    let dir = tempfile::tempdir().unwrap();
    let 缺的 = dir.path().join("还没建过");
    let 结果 = check_directory(&缺的.display().to_string()).unwrap();

    assert!(!结果.exists);
    assert!(!结果.writable);
    let message = 结果.message.expect("不可用却没给理由");
    assert!(message.contains("不存在"), "{message}");
}

#[test]
fn 写不进去的目录判为不可用_并且说清是权限问题() {
    // 这一条是这个方法存在的全部理由：`exists` 为 true 而写不进去。
    // macOS 上 TCC 挡住的目录就是这个形态
    let dir = tempfile::tempdir().unwrap();
    let 只读 = dir.path().join("只读");
    std::fs::create_dir(&只读).unwrap();
    let mut perms = std::fs::metadata(&只读).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o555);
    }
    std::fs::set_permissions(&只读, perms).unwrap();

    let 结果 = check_directory(&只读.display().to_string()).unwrap();

    assert!(结果.exists, "目录明明在");
    assert!(!结果.writable, "只读目录居然写得进去");
    let message = 结果.message.expect("写不进去却没给理由");
    assert!(
        message.contains("写不") || message.contains("权限"),
        "理由要指向权限，而不是一句 IO 错误：{message}"
    );
}

#[test]
fn 波浪号会展开成绝对路径() {
    // 界面上存的是 `~/Library/…` 这种可读形式（Web 形态拿不到
    // Tauri 的 path API），而判断要在真实路径上做
    let 结果 = check_directory("~").unwrap();
    assert!(
        结果.resolved.starts_with('/'),
        "~ 没展开：{}",
        结果.resolved
    );
    assert!(!结果.resolved.contains('~'));
}

#[test]
fn 认得出_git_仓库() {
    // 启动表单的「本地仓库路径」靠它 —— 填了一个不是仓库的目录，
    // 要等运行跑到 worktree 那一步才报错
    let dir = tempfile::tempdir().unwrap();
    assert!(
        !check_directory(&dir.path().display().to_string())
            .unwrap()
            .is_git_repo
    );

    std::fs::create_dir(dir.path().join(".git")).unwrap();
    assert!(
        check_directory(&dir.path().display().to_string())
            .unwrap()
            .is_git_repo
    );
}

#[test]
fn 认得出_tcc_保护区() {
    // 现在写得进去不代表以后还行：ad-hoc 签名下 App 一更新，
    // cdhash 变了，TCC 授权就不再适用（docs/MACOS-PERMISSIONS.md）。
    // 界面要能提前说这句话
    let home = std::env::var("HOME").unwrap();
    for 受保护 in ["Documents", "Desktop", "Downloads"] {
        let 结果 = check_directory(&format!("{home}/{受保护}")).unwrap();
        assert!(结果.tcc_protected, "{受保护} 没被认出来");
    }

    // 应用自己的数据目录不在保护区里
    let 结果 = check_directory(&format!("{home}/Library/Application Support")).unwrap();
    assert!(!结果.tcc_protected, "Application Support 被误判成保护区");
}

#[test]
fn 空路径不当成主目录() {
    // 空串走 `PathBuf::from("")` 会变成当前目录，于是「什么都没填」
    // 被当成「选了一个能用的目录」
    let 结果 = check_directory("   ").unwrap();
    assert!(!结果.writable);
    assert!(结果.message.is_some());
}

// ── 创建目录 ────────────────────────────────────────────────────────────
//
// 首次配置的死路：默认工作目录不存在时，探测只报「不存在」，
// 应用里没有任何创建它的入口 ——「开始使用」永远灰着。

#[test]
fn 创建目录_建出来并且立刻可写() {
    let dir = tempfile::tempdir().unwrap();
    let 目标 = dir.path().join("AI Workflows");
    let 结果 = aiwf_core_api::env::create_directory(&目标.display().to_string()).unwrap();

    assert!(结果.exists, "说创建了却不存在");
    assert!(结果.writable, "创建出来的目录写不进去：{:?}", 结果.message);
    assert!(目标.is_dir());
}

#[test]
fn 创建目录_中间层级一并补齐() {
    // 默认路径是 ~/Library/Application Support/AI Workflows ——
    // 逐层都可能缺，只建最后一层的话默认值照样是死路
    let dir = tempfile::tempdir().unwrap();
    let 目标 = dir.path().join("a/b/c");
    let 结果 = aiwf_core_api::env::create_directory(&目标.display().to_string()).unwrap();

    assert!(结果.writable);
    assert!(目标.is_dir());
}

#[test]
fn 创建目录_已存在时等价于一次探测() {
    // 连点两次「创建」不能报错 —— create_dir_all 幂等
    let dir = tempfile::tempdir().unwrap();
    let 结果 = aiwf_core_api::env::create_directory(&dir.path().display().to_string()).unwrap();
    assert!(结果.exists);
    assert!(结果.writable);
}

#[test]
fn 创建目录_空路径直接拒绝() {
    // 与 check_directory 同一个坑：空串会变成当前目录
    let 结果 = aiwf_core_api::env::create_directory("   ").unwrap();
    assert!(!结果.writable);
    assert!(结果.message.is_some());
}

#[test]
fn 创建目录_建不出来时说清原因而不是恐慌() {
    let dir = tempfile::tempdir().unwrap();
    let 只读 = dir.path().join("只读");
    std::fs::create_dir(&只读).unwrap();
    let mut perms = std::fs::metadata(&只读).unwrap().permissions();
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o555);
    }
    std::fs::set_permissions(&只读, perms).unwrap();

    let 结果 = aiwf_core_api::env::create_directory(&只读.join("新目录").display().to_string())
        .unwrap();
    assert!(!结果.writable);
    let message = 结果.message.expect("失败了却没给理由");
    assert!(
        message.contains("建不出来") || message.contains("权限") || message.contains("写不"),
        "理由要能看懂：{message}"
    );
}
