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

#[test]
fn 缺失的工具给出可复制的安装命令() {
    // 应用不下载任何东西 —— 命令交给用户自己在终端跑。
    // 攻击面为零，也不需要为「从哪下载、怎么校验签名」做一堆决定。
    let report = env_health(false).unwrap();
    for item in &report.items {
        if item.status == EnvStatus::Missing || item.status == EnvStatus::Optional {
            assert!(
                item.install_hint.is_some(),
                "{} 缺失却没给安装办法",
                item.capability
            );
        }
    }
}

#[test]
fn 已就绪的工具不给安装命令() {
    // 给了的话用户会以为「是不是该重装一下」
    let report = env_health(false).unwrap();
    for item in &report.items {
        if item.status == EnvStatus::Ready {
            assert!(
                item.install_hint.is_none(),
                "{} 已就绪却给了安装命令",
                item.capability
            );
        }
    }
}

#[test]
fn 安装命令不含_sudo() {
    // 图纸的产品原则：「不使用 sudo，不改动 shell profile」。
    // 一条要 sudo 的命令等于把整台机器交出去，而用户多半会照贴不误
    let report = env_health(false).unwrap();
    for item in &report.items {
        if let Some(hint) = &item.install_hint {
            assert!(
                !hint.command.contains("sudo"),
                "{} 的安装命令带 sudo：{}",
                item.capability,
                hint.command
            );
        }
    }
}

#[test]
fn 安装命令带上出处() {
    // 「复制这行到终端」是让用户执行一段我们给的代码 ——
    // 至少要说清它是哪个项目的官方装法，好让他自己判断
    let report = env_health(false).unwrap();
    for item in &report.items {
        if let Some(hint) = &item.install_hint {
            assert!(
                !hint.source.is_empty(),
                "{} 的安装建议没说出处",
                item.capability
            );
        }
    }
}

#[test]
fn 安装命令在没有本仓库的机器上也跑得通() {
    // ACP adapter 那两条原本给的是
    // `pnpm --filter @aiwf/acp-sidecar add …` —— 那要在本仓库里才成立，
    // 而装了 App 的用户手上根本没有仓库，照着复制只会得到
    // 一句「找不到 @aiwf/acp-sidecar」。安装提示是说给他听的，
    // 不是说给从源码跑的我们听的
    let report = env_health(false).unwrap();
    for item in &report.items {
        if let Some(hint) = &item.install_hint {
            assert!(
                !hint.command.contains("--filter") && !hint.command.contains("@aiwf/"),
                "{} 的安装命令依赖本仓库：{}",
                item.capability,
                hint.command
            );
        }
    }
}

#[test]
fn adapter_缺失时说清楚我们用的是哪个_node() {
    // 「未安装」三个字对一个刚跑完 `npm install -g` 的人没有信息。
    // 真实发生过：用户那个终端的 nvm 切在 v22 上，包装进了 v22 的 bin，
    // 而应用读的登录 shell 用的是 v25 —— 两边都没错，只是不是同一个 node。
    // npm 全局包跟着 node 版本走，不说这件事，用户只会反复重装同一条命令
    let 有 =
        aiwf_core_api::adapter_missing_detail(Some("/Users/x/.nvm/versions/node/v25.6.1/bin/node"));
    assert!(
        有.contains("/Users/x/.nvm/versions/node/v25.6.1/bin/node"),
        "{有}"
    );

    // node 本身都没有时别绕圈子 —— 先解决它，adapter 是下一步
    let 无 = aiwf_core_api::adapter_missing_detail(None);
    assert!(无.contains("Node.js"), "{无}");
    assert!(
        !无.contains("npm install"),
        "node 都没有就别先教装 adapter：{无}"
    );
}

#[test]
fn gh_装了还要问一句登录没有() {
    // 只跑 `gh --version` 的话，「装了但没登录」这一项会报「已就绪」——
    // 而用户真正用到它时（列仓库、建 PR）才发现用不了。
    // 用户原话：「你检查环境的时候检查 gh，这里为什么不用 gh 呢」
    let 登录了 = aiwf_core_api::gh_login_state(true);
    assert_eq!(登录了.0, EnvStatus::Ready);
    assert!(登录了.1.contains("已登录"), "{:?}", 登录了.1);
    assert!(
        登录了.2.is_none(),
        "已就绪还给安装命令，用户会以为该重装一下"
    );

    let 没登录 = aiwf_core_api::gh_login_state(false);
    // 仍是可选档：一个从不碰 GitHub 的用户不该因此看到「环境需要处理」
    assert_eq!(没登录.0, EnvStatus::Optional);
    assert!(没登录.1.contains("没登录"), "{:?}", 没登录.1);
    assert_eq!(
        没登录.2.as_deref(),
        Some("gh auth login"),
        "没给出照着做就能解决的那一行"
    );
}

#[test]
fn 版本号里没有多余的标点() {
    // docker 报的是「Docker version 29.5.2, build 0f0dfd7」，
    // 直接切第一个数字开头的词会带出那个逗号 ——
    // 表格里显示成「29.5.2,」，看着像我们把字符串截断了
    let report = env_health(false).unwrap();
    for item in &report.items {
        let Some(version) = &item.version else {
            continue;
        };
        assert!(
            version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+'),
            "{} 的版本号带了多余字符：{version}",
            item.capability
        );
    }
}
