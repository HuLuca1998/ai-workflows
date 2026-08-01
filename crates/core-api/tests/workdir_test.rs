//! 运行的工作目录。
//!
//! 启动表单上写着：「留空则用应用的运行目录。**每次运行一个独立目录，
//! 并行运行互不影响。**」`Runner::workdir` 的注释也写着「每个 Run 一个」。
//!
//! 第 4 轮复验实测：并发起 5 个运行，每个都 `echo > mark.txt` 再读回，
//! 磁盘上只有**一个** `mark.txt`，内容是其中某一个运行写的 ——
//! 默认路径下所有运行共用 `data_dir/runs`，谁后写谁赢。
//!
//! M2 的出口标准之一是「同一工作流不同参数并行运行互不影响」，
//! 而 `supervisor_test` 里那条验证**显式传了不同的 workdir**，
//! 恰好绕开了产品的默认路径。这里补上默认路径这一侧。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

/// 起一个运行（不指定 workdir），返回它落库的工作目录。
fn 起一次(
    store: &Store,
    supervisor: &aiwf_engine::supervisor::Supervisor,
    data_dir: &std::path::Path,
    wf: &str,
) -> String {
    let run_id = aiwf_core_api::run_start(
        store,
        supervisor,
        data_dir,
        wf.to_string(),
        None,
        Some(0),
        "{}".to_string(),
        None, // ← 不指定工作目录，走默认,
        aiwf_engine::schedule::Trigger::Manual,
    )
    .expect("run_start 应当返回 run id（哪怕 preflight 没过）");

    store
        .run_workdir(&run_id)
        .unwrap()
        .expect("运行必须落库工作目录")
}

#[test]
fn 未指定工作目录时每个运行各得一个() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let supervisor = aiwf_engine::supervisor::Supervisor::new(dir.path().join("db.sqlite"));
    let wf = store.create_workflow("并发隔离", None).unwrap();

    let 甲 = 起一次(&store, &supervisor, dir.path(), &wf);
    let 乙 = 起一次(&store, &supervisor, dir.path(), &wf);

    assert_ne!(
        甲, 乙,
        "两个运行拿到了同一个工作目录 —— 它们写同名文件会互相覆盖，\
         而启动表单承诺的是「每次运行一个独立目录，并行运行互不影响」"
    );
}

#[test]
fn 默认工作目录仍在应用的运行目录之下() {
    // 隔离不能靠把目录扔到别处实现 —— 用户要能在
    //「将写入的位置」那一屏说的地方找到它们
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let supervisor = aiwf_engine::supervisor::Supervisor::new(dir.path().join("db.sqlite"));
    let wf = store.create_workflow("路径归属", None).unwrap();

    let 目录 = 起一次(&store, &supervisor, dir.path(), &wf);
    let 根 = dir.path().join("runs");

    assert!(
        std::path::Path::new(&目录).starts_with(&根),
        "工作目录 {} 不在 {} 之下",
        目录,
        根.display()
    );
}

#[test]
fn 用户显式指定的目录原样使用_不被拆成子目录() {
    // 显式指定通常是「跑在我这个仓库里」，再往下套一层子目录就跑错地方了
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let supervisor = aiwf_engine::supervisor::Supervisor::new(dir.path().join("db.sqlite"));
    let wf = store.create_workflow("显式目录", None).unwrap();
    let 指定 = dir.path().join("我的仓库");
    std::fs::create_dir_all(&指定).unwrap();

    let run_id = aiwf_core_api::run_start(
        store_ref(&store),
        &supervisor,
        dir.path(),
        wf,
        None,
        Some(0),
        "{}".to_string(),
        Some(指定.display().to_string()),
        aiwf_engine::schedule::Trigger::Manual,
    )
    .unwrap();

    let 落库 = store.run_workdir(&run_id).unwrap().unwrap();
    assert_eq!(落库, 指定.display().to_string(), "显式指定的目录被改动了");
}

fn store_ref(store: &Store) -> &Store {
    store
}
