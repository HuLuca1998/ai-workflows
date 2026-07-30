//! 一键初始化的 Core API 侧。
//!
//! 存储层管「库怎么清」，这一层管三件存储层看不见的事：
//! 目录删不删、删哪些、以及**在删之前先说清楚要删什么**。
//!
//! 最后一件不是客套。运行产物落在用户自己授权的工作目录下
//! （`<workdir>/.aiwf-artifacts`），不在 App 数据目录里 ——
//! 不把这条路径摆到用户眼前，他不会知道自己的代码仓库里有东西要没。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Mutex;

use aiwf_store::Store;

fn 环境() -> (tempfile::TempDir, Mutex<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_workspace(&dir.path().join("aiwf.sqlite")).unwrap();
    (dir, Mutex::new(store))
}

/// 造一个有东西的运行目录，好看出「删了没有」。
fn 造目录(根: &std::path::Path, 名: &str) -> std::path::PathBuf {
    let 目录 = 根.join(名);
    std::fs::create_dir_all(&目录).unwrap();
    std::fs::write(目录.join("留下的东西.txt"), "x").unwrap();
    目录
}

mod 预览 {
    use super::*;

    #[test]
    fn 报出库里现在有多少东西() {
        let (dir, store) = 环境();
        {
            let store = store.lock().unwrap();
            store.create_workflow("我的", None).unwrap();
        }

        let 预览 = aiwf_core_api::workspace_reset_preview(&store.lock().unwrap(), dir.path(), None)
            .unwrap();

        // 示例工作流 + 用户自己建的那条
        assert!(预览.counts.workflows >= 2, "{:?}", 预览.counts);
        // 内置的四个角色与两个模型
        assert_eq!(预览.counts.agents, 4);
        assert_eq!(预览.counts.models, 2);
    }

    #[test]
    fn 只列真的存在的目录() {
        // 列一个不存在的路径，用户会以为那里有他的东西
        let (dir, store) = 环境();
        造目录(dir.path(), "runs");

        let 预览 = aiwf_core_api::workspace_reset_preview(&store.lock().unwrap(), dir.path(), None)
            .unwrap();

        let kinds: Vec<&str> = 预览.directories.iter().map(|d| d.kind.as_str()).collect();
        assert!(kinds.contains(&"runs"), "{kinds:?}");
        assert!(!kinds.contains(&"logs"), "logs 目录不存在却被列了出来");
    }

    #[test]
    fn 工作目录里的产物要标出来() {
        // 这条是整个功能里最容易伤到人的地方：那个目录在用户的代码仓库里
        let (dir, store) = 环境();
        let workdir = tempfile::tempdir().unwrap();
        造目录(workdir.path(), ".aiwf-artifacts");

        let 预览 = aiwf_core_api::workspace_reset_preview(
            &store.lock().unwrap(),
            dir.path(),
            Some(workdir.path()),
        )
        .unwrap();

        let 产物 = 预览
            .directories
            .iter()
            .find(|d| d.kind == "artifacts")
            .expect("产物目录没被列出来");
        assert!(产物.inside_workdir, "产物目录没标成「在你的工作目录里」");
        assert!(产物.path.contains(".aiwf-artifacts"), "{}", 产物.path);
    }

    #[test]
    fn 没授权工作目录时不凭空编一个产物路径() {
        let (dir, store) = 环境();
        let 预览 = aiwf_core_api::workspace_reset_preview(&store.lock().unwrap(), dir.path(), None)
            .unwrap();
        assert!(!预览.directories.iter().any(|d| d.kind == "artifacts"));
    }
}

mod 执行 {
    use super::*;

    #[test]
    fn 清库并把内置数据种回来() {
        let (dir, store) = 环境();
        {
            let store = store.lock().unwrap();
            store.create_workflow("我的", None).unwrap();
        }

        aiwf_core_api::workspace_reset(&mut store.lock().unwrap(), dir.path(), None, false)
            .unwrap();

        let store = store.lock().unwrap();
        let (工作流, _) = store.list_workflows_paged(50, 0).unwrap();
        assert!(!工作流.iter().any(|w| w.name == "我的"));
        assert!(工作流.iter().any(|w| w.name == "GitHub Issue 修复"));
        assert_eq!(
            store.list_models_paged(true, None, 50, 0).unwrap().0.len(),
            2
        );
    }

    #[test]
    fn 删掉_app_自己的运行目录() {
        let (dir, store) = 环境();
        let runs = 造目录(dir.path(), "runs");
        let logs = 造目录(dir.path(), "logs");

        let 结果 =
            aiwf_core_api::workspace_reset(&mut store.lock().unwrap(), dir.path(), None, false)
                .unwrap();

        assert!(!runs.exists(), "runs 目录还在");
        assert!(!logs.exists(), "logs 目录还在");
        assert_eq!(结果.removed_directories.len(), 2, "{结果:?}");
    }

    #[test]
    fn 默认不碰工作目录里的产物() {
        // 「没说」只能理解成「别碰」—— 那个目录在用户的代码仓库里
        let (dir, store) = 环境();
        let workdir = tempfile::tempdir().unwrap();
        let 产物 = 造目录(workdir.path(), ".aiwf-artifacts");

        aiwf_core_api::workspace_reset(
            &mut store.lock().unwrap(),
            dir.path(),
            Some(workdir.path()),
            false,
        )
        .unwrap();

        assert!(产物.exists(), "没让删产物，却把用户仓库里的目录删了");
    }

    #[test]
    fn 明确要求时才删产物() {
        let (dir, store) = 环境();
        let workdir = tempfile::tempdir().unwrap();
        let 产物 = 造目录(workdir.path(), ".aiwf-artifacts");

        let 结果 = aiwf_core_api::workspace_reset(
            &mut store.lock().unwrap(),
            dir.path(),
            Some(workdir.path()),
            true,
        )
        .unwrap();

        assert!(!产物.exists(), "勾了「一起删」却没删");
        assert!(
            结果
                .removed_directories
                .iter()
                .any(|p| p.contains(".aiwf-artifacts")),
            "{结果:?}"
        );
    }

    #[test]
    fn 只删产物目录_不碰工作目录里的别的东西() {
        // PathGuard 那条纪律在这里同样成立：用户的代码不是我们的地盘
        let (dir, store) = 环境();
        let workdir = tempfile::tempdir().unwrap();
        造目录(workdir.path(), ".aiwf-artifacts");
        let 用户的代码 = workdir.path().join("src");
        std::fs::create_dir_all(&用户的代码).unwrap();
        std::fs::write(用户的代码.join("main.rs"), "fn main(){}").unwrap();

        aiwf_core_api::workspace_reset(
            &mut store.lock().unwrap(),
            dir.path(),
            Some(workdir.path()),
            true,
        )
        .unwrap();

        assert!(用户的代码.join("main.rs").exists(), "把用户的源码删了");
    }

    #[test]
    fn 回报的是真删掉的_不是打算删的() {
        // 目录本来就不存在时不该出现在回报里 —— 界面照这份清单
        // 告诉用户「已清除以下位置」，多一条就是在说假话
        let (dir, store) = 环境();
        let 结果 =
            aiwf_core_api::workspace_reset(&mut store.lock().unwrap(), dir.path(), None, false)
                .unwrap();
        assert!(结果.removed_directories.is_empty(), "{结果:?}");
    }

    #[test]
    fn 工作目录授权也一起清掉() {
        // 真·恢复出厂：设置存在库里，「数据库里的东西全没了」这句话没有例外。
        // 界面在入口与确认框里都写明了这件事
        let (dir, store) = 环境();
        {
            let store = store.lock().unwrap();
            store
                .set_workspace_setting("workdir", "/tmp/我的仓库")
                .unwrap();
        }

        aiwf_core_api::workspace_reset(&mut store.lock().unwrap(), dir.path(), None, false)
            .unwrap();

        let store = store.lock().unwrap();
        assert!(store.workspace_settings().unwrap().workdir.is_none());
    }

    #[test]
    fn 产物路径要在清库之前定下来() {
        // 踩过：workdir 存在库里，清库那一刻就没了。调用方**清库前**
        // 读出来传进来，顺序反过来的话产物永远删不掉 —— 而且
        // removedDirectories 是空的，界面会照实说「没有需要清除的目录」，
        // 用户看不出自己勾的那一项被无声地跳过了
        let (dir, store) = 环境();
        let workdir = tempfile::tempdir().unwrap();
        let 产物 = 造目录(workdir.path(), ".aiwf-artifacts");
        {
            let store = store.lock().unwrap();
            store
                .set_workspace_setting("workdir", &workdir.path().display().to_string())
                .unwrap();
        }

        // 模拟调用方：清库前读 workdir
        let 清库前读到的 = {
            let store = store.lock().unwrap();
            store.workspace_settings().unwrap().workdir
        };
        assert!(清库前读到的.is_some(), "前置条件没成立");

        let 结果 = aiwf_core_api::workspace_reset(
            &mut store.lock().unwrap(),
            dir.path(),
            清库前读到的.as_ref().map(std::path::Path::new),
            true,
        )
        .unwrap();

        assert!(!产物.exists(), "产物没删掉");
        assert_eq!(结果.removed_directories.len(), 1, "{结果:?}");
    }
}

/// 有运行在跑的时候不能清空重来。
///
/// `workspace_reset` 直接 `reset_workspace()`，全程没有「先看看有没有
/// active run」这一步，也没有停掉任何执行线程（`Supervisor` 根本没传进来）。
///
/// 实测过的后果：重置报成功、运行记录消失，**而那个 shell 脚本跑完了、
/// 文件写进去了**。它写事件时撞的 `FOREIGN KEY constraint failed`
/// 只 `eprintln!` 到 stderr，打包版里没人看得到。
///
/// 用户点「清空重来」，界面说清完了，几秒后磁盘上多出几个文件、
/// 或者一个 `git push` 发出去了 —— 他不会把这两件事联系起来。
mod 有运行在跑时不清空 {
    use super::*;

    /// 造一条停在非终态的运行。
    fn 造一条活着的运行(store: &Store) -> String {
        let wf = store.create_workflow("在跑的", None).unwrap();
        let run = store.create_run_for_test(&wf).unwrap();
        store.set_run_status(&run, "running", None).unwrap();
        run
    }

    #[test]
    fn 拒绝并说清是哪几条() {
        let (dir, store) = 环境();
        let run_id = {
            let store = store.lock().unwrap();
            造一条活着的运行(&store)
        };

        let 结果 = {
            let mut store = store.lock().unwrap();
            aiwf_core_api::workspace_reset(&mut store, dir.path(), None, false)
        };

        let 错 = 结果.expect_err("有运行在跑却让清空成功了");
        assert!(
            错.message.contains("还在跑") || 错.message.contains("运行"),
            "没说清为什么拒绝：{}",
            错.message
        );
        assert!(错.message.contains(&run_id), "没说是哪一条：{}", 错.message);
        assert!(错.hint.is_some(), "没说接下来该干什么");

        // 库还在 —— 拒绝就要拒绝干净，不能删一半
        let store = store.lock().unwrap();
        assert!(
            store.get_run(&run_id).unwrap().is_some(),
            "拒绝了却已经把运行记录删了"
        );
    }

    #[test]
    fn 全是终态时照常清空() {
        // 跑完的、失败的、取消的都不该拦着用户重来
        let (dir, store) = 环境();
        {
            let store = store.lock().unwrap();
            for status in ["succeeded", "failed", "cancelled"] {
                let run = 造一条活着的运行(&store);
                store.set_run_status(&run, status, None).unwrap();
            }
        }

        let mut store = store.lock().unwrap();
        let 结果 = aiwf_core_api::workspace_reset(&mut store, dir.path(), None, false).unwrap();
        assert!(结果.ok);
    }
}
