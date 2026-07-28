//! MCP 的端口与访问令牌。
//!
//! **单独一个文件，不进 `workspace_setting` 表。**
//! 那张表会被诊断包导出、也会显示在界面上 —— 令牌进了那里
//! 就等于随每一份诊断包一起发出去，而这个令牌等于这台机器上
//! 这个应用的全部能力。
//!
//! 令牌只生成一次并持久化：每次启动换一个的话，昨天写进
//! Claude Code / Codex 配置里的那份今天就失效了，而用户看到的是
//! 「工具突然全没了」。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub port: u16,
    pub token: String,
}

/// 配置文件的位置。
#[must_use]
pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp.json")
}

/// 读，读不到就建一份。
///
/// # Errors
/// 目录建不出来或写不进去时返回 Err —— 那时 MCP 起不来，
/// 调用方要把原因说给用户，而不是让「一键接入」按钮静默无效。
pub fn load_or_create(data_dir: &Path) -> Result<McpConfig, String> {
    let file = path(data_dir);

    // 文件坏了就重建，而不是让整个应用起不来 ——
    // 一个手滑写坏的 JSON 不该是「应用打不开」的原因
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(config) = serde_json::from_str::<McpConfig>(&text) {
            if !config.token.is_empty() && config.port > 0 {
                return Ok(config);
            }
        }
    }

    let token = crate::http::generate_token();
    if token.is_empty() {
        return Err("拿不到随机数来生成 MCP 令牌，这台机器上没有 /dev/urandom".to_string());
    }

    let config = McpConfig {
        port: crate::http::DEFAULT_PORT,
        token,
    };
    save(data_dir, &config)?;
    Ok(config)
}

/// 写回。端口在启动时可能被换掉（默认端口被占），要存下来 ——
/// 不存的话客户端配置里那个地址下次就指错了。
///
/// # Errors
/// 写不进去时返回 Err。
pub fn save(data_dir: &Path, config: &McpConfig) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("建不出目录 {}：{error}", data_dir.display()))?;

    let file = path(data_dir);
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化 MCP 配置失败：{error}"))?;
    std::fs::write(&file, text).map_err(|error| format!("写不进 {}：{error}", file.display()))?;

    // 0600：同机器上的别的用户读得到的话，鉴权就白做了。
    // 先写后改权限有一瞬间的窗口，但换成「先建再写」在跨平台上更麻烦，
    // 而这个窗口只存在于首次创建的那几微秒
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}
