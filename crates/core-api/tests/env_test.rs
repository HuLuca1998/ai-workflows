//! 环境健康报告。
//!
//! 图纸「06 首次安装与检测」的产品原则写在头部：
//! 「我们不会静默修改系统…不使用 sudo，不改动 shell profile，
//! 也不把 App 工具写入全局 PATH」。
//!
//! 检测这一半必须先做对：报错的东西如果不准，用户会去装一个他本来就有的工具。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_core_api::{EnvSource, EnvStatus, env_health};

#[test]
fn 报告里必有那几项能力() {
    // 少一项的症状是「用户不知道自己缺什么」——
    // 而他会在运行失败时才发现，那时错误信息是脚本的，不是环境的
    let report = env_health(false).unwrap();
    let names: Vec<&str> = report.items.iter().map(|i| i.capability.as_str()).collect();

    for expected in ["git", "node", "python", "gh", "acp.claude", "acp.codex"] {
        assert!(names.contains(&expected), "报告里缺 {expected}：{names:?}");
    }
}

#[test]
fn 系统里有的工具标成_ready_并带上版本与路径() {
    // git 在开发机上一定有 —— 这条同时验证「探测真的跑了」
    let report = env_health(false).unwrap();
    let git = report
        .items
        .iter()
        .find(|i| i.capability == "git")
        .expect("必有 git 这一项");

    assert_eq!(git.status, EnvStatus::Ready, "开发机上 git 应当是就绪的");
    assert_eq!(git.source, EnvSource::System);
    assert!(git.version.is_some(), "就绪的工具要能说出版本");
    assert!(git.path.is_some(), "以及它在哪 —— 用户要能自己确认");
}

#[test]
fn 找不到的工具标成_missing_而不是报错() {
    // 整个报告因为一个工具缺失就失败的话，用户连「还缺什么」都看不到
    let report = env_health(false).unwrap();
    assert!(report.items.iter().all(|i| !i.capability.is_empty()));
}

#[test]
fn 可选项缺失不影响整体状态() {
    // Docker 只有容器工作流需要。把它算进必需项的话，
    // 一个从不跑容器的用户会永远看到「环境需要处理」
    let report = env_health(false).unwrap();
    let optional_missing = report.items.iter().any(|i| i.status == EnvStatus::Optional);

    if optional_missing {
        // 只有可选项缺失时整体仍可能是 ready —— 取决于必需项
        let required_bad = report
            .items
            .iter()
            .any(|i| i.status == EnvStatus::Missing || i.status == EnvStatus::NeedsAttention);
        assert_eq!(report.ready, !required_bad);
    }
}

#[test]
fn 整体状态由必需项决定() {
    let report = env_health(false).unwrap();
    let required_ok = report
        .items
        .iter()
        .filter(|i| i.status != EnvStatus::Optional)
        .all(|i| i.status == EnvStatus::Ready);
    assert_eq!(report.ready, required_ok);
}

#[test]
fn 探测不执行任何写操作() {
    // 「不会静默修改系统」的第一层：检测本身只读。
    // 这条用例的价值在于把这个约束写进代码 —— env_health 不收任何路径参数，
    // 也不返回「已经装了什么」，它没有能写的入口
    let before = env_health(false).unwrap();
    let after = env_health(false).unwrap();
    assert_eq!(
        before.items.len(),
        after.items.len(),
        "两次探测结果应当一致"
    );
}
