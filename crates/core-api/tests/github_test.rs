//! 启动表单的仓库下拉从哪来。
//!
//! 手填 `owner/name` 打错一个字，要等运行跑到 `git clone` 才报错 ——
//! 而那时 worktree 已经建好了。让用户从自己有权限的仓库里选，这类错不存在。
//!
//! 这里测的是**解析与说话**这两半，不是「这台机器上 gh 登没登录」：
//! 后者在 CI 上必然没登录，把断言压在它上面等于让测试随环境飘。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_core_api::github;

#[test]
fn 从_gh_的_json_里认出仓库与它是不是组织的() {
    // 字段名照 GitHub REST 的原样。少认一个 owner.type，
    // 组织仓库就会和个人仓库混在一列里 —— 而用户往往有几十个
    let 原样 = r#"[
      {"full_name":"BDBGAME2024/pp-game","default_branch":"live","owner":{"type":"Organization"}},
      {"full_name":"HuLuca1998/ai-workflows","default_branch":"main","owner":{"type":"User"}}
    ]"#;

    let 仓库 = github::parse_repos(原样).unwrap();

    assert_eq!(仓库.len(), 2);
    assert_eq!(仓库[0].full_name, "BDBGAME2024/pp-game");
    assert_eq!(仓库[0].default_branch, "live");
    assert!(仓库[0].is_org, "组织仓库没被认出来");
    assert!(!仓库[1].is_org);
}

#[test]
fn 缺字段的条目跳过_而不是让整个列表失败() {
    // GitHub 偶尔会返回权限受限的条目（字段残缺）。
    // 因为一条坏数据就让整个下拉打不开，用户连能选的那些都看不到
    let 有一条坏的 = r#"[
      {"full_name":"a/b","default_branch":"main","owner":{"type":"User"}},
      {"default_branch":"main"},
      {"full_name":"c/d","default_branch":"dev","owner":{"type":"Organization"}}
    ]"#;

    let 仓库 = github::parse_repos(有一条坏的).unwrap();
    assert_eq!(仓库.len(), 2, "该跳过的跳过，能用的都要留下");
}

#[test]
fn 不是合法_json_时报错_而不是当成空列表() {
    // 空列表看着像「你没有仓库」，用户会跑去 GitHub 上找自己哪儿配错了
    assert!(github::parse_repos("gh: command not found").is_err());
}

#[test]
fn 默认分支排在最前面() {
    // 十几个分支里翻 main 很烦，而它恰恰是最常选的那个
    let 分支 = github::order_branches(
        vec![
            "feature/x".to_string(),
            "main".to_string(),
            "release/1".to_string(),
        ],
        "main",
    );
    assert_eq!(分支[0], "main");
}

#[test]
fn 默认分支不在列表里时也不丢掉它() {
    // 分页只取了前 N 条时会这样。少了它用户就选不到默认分支了
    let 分支 = github::order_branches(vec!["feature/x".to_string()], "main");
    assert_eq!(分支, vec!["main", "feature/x"]);
}

#[test]
fn gh_不可用时的说明要说清下一步() {
    // 「失败了」三个字没有信息量。用户要知道的是「装 gh」还是「登录」
    let 没装 = github::unavailable_detail(github::Unavailable::NotInstalled);
    assert!(没装.contains("gh"), "{没装}");
    assert!(没装.contains("设置与环境"), "没说去哪儿看怎么装：{没装}");

    let 没登录 = github::unavailable_detail(github::Unavailable::NotLoggedIn);
    assert!(没登录.contains("gh auth login"), "没给出登录命令：{没登录}");
}

#[test]
fn 网络类的失败要说清是网络_并且可重试() {
    // 实际撞到的原话：
    // `Get "https://api.github.com/user/repos?…": EOF`
    // 照搬给用户等于什么都没说 —— 他要知道的是「这不是你配错了，再试一次」
    let (话, 提示, 可重试) =
        github::describe_gh_failure(r#"Get "https://api.github.com/user/repos": EOF"#);

    assert!(话.contains("网络"), "{话}");
    assert!(提示.is_some_and(|h| h.contains("重试")), "没说下一步怎么办");
    assert!(可重试, "网络抖一下就永久失败的话，用户只能关掉重开");
}

#[test]
fn 认不出的失败原样转述_不瞎猜() {
    // 编不出一个「可能是什么」比照搬原文更糟：用户会照着一个
    // 我们臆想的方向去查
    let (话, _, _) = github::describe_gh_failure("HTTP 403: Resource not accessible");
    assert!(话.contains("403"), "{话}");
}

#[test]
fn 仓库全名要挡住不像仓库的东西() {
    // 这个值会被拼进 `gh api repos/{repo}/branches`。
    // 不挡的话，一个带 `../` 或空格的值就能把请求打到别的路径上去
    assert!(github::valid_repo("owner/name"));
    assert!(github::valid_repo("BDBGAME2024/hall-for-live"));
    assert!(github::valid_repo("a/b.c_d-e"));

    for 坏的 in [
        "owner",
        "owner/name/extra",
        "../../etc",
        "owner/../x",
        "owner /name",
        "",
        "owner/",
        "/name",
        "owner/na?me",
    ] {
        assert!(!github::valid_repo(坏的), "{坏的} 不该被放行");
    }
}
