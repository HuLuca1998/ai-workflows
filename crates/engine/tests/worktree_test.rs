//! Git worktree 节点：真的建 worktree，真的验证隔离。
//!
//! 图纸里那条记忆说的是「worktree 保留到 PR 合并」—— 所以清理策略必须是
//! 显式决定，绝不能顺手删掉用户还在看的工作区。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::Command;

use aiwf_engine::worktree::{WorktreeRequest, cleanup_worktree, create_worktree};

/// 建一个真实的 git 仓库当基底。
fn fixture_repo(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("aiwf_wt_{name}"));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(out_dir(&root));
    std::fs::create_dir_all(&root).unwrap();

    let git = |args: &[&str]| {
        let ok = Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            ok.status.success(),
            "git {args:?} 失败：{}",
            String::from_utf8_lossy(&ok.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "test@example.com"]);
    git(&["config", "user.name", "Test"]);
    std::fs::write(root.join("README.md"), "base\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    root
}

/// worktree 的落地目录：跟着 repo 走，避免不同测试互相踩到残留目录。
fn out_dir(repo: &Path) -> PathBuf {
    let name = repo.file_name().unwrap().to_string_lossy();
    std::env::temp_dir().join(format!("{name}_out"))
}

fn request(repo: &Path, branch: &str) -> WorktreeRequest {
    WorktreeRequest {
        repo_root: repo.to_path_buf(),
        base_branch: "main".to_string(),
        branch: branch.to_string(),
        parent_dir: out_dir(repo),
    }
}

#[test]
fn 创建_worktree_产出真实目录与新分支() {
    let repo = fixture_repo("create");
    let result = create_worktree(request(&repo, "fix/aiwf-1")).unwrap();

    assert!(result.path.is_dir(), "worktree 目录应当存在");
    assert!(result.path.join("README.md").is_file(), "应当有基底的文件");
    assert_eq!(result.branch, "fix/aiwf-1");

    let head = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&result.path)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "fix/aiwf-1");
}

#[test]
fn worktree_里的改动不影响主仓库工作区() {
    // 这是 worktree 存在的全部理由：Agent 改代码不能碰用户正在编辑的分支
    let repo = fixture_repo("isolate");
    let result = create_worktree(request(&repo, "fix/aiwf-2")).unwrap();

    std::fs::write(result.path.join("README.md"), "changed by agent\n").unwrap();

    let main_content = std::fs::read_to_string(repo.join("README.md")).unwrap();
    assert_eq!(main_content, "base\n", "主仓库的文件不该被动过");

    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "主仓库工作区应当保持干净"
    );
}

#[test]
fn 两个并行运行拿到互不相同的_worktree() {
    let repo = fixture_repo("parallel");
    let a = create_worktree(request(&repo, "fix/run-a")).unwrap();
    let b = create_worktree(request(&repo, "fix/run-b")).unwrap();

    assert_ne!(a.path, b.path);
    std::fs::write(a.path.join("marker.txt"), "a").unwrap();
    assert!(
        !b.path.join("marker.txt").exists(),
        "两个工作区必须互相看不见"
    );
}

#[test]
fn 分支已存在时报错而不是悄悄复用() {
    // 复用一个已有分支意味着把别人的改动混进这次运行 —— 必须拒绝
    let repo = fixture_repo("dup");
    create_worktree(request(&repo, "fix/dup")).unwrap();
    let error = create_worktree(request(&repo, "fix/dup"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("fix/dup"), "错误信息实际：{error}");
}

#[test]
fn 不是_git_仓库时给出可操作的错误() {
    let dir = std::env::temp_dir().join("aiwf_wt_notgit");
    std::fs::create_dir_all(&dir).unwrap();
    let error = create_worktree(request(&dir, "fix/x"))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Git 仓库") || error.contains("git"),
        "错误信息实际：{error}"
    );
}

#[test]
fn 基础分支不存在时报错() {
    let repo = fixture_repo("nobase");
    let mut req = request(&repo, "fix/y");
    req.base_branch = "does-not-exist".to_string();
    let error = create_worktree(req).unwrap_err().to_string();
    assert!(error.contains("does-not-exist"), "错误信息实际：{error}");
}

#[test]
fn 清理会移除_worktree_并从_git_注册表里摘掉() {
    let repo = fixture_repo("cleanup");
    let result = create_worktree(request(&repo, "fix/clean")).unwrap();
    let path = result.path.clone();

    cleanup_worktree(&repo, &path).unwrap();

    assert!(!path.exists(), "目录应当被删除");
    let list = Command::new("git")
        .args(["worktree", "list"])
        .current_dir(&repo)
        .output()
        .unwrap();
    let listed = String::from_utf8_lossy(&list.stdout);
    assert!(
        !listed.contains("fix/clean"),
        "git 注册表里不该还留着：{listed}"
    );
}

#[test]
fn 清理有未提交改动的_worktree_会被拒绝() {
    // 「宁可留着一个孤儿目录，也不要删掉用户还没保存的工作」
    let repo = fixture_repo("dirty");
    let result = create_worktree(request(&repo, "fix/dirty")).unwrap();
    std::fs::write(result.path.join("wip.txt"), "未提交的工作\n").unwrap();

    let error = cleanup_worktree(&repo, &result.path)
        .unwrap_err()
        .to_string();
    assert!(error.contains("未提交"), "错误信息实际：{error}");
    assert!(result.path.exists(), "拒绝清理时目录必须还在");
}

#[test]
fn 分支名里的斜杠不会撑出目录层级() {
    // fix/aiwf-1 若直接当目录名，会在 parent 下建出 fix/ 子目录，
    // 清理时容易误删同级的别的 worktree
    let repo = fixture_repo("slash");
    let result = create_worktree(request(&repo, "feat/deep/nested")).unwrap();
    assert_eq!(
        result.path.parent().unwrap(),
        out_dir(&repo),
        "worktree 必须是 parent_dir 的直接子目录"
    );
}

#[test]
fn 有被忽略的文件时也不清理() {
    // git status --porcelain 默认不显示 .gitignore 命中的文件，
    // 于是「干净」判断通过、整个目录被递归删除 ——
    // 用户的构建缓存、本地配置、node_modules 一起没了。
    let repo = fixture_repo("ignored");
    std::fs::write(repo.join(".gitignore"), "cache/\n").unwrap();
    let git = |args: &[&str], dir: &Path| {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
    };
    git(&["add", "-A"], &repo);
    git(
        &[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=T",
            "commit",
            "-qm",
            "ignore",
        ],
        &repo,
    );

    let result = create_worktree(request(&repo, "fix/ignored")).unwrap();
    std::fs::create_dir_all(result.path.join("cache")).unwrap();
    std::fs::write(result.path.join("cache/build.bin"), "很贵的构建产物").unwrap();

    let error = cleanup_worktree(&repo, &result.path)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("忽略") || error.contains("未提交"),
        "错误信息实际：{error}"
    );
    assert!(
        result.path.join("cache/build.bin").exists(),
        "被忽略的文件被删掉了"
    );
}

#[test]
fn 只清理引擎自己建的_worktree() {
    // cleanup 只验证「这是该仓库注册过的 worktree」，
    // 于是用户手工建的干净 worktree 也会被删掉。
    let repo = fixture_repo("foreign");
    let mine = create_worktree(request(&repo, "fix/mine")).unwrap();

    // 用户自己在别处建的 worktree
    let theirs = std::env::temp_dir().join("aiwf_wt_user_owned");
    let _ = std::fs::remove_dir_all(&theirs);
    let ok = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            "user/manual",
            &theirs.to_string_lossy(),
            "main",
        ])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(ok.status.success(), "建对照 worktree 失败");

    let error = cleanup_worktree(&repo, &theirs).unwrap_err().to_string();
    assert!(error.contains("不是"), "错误信息实际：{error}");
    assert!(theirs.exists(), "用户自己的 worktree 被删了");

    // 自己建的仍然清理得掉
    cleanup_worktree(&repo, &mine.path).unwrap();

    let _ = Command::new("git")
        .args(["worktree", "remove", "--force", &theirs.to_string_lossy()])
        .current_dir(&repo)
        .output();
}
