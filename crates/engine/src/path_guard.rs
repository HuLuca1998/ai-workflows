//! 路径守卫。
//!
//! 技术选型 §5：路径先 canonicalize 再判断是否位于授权根目录；拒绝根目录、Home、
//! 未解析变量与宽泛 glob；单独防护符号链接逃逸。
//!
//! 这里刻意不接受相对路径：Agent 的 cwd 由引擎决定，Prompt 不能改变安全边界，
//! 所以到达守卫的路径必须已经是引擎解析好的绝对路径。

use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum GuardError {
    #[error("路径为空")]
    Empty,
    #[error("{input} 不是绝对路径；工作目录由引擎决定，不接受相对路径")]
    NotAbsolute { input: String },
    #[error("{input} 含未解析的变量或家目录缩写，引擎不做二次求值")]
    Unresolved { input: String },
    #[error("{input} 是通配范围，权限过宽")]
    Overbroad { input: String },
    #[error("{path} 不能作为授权根：范围过大或属于系统目录")]
    ForbiddenRoot { path: String },
    #[error("{path} 位于全部授权根之外")]
    Escape { path: String },
    #[error("{path} 的父目录不存在")]
    ParentMissing { path: String },
    #[error("读取路径失败：{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, GuardError>;

/// 绝不允许整体授权的目录。比较在 canonicalize 之后进行
/// （macOS 上 `/var` 会解析成 `/private/var`，字符串比较会漏）。
const FORBIDDEN_ROOTS: &[&str] = &[
    "/",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/opt",
    "/var",
    "/tmp",
    "/System",
    "/Library",
    "/Applications",
    "/Users",
    "/Volumes",
    "/private",
];

/// 授权根至少要有这么多路径分量，挡住 `/Users` 这种一层就覆盖所有人的目录。
const MIN_ROOT_DEPTH: usize = 2;

#[derive(Debug, Clone)]
pub struct PathGuard {
    roots: Vec<PathBuf>,
}

impl PathGuard {
    /// 建立守卫。每个授权根都要先过一遍合法性检查——错误的根比错误的路径更危险。
    pub fn new(roots: Vec<PathBuf>) -> Result<Self> {
        let mut checked = Vec::with_capacity(roots.len());
        for root in roots {
            checked.push(validate_root(&root)?);
        }
        Ok(Self { roots: checked })
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// 解析并校验一个路径。返回 canonicalize 之后的真实路径。
    ///
    /// 允许指向尚不存在的文件（要新建），但它的父目录必须已经存在且在授权根内，
    /// 避免一次写入就造出一整条深层目录。
    pub fn resolve(&self, input: &str) -> Result<PathBuf> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(GuardError::Empty);
        }
        // 未解析的变量与 ~ 一律拒绝：引擎不做二次求值，否则 Prompt 就能构造路径
        if trimmed.contains('$') || trimmed.starts_with('~') {
            return Err(GuardError::Unresolved {
                input: trimmed.to_string(),
            });
        }
        if trimmed.contains('*') || trimmed.contains('?') || trimmed.contains('[') {
            return Err(GuardError::Overbroad {
                input: trimmed.to_string(),
            });
        }
        if !Path::new(trimmed).is_absolute() {
            return Err(GuardError::NotAbsolute {
                input: trimmed.to_string(),
            });
        }

        // 先消掉 `.` 与 `..`：`a/../../etc/passwd` 是逃逸，不是「父目录不存在」。
        let lexical = lexical_normalize(Path::new(trimmed));

        // 再从「最近一个真实存在的祖先」开始 canonicalize，把剩余部分拼回去。
        // 这样三件事一次做完：符号链接按真实目标判断、尚未创建的新文件也能校验、
        // /var → /private/var 这类系统软链不会造成误判。
        let (anchor, rest) = nearest_existing_ancestor(&lexical);
        let real_anchor = anchor.canonicalize()?;
        let real = real_anchor.join(&rest);

        if !self.roots.iter().any(|root| is_within(&real, root)) {
            return Err(GuardError::Escape {
                path: real.to_string_lossy().into_owned(),
            });
        }

        // 允许新建文件，但不允许顺带造出一整条深层目录
        if rest.components().count() > 1 {
            return Err(GuardError::ParentMissing {
                path: real.to_string_lossy().into_owned(),
            });
        }

        Ok(real)
    }

    /// 只判断不返回路径，供 UI 做即时提示。
    pub fn is_allowed(&self, input: &str) -> bool {
        self.resolve(input).is_ok()
    }
}

fn validate_root(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute() {
        return Err(GuardError::ForbiddenRoot {
            path: root.to_string_lossy().into_owned(),
        });
    }
    let real = root.canonicalize().map_err(|_| GuardError::ForbiddenRoot {
        path: root.to_string_lossy().into_owned(),
    })?;

    for forbidden in FORBIDDEN_ROOTS {
        let candidate = Path::new(forbidden);
        let canonical = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.to_path_buf());
        if real == canonical || real == candidate {
            return Err(GuardError::ForbiddenRoot {
                path: real.to_string_lossy().into_owned(),
            });
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_path = Path::new(&home);
        let canonical_home = home_path
            .canonicalize()
            .unwrap_or_else(|_| home_path.to_path_buf());
        if real == canonical_home {
            return Err(GuardError::ForbiddenRoot {
                path: real.to_string_lossy().into_owned(),
            });
        }
    }

    if depth(&real) < MIN_ROOT_DEPTH {
        return Err(GuardError::ForbiddenRoot {
            path: real.to_string_lossy().into_owned(),
        });
    }

    Ok(real)
}

/// 纯词法归一化：消掉 `.` 与 `..`，不访问文件系统。
/// 只解决「路径写法」层面的越界；符号链接层面的越界交给 canonicalize。
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 从路径末端往上找第一个真实存在的祖先，返回它与尚不存在的剩余部分。
fn nearest_existing_ancestor(path: &Path) -> (PathBuf, PathBuf) {
    let mut anchor = path.to_path_buf();
    let mut rest = PathBuf::new();

    while !anchor.exists() {
        let Some(name) = anchor.file_name().map(|n| n.to_os_string()) else {
            break;
        };
        rest = if rest.as_os_str().is_empty() {
            PathBuf::from(&name)
        } else {
            PathBuf::from(&name).join(&rest)
        };
        if !anchor.pop() {
            break;
        }
    }

    (anchor, rest)
}

fn depth(path: &Path) -> usize {
    path.components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count()
}

/// 按路径分量比较，而不是字符串前缀：`/tmp/work-evil` 不算在 `/tmp/work` 之内。
fn is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 分量比较不会把同前缀的兄弟目录算进来() {
        assert!(is_within(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(!is_within(Path::new("/a/b-evil/c"), Path::new("/a/b")));
        assert!(is_within(Path::new("/a/b"), Path::new("/a/b")));
    }

    #[test]
    fn 深度只数普通分量() {
        assert_eq!(depth(Path::new("/")), 0);
        assert_eq!(depth(Path::new("/etc")), 1);
        assert_eq!(depth(Path::new("/Users/luca")), 2);
    }
}
