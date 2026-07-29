//! 子进程能不能找到工具，取决于它拿到的是哪一份 PATH。
//!
//! 打包版 App 由 launchd 拉起，PATH 是 `/usr/bin:/bin:/usr/sbin:/sbin` ——
//! 用户在终端里装齐了 node / gh / docker，环境检查那一屏却说什么都没装。
//! 实测正在跑的那个进程：
//!
//! ```text
//! PID 58206  /Applications/AI Workflows.app/Contents/MacOS/aiwf-desktop
//! PATH=/usr/bin:/bin:/usr/sbin:/sbin
//! cwd=/
//! ```
//!
//! 这些用例钉住的是查找本身的行为 —— 它必须是个能喂进任意 PATH 的纯函数，
//! 否则「在这台开发机上碰巧能过」就是唯一的验证方式。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use aiwf_engine::tooling;

fn 放一个可执行文件(dir: &Path, name: &str) {
    let path = dir.join(name);
    fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn 在给定的_path_里找得到可执行文件() {
    let dir = tempfile::tempdir().unwrap();
    放一个可执行文件(dir.path(), "自造工具");

    let 找到 = tooling::resolve_in(&dir.path().display().to_string(), "自造工具");
    assert_eq!(找到, Some(dir.path().join("自造工具")));
}

#[test]
fn 不可执行的同名文件不算数() {
    // `which` 的语义是「能跑的那个」。只按文件名匹配的话，
    // 探测会说「已就绪」，而真跑起来是 Permission denied
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("看着像工具");
    fs::write(&path, "我只是一个文本文件").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    assert_eq!(
        tooling::resolve_in(&dir.path().display().to_string(), "看着像工具"),
        None
    );
}

#[test]
fn 按_path_顺序返回第一个() {
    // PATH 的语义就是顺序。返回错的那个意味着用户看到的版本号
    // 与真正被执行的不是同一个二进制
    let 前 = tempfile::tempdir().unwrap();
    let 后 = tempfile::tempdir().unwrap();
    放一个可执行文件(前.path(), "同名");
    放一个可执行文件(后.path(), "同名");

    let path = format!("{}:{}", 前.path().display(), 后.path().display());
    assert_eq!(
        tooling::resolve_in(&path, "同名"),
        Some(前.path().join("同名"))
    );
}

#[test]
fn 空目录项跳过而不是当成当前目录() {
    // POSIX 里 PATH 中的空项确实指当前目录 —— 而当前目录在打包版里是 `/`。
    // 按它去找等于让「工具在哪」取决于 App 是被谁拉起来的
    let dir = tempfile::tempdir().unwrap();
    放一个可执行文件(dir.path(), "工具");

    let path = format!(":{}:", dir.path().display());
    assert_eq!(
        tooling::resolve_in(&path, "工具"),
        Some(dir.path().join("工具"))
    );
    assert_eq!(tooling::resolve_in("::", "工具"), None);
}

#[test]
fn 合并时去重并保持先来后到() {
    // 先来的优先级高：继承来的 PATH 排在补进来的前面，
    // 用户显式设过的东西不该被我们兜底的那一串顶掉
    let 合并 = tooling::merge_paths(&["/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin", "/bin"]);
    assert_eq!(合并, "/usr/bin:/bin:/opt/homebrew/bin");
}

#[test]
fn 合并时丢掉空项与重复的分隔符() {
    assert_eq!(tooling::merge_paths(&["", "/usr/bin::", ":"]), "/usr/bin");
}

#[test]
fn 认得出_launchd_那份贫瘠的_path() {
    // 判据是「除了系统那四条之外还有没有别的」。有别的就说明
    // 这个进程是从终端起来的，不必再去问一次登录 shell
    assert!(tooling::looks_bare("/usr/bin:/bin:/usr/sbin:/sbin"));
    assert!(tooling::looks_bare(""));
    assert!(!tooling::looks_bare("/opt/homebrew/bin:/usr/bin:/bin"));
}

#[test]
fn 贫瘠时去问登录_shell_并把结果并进来() {
    // 打包版走的就是这条分支。开发机上的进程 PATH 本来就是全的，
    // 不把「去哪问」抽成参数的话，这半边代码一次都不会被执行
    let 解析 = tooling::resolve_path("/usr/bin:/bin:/usr/sbin:/sbin", || {
        Some("/Users/x/.nvm/versions/node/v25.6.1/bin:/opt/homebrew/bin:/usr/bin".to_string())
    });

    assert!(
        解析.contains("/Users/x/.nvm/versions/node/v25.6.1/bin"),
        "nvm 那种带版本号的路径只有问 shell 才拿得到：{解析}"
    );
    // 继承来的排在前面，而且不重复
    assert!(解析.starts_with("/usr/bin:/bin:/usr/sbin:/sbin:"), "{解析}");
    assert_eq!(解析.matches("/usr/bin").count(), 1, "{解析}");
}

#[test]
fn 问不到登录_shell_也要给个下限() {
    // shell 卡住或报错时整份 PATH 退回 launchd 那四条的话，
    // 结果与什么都没修一样
    let 解析 = tooling::resolve_path("/usr/bin:/bin", || None);
    assert!(解析.contains("/opt/homebrew/bin"), "{解析}");
    assert!(解析.contains("/usr/local/bin"), "{解析}");
}

#[test]
fn 不贫瘠就不去问_shell() {
    // 每次启动都跑一遍用户的 .zshrc 是几百毫秒起步的开销，
    // 而从终端起的进程里那份 PATH 已经是对的
    let 解析 = tooling::resolve_path("/opt/homebrew/bin:/usr/bin", || {
        panic!("PATH 已经是全的，不该再去问 shell")
    });
    assert_eq!(解析, "/opt/homebrew/bin:/usr/bin");
}

#[test]
fn 解析出来的_path_至少覆盖系统目录() {
    let path = tooling::user_path();
    assert!(path.contains("/usr/bin"), "实际：{path}");
}

#[test]
fn 子进程拿到的就是解析出来的那份_path() {
    // 探测与执行必须同一份。分开的话「已就绪」与「找不到命令」
    // 会同时成立，而那种不一致要到运行失败时才暴露
    let 输出 = tooling::command("sh")
        .args(["-c", "printf %s \"$PATH\""])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&输出.stdout), tooling::user_path());
}

#[test]
fn 找系统自带的工具找得到() {
    // /bin/sh 在任何 macOS 上都有 —— 这条同时验证 user_path 真的能用
    let 找到 = tooling::which("sh").expect("连 sh 都找不到，说明 PATH 解析坏了");
    assert!(找到.ends_with("sh"), "{找到:?}");
}

#[test]
fn 找不存在的工具返回_none_而不是报错() {
    assert_eq!(tooling::which("这个命令一定不存在-aiwf"), None);
}
