//! 启动表单的仓库与分支下拉。
//!
//! 都走本机已登录的 `gh` —— 这个应用不自己管 GitHub 的登录态：
//! 那意味着要存一个 token，而「Secret 只进 Keychain」之外还得再加一整套
//! 授权、刷新与吊销。`gh` 已经把这件事做完了，问它就是。
//!
//! **只读**：两条命令都是 GET，没有任何写路径。

use serde::Serialize;

use crate::{ApiError, ApiResult};

/// 一个可选的仓库。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDto {
    /// `owner/name` —— git 与 gh 都认的那个标识。
    pub full_name: String,
    pub default_branch: String,
    /// 组织仓库。界面上分组显示，个人的和组织的混在一起很难找。
    pub is_org: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoListDto {
    pub items: Vec<RepoDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchListDto {
    pub items: Vec<String>,
    pub default_branch: String,
}

/// gh 用不了的两种情形。它们的下一步动作完全不同，所以分开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    NotLoggedIn,
}

/// gh 用不了时说什么。
///
/// 「失败了」三个字没有信息量 —— 用户要知道的是「装 gh」还是「登录」。
#[must_use]
pub fn unavailable_detail(why: Unavailable) -> String {
    match why {
        Unavailable::NotInstalled => "找不到 gh（GitHub CLI）。在「设置与环境」里能看到怎么装；\
             装好之前这个字段可以直接手填 owner/name"
            .to_string(),
        Unavailable::NotLoggedIn => "gh 还没登录。在终端里跑一遍 `gh auth login`，回来点刷新；\
             或者直接手填 owner/name"
            .to_string(),
    }
}

/// gh 报的错怎么向用户转述：`(说法, 下一步, 可不可以重试)`。
///
/// gh 的原话是给命令行看的 ——
/// `Get "https://api.github.com/user/repos?…": EOF` 照搬给用户，
/// 他既不知道这是不是自己配错了，也不知道该干什么。
/// 而这一类**多半只是代理切了个节点**，重试一次就好。
#[must_use]
pub fn describe_gh_failure(stderr: &str) -> (String, Option<String>, bool) {
    let raw = stderr.trim();
    let looks_network = ["EOF", "timeout", "connection", "no such host", "TLS", "i/o"]
        .iter()
        .any(|word| raw.to_lowercase().contains(&word.to_lowercase()));

    if looks_network {
        return (
            format!("连不上 GitHub（网络或代理的问题）：{raw}"),
            Some("多半是代理切了节点。点「重试」；一直不行就在终端里跑一遍 `gh api /user/repos` 看看".to_string()),
            true,
        );
    }

    // 认不出就原样转述。编一个「可能是什么」比照搬更糟 ——
    // 用户会照着我们臆想的方向去查
    (format!("gh 报错：{raw}"), None, false)
}

/// `owner/name`，两段，每段只允许 GitHub 真正会用的那几类字符。
///
/// 这个值会被拼进 `gh api repos/{repo}/branches`。不挡的话，
/// 一个带 `../` 的值就能把请求打到别的路径上去。
#[must_use]
pub fn valid_repo(repo: &str) -> bool {
    let mut part = repo.split('/');
    let (Some(owner), Some(name), None) = (part.next(), part.next(), part.next()) else {
        return false;
    };
    let valid = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    valid(owner) && valid(name)
}

/// 解析 `gh api /user/repos` 的输出。
///
/// 字段名照 GitHub REST 的原样。少认一个 `owner.type`，组织仓库就会和
/// 个人仓库混在一列里 —— 而用户往往有几十个。
pub fn parse_repos(json: &str) -> ApiResult<Vec<RepoDto>> {
    let arr: serde_json::Value = serde_json::from_str(json).map_err(|error| ApiError {
        code: "INTERNAL".to_string(),
        message: format!("gh 的输出不是 JSON：{error}"),
        retriable: true,
        hint: Some("确认 `gh api /user/repos` 在终端里跑得通".to_string()),
    })?;

    let Some(entries) = arr.as_array() else {
        return Err(ApiError {
            code: "INTERNAL".to_string(),
            message: "gh 返回的不是仓库数组".to_string(),
            retriable: true,
            hint: None,
        });
    };

    Ok(entries
        .iter()
        .filter_map(|item| {
            // 权限受限的条目字段会残缺。因为一条坏数据就让整个下拉打不开的话，
            // 用户连能选的那些都看不到
            Some(RepoDto {
                full_name: item.get("full_name")?.as_str()?.to_string(),
                default_branch: item
                    .get("default_branch")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("main")
                    .to_string(),
                is_org: item
                    .get("owner")
                    .and_then(|o| o.get("type"))
                    .and_then(serde_json::Value::as_str)
                    == Some("Organization"),
            })
        })
        .collect())
}

/// 默认分支排最前。
///
/// 十几个分支里翻 `main` 很烦，而它恰恰是最常选的那个。
/// 它不在列表里时也补上 —— 分页只取了前 N 条时会这样，
/// 少了它用户就选不到默认分支了。
#[must_use]
pub fn order_branches(branches: Vec<String>, default_branch: &str) -> Vec<String> {
    let mut rest: Vec<String> = branches
        .into_iter()
        .filter(|name| name != default_branch)
        .collect();
    let mut result = vec![default_branch.to_string()];
    result.append(&mut rest);
    result
}

/// 列出当前 gh 账号有权限的仓库。
///
/// `affiliation` 三档都要：只给 owner 的话，用户在组织里天天用的那些
/// 一个都不会出现 —— 而那往往正是他要跑工作流的地方。
/// `sort=pushed` 让最近动过的排前面，比字母序有用得多。
pub fn repos(query: Option<String>, limit: Option<i64>) -> ApiResult<RepoListDto> {
    let per_page = limit.unwrap_or(100).clamp(1, 200);
    // 只要第一页。加 `--paginate` 的话，一个有几百个仓库的账号
    // 每次打开启动表单都要等十几个来回 —— 而 sort=pushed 已经把
    // 最近动过的排在最前，真正会选的就在这一页里
    let out = run_gh(&[
        "api",
        &format!(
            "/user/repos?affiliation=owner,collaborator,organization_member\
             &sort=pushed&per_page={per_page}"
        ),
    ])?;

    let mut repo = parse_repos(&out)?;
    if let Some(word) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let word = word.to_lowercase();
        repo.retain(|repo| repo.full_name.to_lowercase().contains(&word));
    }
    repo.truncate(usize::try_from(per_page).unwrap_or(100));

    Ok(RepoListDto { items: repo })
}

/// 列出一个仓库的分支。
pub fn branches(repo: String) -> ApiResult<BranchListDto> {
    if !valid_repo(&repo) {
        return Err(ApiError {
            code: "VALIDATION".to_string(),
            message: format!("{repo} 不是一个仓库全名"),
            retriable: false,
            hint: Some("形如 owner/name".to_string()),
        });
    }

    // 默认分支单独问一次：分支接口不告诉你哪个是默认的，
    // 而那正是要预选的那个
    let repo_info = run_gh(&["api", &format!("repos/{repo}")])?;
    let default_branch = serde_json::from_str::<serde_json::Value>(&repo_info)
        .ok()
        .and_then(|v| {
            v.get("default_branch")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "main".to_string());

    let out = run_gh(&[
        "api",
        "--paginate",
        &format!("repos/{repo}/branches?per_page=100"),
        "--jq",
        ".[].name",
    ])?;
    // --jq 出的是一行一个名字，不是 JSON 数组
    let name: Vec<String> = out
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    Ok(BranchListDto {
        items: order_branches(name, &default_branch),
        default_branch,
    })
}

/// 跑一条 gh 命令，把「没装」与「没登录」区分开。
///
/// 两者的下一步动作完全不同，合成一句「gh 用不了」等于什么都没说。
fn run_gh(args: &[&str]) -> ApiResult<String> {
    if aiwf_engine::tooling::which("gh").is_none() {
        return Err(ApiError {
            code: "EXTERNAL".to_string(),
            message: unavailable_detail(Unavailable::NotInstalled),
            retriable: false,
            hint: None,
        });
    }

    let out = aiwf_engine::tooling::command("gh")
        .args(args)
        .output()
        .map_err(|error| ApiError {
            code: "INTERNAL".to_string(),
            message: format!("起不来 gh：{error}"),
            retriable: true,
            hint: None,
        })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // gh 未登录时会在 stderr 里明说。认出来才能给对下一步
        if stderr.contains("gh auth login") || stderr.contains("not logged") {
            return Err(ApiError {
                code: "EXTERNAL".to_string(),
                message: unavailable_detail(Unavailable::NotLoggedIn),
                retriable: false,
                hint: None,
            });
        }

        let (message, hint, retriable) = describe_gh_failure(&stderr);
        return Err(ApiError {
            code: "EXTERNAL".to_string(),
            message,
            retriable,
            hint,
        });
    }

    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
