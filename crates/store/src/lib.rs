//! SQLite 访问层。
//!
//! 本地优先：工作流、运行记录、事件、记忆都留在本机。写入串行化到单个 writer
//! （`Store` 不是 `Sync`，引擎侧用单独的 writer 任务持有它），读取可另开连接。
//!
//! 设计约束来自技术选型 §10：
//! * WAL 模式 + 外键约束常开；
//! * `(run_id, seq)` 唯一，事件流不允许出现重复或空洞；
//! * 大 payload 落 artifacts/，事件只留摘要与引用。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

mod migrations;

pub use migrations::EXPECTED_SCHEMA_VERSION;

/// 事件摘要上限，与 `@aiwf/contracts` 的 `EVENT_SUMMARY_MAX` 保持一致。
pub const EVENT_SUMMARY_MAX: usize = 2000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("数据库错误：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("数据不合法：{0}")]
    Invalid(String),
    #[error("找不到 {kind} {id}")]
    NotFound { kind: &'static str, id: String },
    /// 草稿已被别处改过。对应契约里的 REVISION_CONFLICT，
    /// 带上当前 rev 让调用方能直接重新读取而不必再查一次。
    #[error("草稿已变化：基础版本 {base}，当前 rev {current}")]
    RevisionConflict { base: i64, current: i64 },
}

pub type Result<T> = std::result::Result<T, StoreError>;

// ── 行结构 ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WorkflowRow {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
}

#[derive(Debug, Clone)]
pub struct PublishedVersion {
    pub id: String,
    pub version: i64,
    pub config_hash: String,
}

/// 版本元数据（不含图本体）。
#[derive(Debug, Clone)]
pub struct VersionMeta {
    pub id: String,
    pub version: i64,
    pub config_hash: String,
    pub published_at: String,
    pub published_by: String,
}

#[derive(Debug, Clone)]
pub struct VersionRow {
    pub id: String,
    pub workflow_id: String,
    pub version: i64,
    pub graph_json: String,
    pub config_hash: String,
    pub published_at: String,
    pub published_by: String,
}

/// 待写入的事件。`seq` 由存储分配，调用方不指定——这是事件流连续性的保证。
#[derive(Debug, Clone)]
pub struct NewRunEvent {
    pub run_id: String,
    /// 对应契约里的 `RunEventType`，如 `node.started`。
    pub kind: String,
    pub node_id: Option<String>,
    pub attempt: Option<i64>,
    pub actor: String,
    pub status: Option<String>,
    pub summary: String,
    pub payload_ref: Option<String>,
    pub artifact_refs: Vec<String>,
    pub parent_event_id: Option<String>,
    pub sensitivity: String,
    pub schema_ver: i64,
}

#[derive(Debug, Clone)]
pub struct AppendedEvent {
    pub id: String,
    pub seq: i64,
}

#[derive(Debug, Clone)]
pub struct RunEventRow {
    pub id: String,
    pub run_id: String,
    pub seq: i64,
    pub ts: String,
    pub kind: String,
    pub node_id: Option<String>,
    pub attempt: Option<i64>,
    pub actor: String,
    pub summary: String,
    pub payload_ref: Option<String>,
    pub sensitivity: String,
}

/// 登记一个模型。
///
/// 「ACP 握手只返回协议能力与 session modes，不返回可用模型」——
/// 所以模型必须在这里手工登记或从 CLI 配置导入。
pub struct NewModel {
    pub name: String,
    pub runtime: String,
    pub model_id: String,
    pub effort: String,
    pub context_window: i64,
    pub capabilities: Vec<String>,
    /// 只接受 `keychain://` 引用。明文密钥在这一层就被拒绝。
    pub credential_ref: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct ModelRow {
    pub id: String,
    pub name: String,
    pub runtime: String,
    pub model_id: String,
    pub effort: String,
    pub context_window: i64,
    pub capabilities: Vec<String>,
    pub credential_ref: Option<String>,
    pub enabled: bool,
    pub last_latency_ms: Option<i64>,
}

fn map_model_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelRow> {
    let caps: String = row.get(6)?;
    Ok(ModelRow {
        id: row.get(0)?,
        name: row.get(1)?,
        runtime: row.get(2)?,
        model_id: row.get(3)?,
        effort: row.get(4)?,
        context_window: row.get(5)?,
        capabilities: serde_json::from_str(&caps).unwrap_or_default(),
        credential_ref: row.get(7)?,
        enabled: row.get::<_, i64>(8)? != 0,
        last_latency_ms: row.get(9)?,
    })
}

/// 一次运行，带上工作流名。
#[derive(Debug, Clone)]
pub struct RunRow {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub version_id: Option<String>,
    pub draft_rev: Option<i64>,
    pub status: String,
    pub inputs_json: String,
    pub current_node: Option<String>,
    pub workdir: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

fn map_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: row.get(0)?,
        workflow_id: row.get(1)?,
        workflow_name: row.get(2)?,
        version_id: row.get(3)?,
        draft_rev: row.get(4)?,
        status: row.get(5)?,
        inputs_json: row.get(6)?,
        current_node: row.get(7)?,
        workdir: row.get(8)?,
        started_at: row.get(9)?,
        ended_at: row.get(10)?,
    })
}

#[derive(Debug, Clone)]
pub struct CheckpointRow {
    pub run_id: String,
    pub seq: i64,
    pub env_json: String,
    pub pending_approval_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct MemoryRow {
    pub id: String,
    pub scope: String,
    pub scope_id: Option<String>,
    pub key: String,
    pub value: String,
    pub ver: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub kind: String,
    pub ref_id: String,
    pub text: String,
}

// ── Store ───────────────────────────────────────────────────────────────────

pub struct Store {
    conn: Connection,
}

impl Store {
    /// 打开（或创建）落盘库，并把 schema 迁移到当前版本。
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::bootstrap(conn, true)
    }

    /// 内存库：测试与 Dry Run 用。
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::bootstrap(conn, false)
    }

    fn bootstrap(conn: Connection, wal: bool) -> Result<Self> {
        if wal {
            // WAL 让读不阻塞写；busy_timeout 兜住偶发的写冲突
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
        }
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        let store = Self { conn };
        migrations::migrate(&store.conn)?;
        Ok(store)
    }

    pub fn schema_version(&self) -> Result<i64> {
        migrations::current_version(&self.conn)
    }

    /// 读 PRAGMA 并统一成字符串（有的返回文本如 `wal`，有的返回整数如 `1`）。
    pub fn pragma_string(&self, name: &str) -> Result<String> {
        let value: rusqlite::types::Value =
            self.conn
                .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))?;
        let text = match value {
            rusqlite::types::Value::Text(s) => s,
            rusqlite::types::Value::Integer(i) => i.to_string(),
            rusqlite::types::Value::Real(f) => f.to_string(),
            other => format!("{other:?}"),
        };
        Ok(text.to_lowercase())
    }

    pub fn table_exists(&self, name: &str) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            params![name],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // ── 工作流 ──────────────────────────────────────────────────────────────

    /// 创建工作流，并附带一份 rev 0 的草稿——画布打开即可编辑。
    pub fn create_workflow(&self, name: &str, folder: Option<&str>) -> Result<String> {
        self.create_workflow_with_graph(name, folder, EMPTY_GRAPH)
    }

    /// 带初始图创建。模板与导入走这里：它们不是「相对于某个版本的改动」，
    /// 没有结构化操作可记，硬凑一条假 Patch 会污染审计。
    pub fn create_workflow_with_graph(
        &self,
        name: &str,
        folder: Option<&str>,
        graph_json: &str,
    ) -> Result<String> {
        let id = new_id("wf");
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO workflow(id, name, folder, created_at, updated_at, archived)
             VALUES (?1, ?2, ?3, ?4, ?4, 0)",
            params![id, name, folder, now],
        )?;
        self.conn.execute(
            "INSERT INTO workflow_revision(workflow_id, rev, graph_json, updated_at)
             VALUES (?1, 0, ?2, ?3)",
            params![id, graph_json, now],
        )?;
        self.index_text("workflow", &id, name)?;
        Ok(id)
    }

    pub fn get_workflow(&self, id: &str) -> Result<Option<WorkflowRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, name, folder, created_at, updated_at, archived FROM workflow WHERE id = ?1",
                params![id],
                map_workflow,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_workflows(&self) -> Result<Vec<WorkflowRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, folder, created_at, updated_at, archived
             FROM workflow ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], map_workflow)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_workflow(&self, id: &str) -> Result<()> {
        let affected = self
            .conn
            .execute("DELETE FROM workflow WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(StoreError::NotFound {
                kind: "工作流",
                id: id.to_string(),
            });
        }
        Ok(())
    }

    pub fn draft_revision(&self, workflow_id: &str) -> Result<Option<i64>> {
        let rev = self
            .conn
            .query_row(
                "SELECT MAX(rev) FROM workflow_revision WHERE workflow_id = ?1",
                params![workflow_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();
        Ok(rev)
    }

    /// 保存新草稿，返回新的 rev。rev 单调递增，不复用。
    pub fn save_draft(&self, workflow_id: &str, graph_json: &str) -> Result<i64> {
        let current = self
            .draft_revision(workflow_id)?
            .ok_or(StoreError::NotFound {
                kind: "工作流",
                id: workflow_id.to_string(),
            })?;
        let next = current + 1;
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO workflow_revision(workflow_id, rev, graph_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![workflow_id, next, graph_json, now],
        )?;
        self.conn.execute(
            "UPDATE workflow SET updated_at = ?2 WHERE id = ?1",
            params![workflow_id, now],
        )?;
        Ok(next)
    }

    pub fn get_draft(&self, workflow_id: &str, rev: i64) -> Result<Option<String>> {
        let graph = self
            .conn
            .query_row(
                "SELECT graph_json FROM workflow_revision WHERE workflow_id = ?1 AND rev = ?2",
                params![workflow_id, rev],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(graph)
    }

    /// 带版本守卫的草稿写入。
    ///
    /// `base_rev` 是调用方读到的修订号；与当前不符就拒绝，绝不悄悄覆盖别人的改动。
    /// 这是契约里 `workflow.patch` 的落地点：结构化 Patch 由调用方在客户端应用
    /// 并生成 Diff（`@aiwf/contracts` 的 applyPatch），落库时写整份图 ——
    /// 存储本来就以整图为单位，而版本守卫必须在这一侧做才对并发安全。
    pub fn save_draft_guarded(
        &self,
        workflow_id: &str,
        base_rev: i64,
        graph_json: &str,
    ) -> Result<i64> {
        let current = self
            .draft_revision(workflow_id)?
            .ok_or(StoreError::NotFound {
                kind: "工作流",
                id: workflow_id.to_string(),
            })?;
        if current != base_rev {
            return Err(StoreError::RevisionConflict {
                base: base_rev,
                current,
            });
        }
        self.save_draft(workflow_id, graph_json)
    }

    /// 某个工作流的全部已发布版本，最新在前（版本抽屉按这个顺序渲染）。
    /// 不含 graph_json：列表页不需要，避免把几份完整图一起读出来。
    pub fn list_versions(&self, workflow_id: &str) -> Result<Vec<VersionMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, version, config_hash, published_at, published_by
             FROM workflow_version WHERE workflow_id = ?1 ORDER BY version DESC",
        )?;
        let rows = stmt.query_map(params![workflow_id], |row| {
            Ok(VersionMeta {
                id: row.get(0)?,
                version: row.get(1)?,
                config_hash: row.get(2)?,
                published_at: row.get(3)?,
                published_by: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// 把某个草稿修订发布成不可变版本快照。
    pub fn publish(&self, workflow_id: &str, rev: i64, by: &str) -> Result<PublishedVersion> {
        let graph = self
            .get_draft(workflow_id, rev)?
            .ok_or(StoreError::NotFound {
                kind: "草稿修订",
                id: format!("{workflow_id}@{rev}"),
            })?;

        let next_version: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM workflow_version WHERE workflow_id = ?1",
            params![workflow_id],
            |row| row.get(0),
        )?;

        let id = new_id("wv");
        let config_hash = hash_hex(&graph);
        self.conn.execute(
            "INSERT INTO workflow_version(id, workflow_id, version, graph_json, config_hash, published_at, published_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, workflow_id, next_version, graph, config_hash, now_iso(), by],
        )?;

        Ok(PublishedVersion {
            id,
            version: next_version,
            config_hash,
        })
    }

    pub fn get_version(&self, version_id: &str) -> Result<Option<VersionRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, workflow_id, version, graph_json, config_hash, published_at, published_by
                 FROM workflow_version WHERE id = ?1",
                params![version_id],
                |row| {
                    Ok(VersionRow {
                        id: row.get(0)?,
                        workflow_id: row.get(1)?,
                        version: row.get(2)?,
                        graph_json: row.get(3)?,
                        config_hash: row.get(4)?,
                        published_at: row.get(5)?,
                        published_by: row.get(6)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    // ── 运行与事件 ──────────────────────────────────────────────────────────

    pub fn create_run(
        &self,
        workflow_id: &str,
        version_id: Option<&str>,
        draft_rev: Option<i64>,
        inputs_json: &str,
    ) -> Result<String> {
        self.create_run_in(workflow_id, version_id, draft_rev, inputs_json, None)
    }

    /// 带工作目录的建 Run。并行运行靠不同的工作目录互不干扰。
    pub fn create_run_in(
        &self,
        workflow_id: &str,
        version_id: Option<&str>,
        draft_rev: Option<i64>,
        inputs_json: &str,
        workdir: Option<&str>,
    ) -> Result<String> {
        let id = new_id("run");
        self.conn.execute(
            "INSERT INTO run(id, workflow_id, version_id, draft_rev, status, inputs_json, workdir, started_at)
             VALUES (?1, ?2, ?3, ?4, 'created', ?5, ?6, ?7)",
            params![
                id,
                workflow_id,
                version_id,
                draft_rev,
                inputs_json,
                workdir,
                now_iso()
            ],
        )?;
        Ok(id)
    }

    /// 读取 Run 的当前状态。
    pub fn run_status(&self, run_id: &str) -> Result<Option<String>> {
        let status = self
            .conn
            .query_row(
                "SELECT status FROM run WHERE id = ?1",
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(status)
    }

    /// 更新 Run 状态与当前节点。状态机的合法性由引擎侧保证。
    pub fn set_run_status(
        &self,
        run_id: &str,
        status: &str,
        current_node: Option<&str>,
    ) -> Result<()> {
        let ended = matches!(status, "succeeded" | "failed" | "cancelled").then(now_iso);
        self.conn.execute(
            "UPDATE run SET status = ?2, current_node = ?3, ended_at = COALESCE(?4, ended_at)
             WHERE id = ?1",
            params![run_id, status, current_node, ended],
        )?;
        Ok(())
    }

    /// 运行详情，带上工作流名 —— 列表与详情都要显示它，
    /// 让调用方再查一次 workflow 表既慢又容易忘。
    pub fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT r.id, r.workflow_id, w.name, r.version_id, r.draft_rev, r.status,
                        r.inputs_json, r.current_node, r.workdir, r.started_at, r.ended_at
                 FROM run r JOIN workflow w ON w.id = r.workflow_id
                 WHERE r.id = ?1",
                params![run_id],
                map_run_row,
            )
            .optional()?;
        Ok(row)
    }

    /// 列出运行。最新的在最前 —— 执行记录页第一眼要看到刚跑的那个。
    ///
    /// 三个筛选条件是「与」的关系，对应图纸左栏的搜索框 + 筛选 chips。
    pub fn list_runs(
        &self,
        workflow_id: Option<&str>,
        statuses: &[String],
        query: Option<&str>,
    ) -> Result<Vec<RunRow>> {
        // 状态是可变长度的 IN 列表，只能拼进 SQL；值本身来自枚举，
        // 但仍然只拼占位符，绝不把内容拼进语句
        let status_clause = if statuses.is_empty() {
            String::new()
        } else {
            let holes = vec!["?"; statuses.len()].join(",");
            format!(" AND r.status IN ({holes})")
        };

        let sql = format!(
            "SELECT r.id, r.workflow_id, w.name, r.version_id, r.draft_rev, r.status,
                    r.inputs_json, r.current_node, r.workdir, r.started_at, r.ended_at
             FROM run r JOIN workflow w ON w.id = r.workflow_id
             WHERE (?1 IS NULL OR r.workflow_id = ?1)
               AND (?2 IS NULL OR r.id LIKE ?2 OR w.name LIKE ?2 OR r.inputs_json LIKE ?2)
               {status_clause}
             ORDER BY r.started_at DESC, r.rowid DESC"
        );

        let like = query.map(|q| format!("%{q}%"));
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&workflow_id, &like];
        for status in statuses {
            params.push(status);
        }

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params.as_slice(), map_run_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // ── 模型登记 ─────────────────────────────────────────────────────────

    pub fn create_model(&self, model: &NewModel) -> Result<String> {
        validate_credential_ref(model.credential_ref.as_deref())?;
        validate_runtime(&model.runtime)?;
        if model.context_window <= 0 {
            return Err(StoreError::Invalid("上下文窗口必须是正数".to_string()));
        }

        let id = new_id("model");
        let caps = serde_json::to_string(&model.capabilities)
            .map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO model(id, name, runtime, model_id, effort, ctx, caps_json, cred_ref, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                model.name,
                model.runtime,
                model.model_id,
                model.effort,
                model.context_window,
                caps,
                model.credential_ref,
                i64::from(model.enabled),
            ],
        )?;
        Ok(id)
    }

    pub fn get_model(&self, id: &str) -> Result<Option<ModelRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, name, runtime, model_id, effort, ctx, caps_json, cred_ref, enabled, last_latency_ms
                 FROM model WHERE id = ?1",
                params![id],
                map_model_row,
            )
            .optional()?;
        Ok(row)
    }

    /// 列出模型。`enabled_only` 对应「所有模型下拉只列出已启用的条目」。
    ///
    /// 按 runtime 再按名字排序：图纸左栏按接入方式分组，
    /// 顺序跳来跳去会让人找不到刚建的那条。
    pub fn list_models(&self, enabled_only: bool) -> Result<Vec<ModelRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, runtime, model_id, effort, ctx, caps_json, cred_ref, enabled, last_latency_ms
             FROM model
             WHERE (?1 = 0 OR enabled = 1)
             ORDER BY runtime ASC, name ASC",
        )?;
        let rows = stmt.query_map(params![i64::from(enabled_only)], map_model_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 部分更新。没传的字段保持原样 —— 传 None 当成「清空」会让
    /// 界面上改个名字就把凭据引用弄丢。
    #[allow(clippy::too_many_arguments)]
    pub fn update_model(
        &self,
        id: &str,
        name: Option<&str>,
        runtime: Option<&str>,
        model_id: Option<&str>,
        effort: Option<&str>,
        context_window: Option<i64>,
        capabilities: Option<&[String]>,
        enabled: Option<bool>,
    ) -> Result<()> {
        let caps = capabilities
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| StoreError::Invalid(e.to_string()))?;

        self.conn.execute(
            "UPDATE model SET
                name     = COALESCE(?2, name),
                runtime  = COALESCE(?3, runtime),
                model_id = COALESCE(?4, model_id),
                effort   = COALESCE(?5, effort),
                ctx      = COALESCE(?6, ctx),
                caps_json = COALESCE(?7, caps_json),
                enabled  = COALESCE(?8, enabled)
             WHERE id = ?1",
            params![
                id,
                name,
                runtime,
                model_id,
                effort,
                context_window,
                caps,
                enabled.map(i64::from),
            ],
        )?;
        Ok(())
    }

    /// 单独更新凭据引用。与其他字段分开，是为了让「改凭据」在审计里独立可见。
    pub fn set_model_credential(&self, id: &str, credential_ref: Option<&str>) -> Result<()> {
        validate_credential_ref(credential_ref)?;
        self.conn.execute(
            "UPDATE model SET cred_ref = ?2 WHERE id = ?1",
            params![id, credential_ref],
        )?;
        Ok(())
    }

    pub fn record_model_latency(&self, id: &str, latency_ms: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE model SET last_latency_ms = ?2 WHERE id = ?1",
            params![id, latency_ms],
        )?;
        Ok(())
    }

    pub fn delete_model(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM model WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Run 的启动参数 JSON。
    pub fn run_inputs(&self, run_id: &str) -> Result<Option<String>> {
        let inputs = self
            .conn
            .query_row(
                "SELECT inputs_json FROM run WHERE id = ?1",
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(inputs)
    }

    /// Run 的工作目录。
    pub fn run_workdir(&self, run_id: &str) -> Result<Option<String>> {
        let dir = self
            .conn
            .query_row(
                "SELECT workdir FROM run WHERE id = ?1",
                params![run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(dir)
    }

    /// 节点推进带来的状态变化。**不会覆盖终态**。
    ///
    /// 与 [`Store::set_run_status`] 的区别在于意图：那个是「用户或调度器
    /// 明确要求把状态改成这个」（取消、恢复），这个是「执行到这一步了」。
    /// 后者必须让位于前者 —— 否则取消运行时，执行线程会把 cancelled
    /// 覆盖回 running，运行就再也停不下来。
    pub fn advance_run_status(
        &self,
        run_id: &str,
        status: &str,
        current_node: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE run SET status = ?2, current_node = ?3
             WHERE id = ?1 AND status NOT IN ('succeeded', 'failed', 'cancelled')",
            params![run_id, status, current_node],
        )?;
        Ok(())
    }

    /// Run 引用的图：优先用已发布版本，其次用草稿修订。
    pub fn run_graph(&self, run_id: &str) -> Result<Option<String>> {
        let row: Option<(Option<String>, Option<i64>, String)> = self
            .conn
            .query_row(
                "SELECT version_id, draft_rev, workflow_id FROM run WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        let Some((version_id, draft_rev, workflow_id)) = row else {
            return Ok(None);
        };

        if let Some(version_id) = version_id {
            return Ok(self.get_version(&version_id)?.map(|v| v.graph_json));
        }
        let rev = draft_rev.unwrap_or(0);
        self.get_draft(&workflow_id, rev)
    }

    /// 测试脚手架：建一个最小可用的 Run。生产代码请用 [`Store::create_run`]。
    #[doc(hidden)]
    pub fn create_run_for_test(&self, workflow_id: &str) -> Result<String> {
        self.create_run(workflow_id, None, Some(0), "{}")
    }

    /// 追加事件。seq 在写入前分配，保证同一 run 内连续且不重复。
    pub fn append_event(&self, event: &NewRunEvent) -> Result<AppendedEvent> {
        if event.summary.chars().count() > EVENT_SUMMARY_MAX {
            return Err(StoreError::Invalid(format!(
                "摘要超过 {EVENT_SUMMARY_MAX} 字符，请落 artifact 后用 payload_ref 引用"
            )));
        }

        let id = new_id("ev");
        let refs = serde_json::to_string(&event.artifact_refs).unwrap_or_else(|_| "[]".to_string());

        // seq 在 INSERT 语句内部算。
        //
        // 分成「SELECT MAX(seq)+1」+「INSERT」两步的话，两个连接会在这中间
        // 拿到同一个值，第二条撞 UNIQUE 约束——症状是「取消运行时偶尔报数据库错误」，
        // 因为那正是主线程与执行线程同时写事件的时刻。
        // 单条语句由 SQLite 的写锁串行化，是原子的。
        let next_seq: i64 = self.conn.query_row(
            "INSERT INTO run_event(id, run_id, seq, ts, type, node_id, attempt, actor, status,
                                   summary, payload_ref, artifact_refs, parent_event_id,
                                   sensitivity, schema_ver)
             VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_event WHERE run_id = ?2),
                     ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             RETURNING seq",
            params![
                id,
                event.run_id,
                now_iso(),
                event.kind,
                event.node_id,
                event.attempt,
                event.actor,
                event.status,
                event.summary,
                event.payload_ref,
                refs,
                event.parent_event_id,
                event.sensitivity,
                event.schema_ver,
            ],
            |row| row.get(0),
        )?;
        self.index_text("run_event", &id, &event.summary)?;

        Ok(AppendedEvent { id, seq: next_seq })
    }

    /// 测试脚手架：绕过 seq 分配直接插入，用来验证唯一约束确实生效。
    #[doc(hidden)]
    pub fn force_insert_event_seq(&self, run_id: &str, seq: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO run_event(id, run_id, seq, ts, type, actor, summary)
             VALUES (?1, ?2, ?3, ?4, 'system.audit', 'system', '强制插入')",
            params![new_id("ev"), run_id, seq, now_iso()],
        )?;
        Ok(())
    }

    /// 游标分页：返回 seq 大于 `from_seq` 的最多 `limit` 条事件。
    pub fn events(&self, run_id: &str, from_seq: i64, limit: i64) -> Result<Vec<RunEventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, seq, ts, type, node_id, attempt, actor, summary, payload_ref, sensitivity
             FROM run_event WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![run_id, from_seq, limit], |row| {
            Ok(RunEventRow {
                id: row.get(0)?,
                run_id: row.get(1)?,
                seq: row.get(2)?,
                ts: row.get(3)?,
                kind: row.get(4)?,
                node_id: row.get(5)?,
                attempt: row.get(6)?,
                actor: row.get(7)?,
                summary: row.get(8)?,
                payload_ref: row.get(9)?,
                sensitivity: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn save_checkpoint(
        &self,
        run_id: &str,
        seq: i64,
        env_json: &str,
        pending_approval_json: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO run_checkpoint(run_id, seq, env_json, pending_approval_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(run_id, seq) DO UPDATE SET
               env_json = excluded.env_json,
               pending_approval_json = excluded.pending_approval_json,
               created_at = excluded.created_at",
            params![run_id, seq, env_json, pending_approval_json, now_iso()],
        )?;
        Ok(())
    }

    /// 恢复时取最新一条检查点。
    pub fn latest_checkpoint(&self, run_id: &str) -> Result<Option<CheckpointRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT run_id, seq, env_json, pending_approval_json, created_at
                 FROM run_checkpoint WHERE run_id = ?1 ORDER BY seq DESC LIMIT 1",
                params![run_id],
                |row| {
                    Ok(CheckpointRow {
                        run_id: row.get(0)?,
                        seq: row.get(1)?,
                        env_json: row.get(2)?,
                        pending_approval_json: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    // ── 记忆 ────────────────────────────────────────────────────────────────

    /// 同一作用域内 key 唯一：重复写入是更新并递增版本，不是新增。
    pub fn upsert_memory(
        &self,
        scope: &str,
        scope_id: Option<&str>,
        key: &str,
        value: &str,
    ) -> Result<String> {
        let now = now_iso();
        let existing: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT id, ver FROM memory
                 WHERE scope = ?1 AND IFNULL(scope_id, '') = IFNULL(?2, '') AND key = ?3",
                params![scope, scope_id, key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        match existing {
            Some((id, ver)) => {
                self.conn.execute(
                    "UPDATE memory SET value = ?2, ver = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, value, ver + 1, now],
                )?;
                Ok(id)
            }
            None => {
                let id = new_id("mem");
                self.conn.execute(
                    "INSERT INTO memory(id, scope, scope_id, key, value, created_at, updated_at, ver)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1)",
                    params![id, scope, scope_id, key, value, now],
                )?;
                Ok(id)
            }
        }
    }

    pub fn list_memory(&self, scope: &str, scope_id: Option<&str>) -> Result<Vec<MemoryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, scope_id, key, value, ver, updated_at FROM memory
             WHERE scope = ?1 AND IFNULL(scope_id, '') = IFNULL(?2, '') AND enabled = 1
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![scope, scope_id], |row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                scope: row.get(1)?,
                scope_id: row.get(2)?,
                key: row.get(3)?,
                value: row.get(4)?,
                ver: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ── 全文检索 ────────────────────────────────────────────────────────────

    fn index_text(&self, kind: &str, ref_id: &str, text: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO fts_index(kind, ref_id, text) VALUES (?1, ?2, ?3)",
            params![kind, ref_id, segment_cjk(text)],
        )?;
        Ok(())
    }

    /// 全文检索事件摘要、工作流名称与产物路径。
    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        let prepared = segment_cjk(query).replace('"', " ");
        if prepared.trim().is_empty() {
            return Ok(vec![]);
        }
        // 整体作为短语匹配：既避免 FTS5 语法注入，也让分字后的中文按相邻顺序命中
        let phrase = format!("\"{}\"", prepared.trim());

        let mut stmt = self.conn.prepare(
            "SELECT kind, ref_id, text FROM fts_index WHERE fts_index MATCH ?1 LIMIT 50",
        )?;
        let rows = stmt.query_map(params![phrase], |row| {
            Ok(SearchHit {
                kind: row.get(0)?,
                ref_id: row.get(1)?,
                text: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

const EMPTY_GRAPH: &str = r#"{"nodes":[],"edges":[],"groups":[]}"#;

fn map_workflow(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRow> {
    Ok(WorkflowRow {
        id: row.get(0)?,
        name: row.get(1)?,
        folder: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        archived: row.get::<_, i64>(5)? != 0,
    })
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// ISO-8601（UTC，毫秒精度）。为一个时间戳不值得引入 chrono。
fn now_iso() -> String {
    let millis = unix_millis();
    let secs = (millis / 1000) as i64;
    let ms = (millis % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Howard Hinnant 的 civil_from_days：把 UNIX 天数换成年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 本地 id：纳秒时间戳混入单调计数器。本地单机场景足够，不引入 uuid 依赖。
fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed = nanos ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{prefix}_{mixed:016x}")
}

fn hash_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// SQLite 内置分词器不切中文：把 CJK 字符按字拆开，让「归因」能命中「错误日志归因」。
fn segment_cjk(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut last_was_cjk = false;
    for ch in text.chars() {
        let is_cjk = matches!(ch as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF);
        if is_cjk {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push(ch);
            last_was_cjk = true;
        } else {
            if last_was_cjk && !ch.is_whitespace() {
                out.push(' ');
            }
            out.push(ch);
            last_was_cjk = false;
        }
    }
    out
}

/// 契约里的接入方式枚举（`AGENT_RUNTIMES`）。
///
/// Rust 侧留一份镜像，是为了让绕过界面的调用路径（MCP、脚本、HTTP 桥接）
/// 同样写不进脏数据。contract_sync_test 守住它不脱离契约。
pub const AGENT_RUNTIMES: &[&str] = &["acp.claude", "acp.codex", "provider.api"];

fn validate_runtime(runtime: &str) -> Result<()> {
    if AGENT_RUNTIMES.contains(&runtime) {
        return Ok(());
    }
    Err(StoreError::Invalid(format!(
        "不认识的接入方式 {runtime}。可选：{}",
        AGENT_RUNTIMES.join(" / ")
    )))
}

/// 凭据只能是引用。
///
/// 明文密钥一旦落库，就会跟着数据库备份、导出包、诊断包到处走 ——
/// 而这些地方都不该有密钥。在写入这一层拒绝，比在界面上提醒可靠。
fn validate_credential_ref(reference: Option<&str>) -> Result<()> {
    let Some(reference) = reference else {
        return Ok(());
    };
    if reference.is_empty() || reference.starts_with("keychain://") {
        return Ok(());
    }
    Err(StoreError::Invalid(format!(
        "凭据必须是 keychain:// 引用，收到的是 {}。密钥请存进钥匙串后引用它",
        mask(reference)
    )))
}

/// 报错时也不能把收到的密钥原样打出来 —— 错误信息会进日志。
fn mask(secret: &str) -> String {
    let head: String = secret.chars().take(4).collect();
    format!("{head}…（已遮蔽，共 {} 字符）", secret.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 中文按字拆分_英文保持原样() {
        assert_eq!(segment_cjk("错误日志归因"), "错 误 日 志 归 因");
        assert_eq!(segment_cjk("unexpected end"), "unexpected end");
        assert_eq!(segment_cjk("修复 issue #548"), "修 复 issue #548");
    }

    #[test]
    fn 相同输入产生相同配置哈希() {
        assert_eq!(hash_hex("{}"), hash_hex("{}"));
        assert_ne!(hash_hex("{}"), hash_hex(r#"{"a":1}"#));
        assert_eq!(hash_hex("{}").len(), 64);
    }

    #[test]
    fn 生成的_id_带前缀且不重复() {
        let a = new_id("wf");
        let b = new_id("wf");
        assert!(a.starts_with("wf_"));
        assert_ne!(a, b);
    }

    #[test]
    fn 时间戳是_iso8601_格式() {
        let ts = now_iso();
        assert_eq!(ts.len(), 24, "形如 2026-07-27T04:00:00.000Z，实际 {ts}");
        assert!(ts.ends_with('Z'));
    }
}
