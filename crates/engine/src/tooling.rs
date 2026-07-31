//! 子进程去哪儿找工具。
//!
//! macOS 上从 Finder / Dock 启动的 App 由 launchd 拉起，继承的 PATH 是
//! `/usr/bin:/bin:/usr/sbin:/sbin` —— 用户的 shell 配置一个字都不读。
//! 于是 node（nvm / homebrew）、gh、docker 全都找不到，而他在终端里
//! 明明装齐了。实测一个正在跑的打包版：
//!
//! ```text
//! PID 58206  /Applications/AI Workflows.app/Contents/MacOS/aiwf-desktop
//! PATH=/usr/bin:/bin:/usr/sbin:/sbin
//! cwd=/
//! ```
//!
//! 开发时看不见这个坑：`pnpm tauri dev` 从终端起，继承的是完整 PATH。
//! 要复现打包版的处境，把任何一个二进制放进同一份贫瘠环境里跑：
//!
//! ```sh
//! env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=$HOME SHELL=$SHELL \
//!   ./target/debug/deps/tooling_test-<hash>
//! ```
//!
//! **所有子进程都得走这里**。探测用一份 PATH、执行用另一份的话，
//! 「环境检查说已就绪」与「运行时 command not found」会同时成立 ——
//! 而后者要等到用户跑第一条工作流才暴露。
//!
//! 只读，不写：不改 shell profile，也不往全局 PATH 里塞东西
//! （图纸「06 首次安装与检测」的产品原则）。问登录 shell 要一份 PATH
//! 是读用户自己的配置，与那句话不冲突。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

/// launchd 给 GUI 进程的那份 PATH。除了这几条之外什么都没有，
/// 就说明我们是被 Finder / Dock 拉起来的。
const SYSTEM_DIRS: &[&str] = &["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// 问不到登录 shell 时的兜底。
///
/// 覆盖不了 nvm 那种带版本号的路径（`~/.nvm/versions/node/v25.6.1/bin`）——
/// 那正是必须去问 shell 的理由，这里只是问不到时的下限。
const COMMON_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

/// 等登录 shell 吐出 PATH 的上限。
///
/// 用户的 zsh 里可能挂着一串插件，慢是常事；但慢到这个份上，
/// 让应用启动跟着卡住不如先用兜底那份跑起来。
const ASK_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

static PARSED: OnceLock<String> = OnceLock::new();

/// 这个进程该用的 PATH。第一次调用时解析，之后直接取缓存。
pub fn user_path() -> &'static str {
    PARSED.get_or_init(|| resolve_path(&std::env::var("PATH").unwrap_or_default(), ask_login_shell))
}

/// [`user_path`] 的决策部分，把「去哪问」抽出来当参数。
///
/// 抽这一层是因为**开发机上永远走不到问 shell 那条分支** —— 终端起的进程
/// PATH 本来就是全的。不抽的话，打包版真正跑的那半边代码一次都没被执行过。
pub fn resolve_path(inherited: &str, ask: impl FnOnce() -> Option<String>) -> String {
    if !looks_bare(inherited) {
        // 从终端起来的：用户 shell 里有什么这里就有什么，不必再问一遍
        return merge_paths(&[inherited]);
    }

    match ask() {
        Some(from_shell) => merge_paths(&[inherited, &from_shell, &COMMON_DIRS.join(":")]),
        // 问不到也要给个下限：homebrew 那几条比什么都没有强
        None => merge_paths(&[inherited, &COMMON_DIRS.join(":")]),
    }
}

/// 找一个命令的绝对路径，找不到返回 `None`。
///
/// 不再 fork 一个 `which` 出去：那既慢，又把结果绑在子进程继承的 PATH 上 ——
/// 而那份 PATH 正是要修的东西。
pub fn which(program: &str) -> Option<PathBuf> {
    resolve_in(user_path(), program)
}

/// 起一个子进程，PATH 已经是 [`user_path`] 那份。
///
/// `Command::new` 直接用的话，子进程继承的仍是 launchd 那四条。
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", user_path());
    cmd
}

/// 在给定的 PATH 里找可执行文件。纯函数 —— 测试能喂任意 PATH 进来。
pub fn resolve_in(path: &str, program: &str) -> Option<PathBuf> {
    // 已经是路径的（`./x` 或 `/usr/bin/x`）不查 PATH，这是 shell 的语义
    if program.contains('/') {
        let candidates = PathBuf::from(program);
        return is_exec(&candidates).then_some(candidates);
    }

    path.split(':')
        // 空项在 POSIX 里指当前目录，而打包版的当前目录是 `/`：
        // 按它去找，等于让「工具在哪」取决于 App 是被谁拉起来的
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(program))
        .find(|candidates| is_exec(candidates))
}

/// 把几份 PATH 拼成一份：去重、丢空项、保持先来后到。
///
/// 先来的优先级高 —— 继承来的排在补进来的前面，
/// 用户显式设过的东西不该被兜底那一串顶掉。
pub fn merge_paths(piece: &[&str]) -> String {
    let mut result: Vec<&str> = Vec::new();
    for chunk in piece {
        for dir in chunk.split(':') {
            if !dir.is_empty() && !result.contains(&dir) {
                result.push(dir);
            }
        }
    }
    result.join(":")
}

/// 这份 PATH 是不是 launchd 给的那份贫瘠版本。
///
/// 判据是「除了系统那四条之外还有没有别的」。有别的就说明进程是从终端
/// 起来的，用户 shell 里的东西已经在里面了 —— 再去问一次登录 shell
/// 只是白白多花几百毫秒。
pub fn looks_bare(path: &str) -> bool {
    !path
        .split(':')
        .filter(|dir| !dir.is_empty())
        .any(|dir| !SYSTEM_DIRS.contains(&dir))
}

/// 问用户的登录 shell 要一份 PATH。
///
/// `-l -i` 两个都要：`-l` 读 `.zprofile`，`-i` 读 `.zshrc`，
/// 而 nvm / rbenv / mise 这类版本管理器多半写在后者。少一个就拿不到 node。
///
/// 超时靠另开一条线程等 —— `Command::output()` 自己没有超时，
/// 而一个卡住的 shell 会让应用永远停在启动画面。
fn ask_login_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        // printf 而不是 echo：不同 shell 的 echo 对转义的处理不一样，
        // 而这里要的是一字不差的 PATH
        let result = Command::new(&shell)
            .args(["-l", "-i", "-c", "printf %s \"$PATH\""])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
        // 收端可能已经超时走了，发不出去是正常情况
        let _ = tx.send(result);
    });

    rx.recv_timeout(ASK_SHELL_TIMEOUT)
        .ok()
        .flatten()
        .filter(|path| !path.is_empty())
}

fn is_exec(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}
