//! 产物存储。
//!
//! 技术选型：大 payload 落 artifacts/，事件只留摘要与引用。
//! 一条 200KB 的脚本输出塞进事件表，会让整个事件流的查询都变慢 ——
//! 而事件流是执行记录页每秒都在读的东西。
//!
//! 每个产物的落点由**引擎**决定，文件名只用来生成一个安全的叶子名：
//! 直接拿调用方给的名字拼路径，一个带 `../../` 的名字就能写到用户主目录去。

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
    #[error("产物文件名不能为空")]
    EmptyName,
    #[error("路径不在产物目录内：{path}")]
    OutsideRoot { path: String },
    #[error("{path} 是符号链接，产物目录里不接受")]
    SymlinkInPath { path: String },
    #[error("文件系统错误：{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ArtifactError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    Diff,
    Report,
    Log,
    Json,
    Binary,
}

impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Diff => "diff",
            Self::Report => "report",
            Self::Log => "log",
            Self::Json => "json",
            Self::Binary => "binary",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SavedArtifact {
    pub run_id: String,
    pub node_id: String,
    pub kind: String,
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

pub struct ArtifactStore {
    root: PathBuf,
}

impl ArtifactStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 写一个产物。落点是 `<root>/<run_id>/<node_id>/<安全名>`。
    ///
    /// 按运行与节点分目录，同一次运行里两个节点都写 `output.log` 才不会互相覆盖。
    pub fn save(
        &self,
        run_id: &str,
        node_id: &str,
        kind: ArtifactKind,
        name: &str,
        content: &[u8],
    ) -> Result<SavedArtifact> {
        let leaf = safe_leaf(name)?;
        let dir = self
            .root
            .join(safe_segment(run_id)?)
            .join(safe_segment(node_id)?);
        std::fs::create_dir_all(&dir)?;

        // 目录链上任何一段是符号链接，写入就会落到别处 ——
        // 而放这个链接的人可能就是上一次运行的脚本
        reject_symlinks(&self.root, &dir)?;

        let path = dir.join(&leaf);
        if path.symlink_metadata().is_ok_and(|meta| meta.is_symlink()) {
            return Err(ArtifactError::SymlinkInPath {
                path: path.display().to_string(),
            });
        }
        std::fs::write(&path, content)?;

        Ok(SavedArtifact {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            kind: kind.as_str().to_string(),
            name: leaf,
            path,
            bytes: content.len() as u64,
            sha256: hex(Sha256::digest(content).as_slice()),
        })
    }

    /// 列出一次运行的全部产物。运行没有产物时返回空，不是错误。
    pub fn list(&self, run_id: &str) -> Result<Vec<SavedArtifact>> {
        let run_dir = self.root.join(safe_segment(run_id)?);
        if !run_dir.is_dir() {
            return Ok(vec![]);
        }
        // 顺着链接列目录会把外面的文件当成这次运行的产物
        reject_symlinks(&self.root, &run_dir)?;

        let mut items = Vec::new();
        for node_entry in std::fs::read_dir(&run_dir)? {
            let node_entry = node_entry?;
            if !node_entry.file_type()?.is_dir() {
                continue;
            }
            let node_id = node_entry.file_name().to_string_lossy().into_owned();

            for file in std::fs::read_dir(node_entry.path())? {
                let file = file?;
                if !file.file_type()?.is_file() {
                    continue;
                }
                let path = file.path();
                let content = std::fs::read(&path)?;
                let name = file.file_name().to_string_lossy().into_owned();
                items.push(SavedArtifact {
                    run_id: run_id.to_string(),
                    node_id: node_id.clone(),
                    kind: kind_from_name(&name).as_str().to_string(),
                    name,
                    bytes: content.len() as u64,
                    sha256: hex(Sha256::digest(&content).as_slice()),
                    path,
                });
            }
        }
        // 顺序稳定：目录遍历的顺序由文件系统决定，界面上会跳来跳去
        items.sort_by(|a, b| (&a.node_id, &a.name).cmp(&(&b.node_id, &b.name)));
        Ok(items)
    }

    /// 预览产物开头的一段。
    ///
    /// 带上限是因为「导出诊断包」和「预览」是两件事：预览要快，
    /// 把一个 300MB 的日志读进内存只会让界面卡住。
    pub fn preview(&self, path: &Path, limit: usize) -> Result<Preview> {
        // 界面传来的路径不能无条件相信。
        // 根目录还不存在时，任何路径都不可能在它里面——这也是「拒绝」，
        // 不是 IO 错误：报「找不到文件」会把注意力引向错误的方向
        let outside = || ArtifactError::OutsideRoot {
            path: path.display().to_string(),
        };
        let canonical_root = std::fs::canonicalize(&self.root).map_err(|_| outside())?;
        let canonical = std::fs::canonicalize(path)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(outside());
        }

        let mut file = std::fs::File::open(&canonical)?;
        let mut buffer = vec![0u8; limit];
        let read = read_full(&mut file, &mut buffer)?;
        buffer.truncate(read);

        // 还能再读出一个字节就说明后面还有内容
        let mut probe = [0u8; 1];
        let truncated = file.read(&mut probe)? > 0;

        Ok(Preview {
            text: String::from_utf8_lossy(&buffer).into_owned(),
            truncated,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
}

/// 只取文件名部分，并去掉路径分隔符。
fn safe_leaf(name: &str) -> Result<String> {
    let leaf = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    safe_segment(&leaf)
}

/// 一段目录名。危险字符不是「过滤掉」而是**换成安全占位**。
///
/// 过滤会让 `a/b` 和 `ab` 变成同一个名字，两个节点的日志互相覆盖。
/// 换成 `-` 至少保证不同的输入得到不同的名字。
/// `.` 与 `..` 直接拒绝：它们会把路径带出这次运行的目录。
fn safe_segment(segment: &str) -> Result<String> {
    let replaced: String = segment
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | '\0') {
                '-'
            } else {
                c
            }
        })
        .collect();

    if replaced.is_empty() || replaced == "." || replaced == ".." {
        return Err(ArtifactError::EmptyName);
    }
    Ok(replaced)
}

/// 从 root 到 target 的每一段都不能是符号链接。
///
/// 只检查最终文件不够：中间任何一层被换成链接，写入都会落到别处。
fn reject_symlinks(root: &Path, target: &Path) -> Result<()> {
    let Ok(relative) = target.strip_prefix(root) else {
        return Err(ArtifactError::OutsideRoot {
            path: target.display().to_string(),
        });
    };

    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if current
            .symlink_metadata()
            .is_ok_and(|meta| meta.is_symlink())
        {
            return Err(ArtifactError::SymlinkInPath {
                path: current.display().to_string(),
            });
        }
    }
    Ok(())
}

fn kind_from_name(name: &str) -> ArtifactKind {
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some("patch" | "diff") => ArtifactKind::Diff,
        Some("md") => ArtifactKind::Report,
        Some("json") => ArtifactKind::Json,
        Some("log" | "txt") => ArtifactKind::Log,
        _ => ArtifactKind::Binary,
    }
}

fn read_full(file: &mut std::fs::File, buffer: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
