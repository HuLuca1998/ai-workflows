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
mod sample;
mod seed;

pub use migrations::EXPECTED_SCHEMA_VERSION;

/// 测试脚手架：把一个库只迁到指定版本为止。
///
/// 「从旧 schema 向前迁」必须在**有数据**的库上验过 ——
/// 而从空库直上最新版那条路径永远碰不到「已有行遇上新列」。
#[doc(hidden)]
pub fn migrate_to_for_test(path: &std::path::Path, target: i64) -> Result<()> {
    let conn = Connection::open(path)?;
    migrations::migrate_up_to(&conn, target)?;
    Ok(())
}

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

/// 终态：进了就不再变，也是「这次跑了多久」的截止点。
/// 与 `aiwf_engine::status::RunStatus::is_terminal` 是同一个集合 ——
/// store 不依赖 engine，所以由 core-api 的守卫测试压住两边一致。
const TERMINAL_RUN_STATUSES: [&str; 3] = ["succeeded", "failed", "cancelled"];

/// [`Store::update_agent`] 的部分更新。
///
/// `None` = 这个字段没改。全都摊成参数的话调用点是一串 `None, None, Some(x), None`，
/// 顺序错了编译器也看不出来 —— goal 和 persona 都是 `Option<&str>`。
#[derive(Debug, Default, Clone, Copy)]
pub struct AgentPatch<'a> {
    pub name: Option<&'a str>,
    pub goal: Option<&'a str>,
    pub persona: Option<&'a str>,
    pub model_ref: Option<&'a str>,
    /// 空串表示「不降级」——用 `None` 就与「没改」撞了。
    pub fallback_model_ref: Option<&'a str>,
    /// 能力声明（JSON）。引擎按它拦截，所以它必须可改 ——
    /// 只拦不让改的话，那条拦截就只会挡人、不会放行。
    pub capabilities_json: Option<&'a str>,
    /// 工具与 MCP 白名单。
    pub tools: Option<&'a [String]>,
    pub output_contract: Option<&'a str>,
}

// ── 行结构 ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WorkflowRow {
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    /// 最新发布版本号。没发布过时 None —— 首页据此显示「草稿」。
    pub latest_version: Option<i64>,
    pub last_run: Option<WorkflowLastRun>,
}

/// 首页列表行上那点运行态投影。
#[derive(Debug, Clone)]
pub struct WorkflowLastRun {
    pub id: String,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// 失败时停在哪个节点。图纸写的是「失败 · 节点 3」。
    pub failed_node: Option<String>,
    pub version: Option<i64>,
}

/// 主管 AI 的一次会话。
#[derive(Debug, Clone)]
pub struct SupervisorSessionRow {
    pub id: String,
    pub title: String,
    pub started_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub workflow_id: Option<String>,
    pub run_id: Option<String>,
    pub model_ref: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SupervisorMessageRow {
    pub role: String,
    pub text: String,
    pub at: String,
}

/// 首页四张统计卡的同一时刻快照。
#[derive(Debug, Clone, Default)]
pub struct WorkspaceStats {
    pub pending_approvals: i64,
    pub pending_approval_hint: Option<String>,
    pub runs_today: i64,
    pub runs_today_succeeded: i64,
    pub active_worktrees: i64,
    pub worktree_bytes: i64,
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
    /// 节点在**当时**的标题。草稿改名不影响已写下的运行记录。
    pub node_label: Option<String>,
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
    pub node_label: Option<String>,
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
/// 从 runtime 同步来的一个模型。
///
/// 只有两个字段：**值**（发给 agent 的那个）与**给人看的名字**。
/// 上下文窗口、能力清单、凭据都不在这里 —— 那三样是
/// `provider.api` 时代的遗留，ACP 下要么 agent 自己知道、
/// 要么语义两端对不上（见 `sync_models` 的注释）。
#[derive(Debug, Clone)]
pub struct SyncedModel {
    pub value: String,
    pub label: String,
}

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

/// 登记一个 Agent 角色。
///
/// 「节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效」——
/// 所以角色是一等实体，有自己的版本号。
pub struct NewAgent {
    pub name: String,
    pub role: String,
    pub goal: String,
    pub persona: String,
    pub runtime: String,
    pub model_ref: String,
    pub fallback_model_ref: Option<String>,
    pub tools: Vec<String>,
    /// 权限（引擎强制，Prompt 无法越权）。整体存一个 JSON：
    /// 拆成列会让「权限」这件事散落在七八个字段上，而它需要被整体校验。
    pub capabilities_json: String,
    pub output_contract: String,
    pub turn_limit: i64,
    pub timeout_ms: i64,
}

#[derive(Debug, Clone)]
pub struct AgentRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub goal: String,
    pub persona: String,
    pub runtime: String,
    pub model_ref: String,
    pub fallback_model_ref: Option<String>,
    pub tools: Vec<String>,
    pub capabilities_json: String,
    pub output_contract: String,
    pub turn_limit: i64,
    pub timeout_ms: i64,
    pub ver: i64,
    pub builtin: bool,
}

const AGENT_COLUMNS: &str = "id, name, role, goal, persona, runtime, model_ref,
     fallback_model_ref, tools_json, policy_json, output_contract,
     turn_limit, timeout_ms, ver, builtin";

fn map_agent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRow> {
    let tools: String = row.get(8)?;
    Ok(AgentRow {
        id: row.get(0)?,
        name: row.get(1)?,
        role: row.get(2)?,
        goal: row.get(3)?,
        persona: row.get(4)?,
        runtime: row.get(5)?,
        model_ref: row.get(6)?,
        fallback_model_ref: row.get(7)?,
        tools: serde_json::from_str(&tools).unwrap_or_default(),
        capabilities_json: row.get(9)?,
        output_contract: row.get(10)?,
        turn_limit: row.get(11)?,
        timeout_ms: row.get(12)?,
        ver: row.get(13)?,
        builtin: row.get::<_, i64>(14)? != 0,
    })
}

/// 写一条记忆。
///
/// 记忆会被注入后续每一次 AI 调用 —— 所以它既是长期上下文，
/// 也是一条**持续生效**的指令。这决定了几件事：
/// key 在作用域内唯一、更新要带版本号、内容不能有密钥。
pub struct NewMemory {
    pub scope: String,
    pub scope_id: Option<String>,
    pub key: String,
    pub value: String,
    pub summary: Option<String>,
    /// user / ai_proposed / system。AI 提议的默认不启用。
    pub source: String,
    pub created_by: String,
    pub sensitivity: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MemoryRow {
    pub id: String,
    pub scope: String,
    pub scope_id: Option<String>,
    pub key: String,
    pub value: String,
    pub summary: Option<String>,
    pub source: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
    pub sensitivity: String,
    pub ver: i64,
    pub tags: Vec<String>,
    pub enabled: bool,
}

const MEMORY_COLUMNS: &str = "id, scope, scope_id, key, value, summary, source, created_by,
     created_at, updated_at, expires_at, sensitivity, ver, tags_json, enabled";

fn map_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    let tags: String = row.get(13)?;
    Ok(MemoryRow {
        id: row.get(0)?,
        scope: row.get(1)?,
        scope_id: row.get(2)?,
        key: row.get(3)?,
        value: row.get(4)?,
        summary: row.get(5)?,
        source: row.get(6)?,
        created_by: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        expires_at: row.get(10)?,
        sensitivity: row.get(11)?,
        ver: row.get(12)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        enabled: row.get::<_, i64>(14)? != 0,
    })
}

/// 登记一条提示词。
///
/// 「系统调用 AI 的每一处都在这里：节点、⌘K 协作、记忆提议、通知与失败归因。」
/// 所以提示词是一等实体，有分组、有版本、有变量清单。
/// 提示词的一个历史版本。
#[derive(Debug, Clone)]
pub struct PromptVersionRow {
    pub ver: i64,
    pub name: String,
    pub sections_json: String,
    pub vars_json: String,
    /// 「你」还是「AI 提议」。
    pub changed_by: Option<String>,
    pub created_at: String,
}

pub struct NewPrompt {
    pub group: String,
    pub name: String,
    /// 框架分段：Role / Task / Context / Constraints / Output contract。
    /// 存 JSON 数组，因为分段是有序的且数量不定。
    pub sections_json: String,
    pub vars_json: String,
}

#[derive(Debug, Clone)]
pub struct PromptRow {
    pub id: String,
    pub group: String,
    pub name: String,
    pub sections_json: String,
    pub vars_json: String,
    pub ver: i64,
    pub builtin: bool,
    pub updated_at: String,
}

const PROMPT_COLUMNS: &str =
    "id, \"group\", name, sections_json, vars_json, ver, builtin, updated_at";

fn map_prompt_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptRow> {
    Ok(PromptRow {
        id: row.get(0)?,
        group: row.get(1)?,
        name: row.get(2)?,
        sections_json: row.get(3)?,
        vars_json: row.get(4)?,
        ver: row.get(5)?,
        builtin: row.get::<_, i64>(6)? != 0,
        updated_at: row.get(7)?,
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
        // 读出来时**再过一遍**。
        //
        // 写入时脱敏只对新数据有效，而用户看到的是读出来的东西 ——
        // 这个改动之前落库的运行仍是明文，照样会在列表里显示。
        // 在迁移里改历史数据不合适：那是不可逆的，而且规则一改就没法重来；
        // 读取时过一遍是幂等的，代价也只是一次字符串扫描。
        inputs_json: redact_inputs(&row.get::<_, String>(6)?),
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

    /// 打开一个**工作区**：迁移之外，再把随应用附带的内置数据种上。
    ///
    /// 与 [`Store::open`] 的区别是有意的：打开一个数据库与初始化一个工作区
    /// 是两件事。前者每个工作线程都要做（每人一条连接），后者一辈子只做一次。
    /// 应用入口走这一条，存储层自己的测试走 `open` ——
    /// 那些测试问的是分页与搜索，与「内置了什么」无关。
    ///
    /// 种过的批次记在 `bootstrap` 表里，不会重种：用户改过或删过的内置条目
    /// 不会在下次启动被冲回去。
    pub fn open_workspace(path: &Path) -> Result<Self> {
        let store = Self::open(path)?;
        seed::seed(&store.conn)?;
        Ok(store)
    }

    /// 一键初始化：把库清空重来 —— 迁移重跑一遍，内置数据重新种上。
    ///
    /// **刻意不删数据库文件。** 同一个库上不止这一条连接：系统 MCP 有自己的，
    /// 主管 AI 有自己的。删文件之后它们各自握着一个已经不存在的 inode，
    /// 读写都还「成功」，只是写进了一个没人看得到的地方 —— 这种坏法
    /// 要等到用户发现「MCP 那边改的东西界面上没有」才会暴露。
    /// 在同一条连接上 DROP 再重建，其余连接下一次查询看到的就是新表。
    ///
    /// `bootstrap` 表跟着一起 DROP：它记的是「这批种过没有」，
    /// 留着的话重种那一步会被跳过，重置出来是个没有内置数据的空库。
    ///
    /// 整件事在一个事务里。中途失败就回滚 —— 宁可什么都没变，
    /// 也不能停在「表删了一半」上，那种库连启动都启动不了。
    pub fn reset_workspace(&mut self) -> Result<()> {
        // 外键**必须在事务外**关掉。表之间互相 REFERENCES，开着外键
        // 按任何顺序 DROP 都会在 COMMIT 那一刻撞上「引用的表已经没了」。
        // 而 `defer_foreign_keys` 解决不了 —— 它只是把同一个检查推到
        // COMMIT，那时表全没了，照样报 no such table。
        // `foreign_keys` 这个 PRAGMA 在事务里是 no-op（SQLite 明文规定），
        // 所以只能在 BEGIN 之前。
        self.conn.pragma_update(None, "foreign_keys", "OFF")?;
        let 结果 = self.清空重建();
        // 不管成没成都要开回来：漏掉的话一次失败的重置会让这条连接
        // 之后再也不检查外键，而它看起来完全正常
        self.conn.pragma_update(None, "foreign_keys", "ON")?;
        结果
    }

    fn 清空重建(&mut self) -> Result<()> {
        self.conn.execute_batch("BEGIN")?;
        let 删完了 = (|| -> Result<()> {
            for 表 in 用户表(&self.conn)? {
                // 表名来自 sqlite_master，不是外部输入；用引号包住
                // 是为了以后有人建出带保留字的表名时不至于突然报语法错
                self.conn
                    .execute_batch(&format!("DROP TABLE IF EXISTS \"{表}\""))?;
            }
            Ok(())
        })();

        match 删完了 {
            Ok(()) => self.conn.execute_batch("COMMIT")?,
            Err(error) => {
                self.conn.execute_batch("ROLLBACK")?;
                return Err(error);
            }
        }

        // 建表与种数据各自带事务，放在上面那个事务外面 ——
        // migrate 自己会 BEGIN，嵌套会报错
        migrations::migrate(&self.conn)?;
        seed::seed(&self.conn)?;
        Ok(())
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
                map_workflow_bare,
            )
            .optional()?;
        Ok(row)
    }

    /// 列出工作流的一页，同时给出总数。
    ///
    /// 一次全返回的话，1292 条工作流会让浏览器建出上千个 DOM 节点，
    /// 而用户真正关心的那几条淹在里面。
    ///
    /// 排序必须是**全序**：只按 updated_at 排的话，同一毫秒更新的几条
    /// 在两次查询间顺序可能不同 —— 翻页会看到重复的条目，
    /// 而另一些永远看不到。所以补一个 rowid 兜底。
    pub fn list_workflows_paged(&self, limit: i64, offset: i64) -> Result<(Vec<WorkflowRow>, i64)> {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM workflow", [], |row| row.get(0))?;

        let mut stmt = self.conn.prepare(
            "SELECT w.id, w.name, w.folder, w.created_at, w.updated_at, w.archived,
                    (SELECT MAX(version) FROM workflow_version WHERE workflow_id = w.id),
                    r.id, r.status, r.started_at, r.ended_at, r.current_node,
                    (SELECT version FROM workflow_version WHERE id = r.version_id)
             FROM workflow w
             LEFT JOIN run r ON r.id = (
                 SELECT id FROM run WHERE workflow_id = w.id ORDER BY rowid DESC LIMIT 1
             )
             ORDER BY w.updated_at DESC, w.rowid DESC
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], map_workflow)?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
    }

    /// 带筛选与搜索的列表。
    ///
    /// 筛选必须在**后端**做：分页之后前端过滤只能过滤当前页 ——
    /// 用户停在第 29 页点「失败」，看到的是「这 50 条里恰好失败的那些」，
    /// 而不是全部失败的运行。
    ///
    /// `status` 取值与首页的四个 chip 对应：
    /// - `running` —— 最近一次运行还没结束（含等待审批）
    /// - `failed` —— 最近一次运行失败了
    /// - `draft` —— 从没发布过版本
    pub fn list_workflows_filtered(
        &self,
        status: Option<&str>,
        query: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<WorkflowRow>, i64)> {
        // 最近一次运行的状态：与 list_workflows_paged 用同一个子查询，
        // 两处对「最近」的定义必须一致，否则筛选出来的和列表显示的对不上
        const LAST_RUN: &str =
            "(SELECT status FROM run WHERE workflow_id = w.id ORDER BY rowid DESC LIMIT 1)";

        let status_clause = match status {
            Some("running") => format!(
                " AND {LAST_RUN} IN ('created','queued','running','waiting_approval','resuming')"
            ),
            Some("failed") => format!(" AND {LAST_RUN} = 'failed'"),
            Some("draft") => {
                " AND NOT EXISTS (SELECT 1 FROM workflow_version WHERE workflow_id = w.id)"
                    .to_string()
            }
            _ => String::new(),
        };

        let like = query.map(|q| format!("%{q}%"));
        let where_clause = format!("WHERE (?1 IS NULL OR w.name LIKE ?1){status_clause}");

        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM workflow w {where_clause}"),
            params![like],
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT w.id, w.name, w.folder, w.created_at, w.updated_at, w.archived,
                    (SELECT MAX(version) FROM workflow_version WHERE workflow_id = w.id),
                    r.id, r.status, r.started_at, r.ended_at, r.current_node,
                    (SELECT version FROM workflow_version WHERE id = r.version_id)
             FROM workflow w
             LEFT JOIN run r ON r.id = (
                 SELECT id FROM run WHERE workflow_id = w.id ORDER BY rowid DESC LIMIT 1
             )
             {where_clause}
             ORDER BY w.updated_at DESC, w.rowid DESC
             LIMIT ?2 OFFSET ?3"
        );

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![like, limit, offset], map_workflow)?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
    }

    /// 列出工作流，**带最近一次运行**。
    ///
    /// 用关联子查询而不是「先列工作流、再逐条查运行」：后者在 300 条的
    /// 真实库上就是 301 次查询，首页会肉眼可见地卡。子查询按 rowid 取最新，
    /// 因为 started_at 可能为 NULL（刚建还没开始）也可能同秒撞上。
    pub fn list_workflows(&self) -> Result<Vec<WorkflowRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT w.id, w.name, w.folder, w.created_at, w.updated_at, w.archived,
                    (SELECT MAX(version) FROM workflow_version WHERE workflow_id = w.id),
                    r.id, r.status, r.started_at, r.ended_at, r.current_node,
                    (SELECT version FROM workflow_version WHERE id = r.version_id)
             FROM workflow w
             LEFT JOIN run r ON r.id = (
                 SELECT id FROM run WHERE workflow_id = w.id ORDER BY rowid DESC LIMIT 1
             )
             ORDER BY w.updated_at DESC",
        )?;
        let rows = stmt.query_map([], map_workflow)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// 首页四张统计卡。
    ///
    /// 一次取齐是有意的：分四次查会出现「等待审批 1，但今日运行 0」
    /// 这种自相矛盾的组合 —— 它们本就该是同一时刻的快照。
    ///
    /// worktree 的两项由调用方补 —— 那要走文件系统，不属于存储层。
    pub fn workspace_stats(&self) -> Result<WorkspaceStats> {
        let (pending, hint) = self
            .conn
            .query_row(
                "SELECT COUNT(*),
                        (SELECT w.name FROM run r2 JOIN workflow w ON w.id = r2.workflow_id
                         WHERE r2.status = 'waiting_approval' ORDER BY r2.rowid DESC LIMIT 1)
                 FROM run WHERE status = 'waiting_approval'",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .unwrap_or((0, None));

        // 「今日」按**本地**日期算：started_at 存的是 UTC，直接比 UTC 日期的话
        // 东八区用户在早上 8 点前看到的全是昨天的数。
        // 转换交给 SQLite 的 'localtime' —— 它读系统时区，
        // 比在 Rust 里自己推偏移少一个依赖也少一类错。
        // started_at 为 NULL 的（建了还没开始）自然被 date() 排除
        let (runs_today, succeeded) = self
            .conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(status = 'succeeded'), 0)
                 FROM run
                 WHERE date(started_at, 'localtime') = date('now', 'localtime')",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0));

        Ok(WorkspaceStats {
            pending_approvals: pending,
            pending_approval_hint: hint,
            runs_today,
            runs_today_succeeded: succeeded,
            active_worktrees: 0,
            worktree_bytes: 0,
        })
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

    // ── 主管 AI 的会话（M4）─────────────────────────────────────────────────

    /// 新开一条会话。
    ///
    /// 标题取第一个问题的前几十字 —— 用户靠它认出「上次那条」。
    /// 关联对象可空：不在任何上下文里问的问题也是一次会话。
    pub fn create_supervisor_session(
        &self,
        title: &str,
        workflow_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<String> {
        let id = new_id("sess");
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO supervisor_session(id, title, started_at, updated_at, workflow_id, run_id)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![id, truncate_title(title), now, workflow_id, run_id],
        )?;
        Ok(id)
    }

    /// 追加一条消息，并把会话的 updated_at 推到现在。
    ///
    /// seq 在 INSERT 内部算 —— 与 run_event 同一个理由：
    /// 分成两步的话并发写会撞 UNIQUE。
    pub fn append_supervisor_message(
        &self,
        session_id: &str,
        role: &str,
        text: &str,
    ) -> Result<()> {
        if !matches!(role, "user" | "agent") {
            return Err(StoreError::Invalid(format!(
                "消息角色只能是 user 或 agent，收到 {role}"
            )));
        }

        let now = now_iso();
        self.conn.execute(
            "INSERT INTO supervisor_message(id, session_id, role, text, at, seq)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     (SELECT COALESCE(MAX(seq), 0) + 1
                      FROM supervisor_message WHERE session_id = ?2))",
            params![new_id("msg"), session_id, role, text, now],
        )?;
        self.conn.execute(
            "UPDATE supervisor_session SET updated_at = ?2 WHERE id = ?1",
            params![session_id, now],
        )?;
        Ok(())
    }

    /// 列出会话，最近更新的排最前 —— 用户找的是「刚才那条」。
    pub fn list_supervisor_sessions(&self, limit: i64) -> Result<Vec<SupervisorSessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.title, s.started_at, s.updated_at,
                    (SELECT COUNT(*) FROM supervisor_message WHERE session_id = s.id),
                    s.workflow_id, s.run_id, s.model_ref
             FROM supervisor_session s
             ORDER BY s.updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], map_supervisor_session)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// 读一个会话的元信息与全部消息。找不到返回 None。
    pub fn supervisor_session(
        &self,
        session_id: &str,
    ) -> Result<Option<(SupervisorSessionRow, Vec<SupervisorMessageRow>)>> {
        let meta = self
            .conn
            .query_row(
                "SELECT s.id, s.title, s.started_at, s.updated_at,
                        (SELECT COUNT(*) FROM supervisor_message WHERE session_id = s.id),
                        s.workflow_id, s.run_id, s.model_ref
                 FROM supervisor_session s WHERE s.id = ?1",
                params![session_id],
                map_supervisor_session,
            )
            .optional()?;

        let Some(meta) = meta else {
            return Ok(None);
        };

        // 按 seq 排而不是按 at：同一秒内写两条时按时间排的顺序不稳定，
        // 而对话读起来颠倒就完全没法理解
        let mut stmt = self.conn.prepare(
            "SELECT role, text, at FROM supervisor_message
             WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let messages = stmt
            .query_map(params![session_id], |row| {
                Ok(SupervisorMessageRow {
                    role: row.get(0)?,
                    text: row.get(1)?,
                    at: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(Some((meta, messages)))
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

        // 参数在**写入时**脱敏。只在某个视图上遮掉的话，
        // 换个接口（列表、搜索、导出、MCP）就又漏出去了 ——
        // 而那正是被发现的方式：详情页写着「Secret 已脱敏」，
        // 运行列表却把完整的 sk-proj- 显示出来。
        //
        // 代价是引擎也拿不到明文了。这是有意的：真要用密钥就走
        // keychain:// 引用，那条路径原样保留
        let inputs_json = redact_inputs(inputs_json);

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

    /// 列出运行的一页，同时给出总数。
    ///
    /// total 是**筛选之后**的数：不然分页控件会画出翻不到的页。
    pub fn list_runs_paged(
        &self,
        workflow_id: Option<&str>,
        statuses: &[String],
        query: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<RunRow>, i64)> {
        let status_clause = if statuses.is_empty() {
            String::new()
        } else {
            let holes = vec!["?"; statuses.len()].join(",");
            format!(" AND r.status IN ({holes})")
        };

        let where_clause = format!(
            "WHERE (?1 IS NULL OR r.workflow_id = ?1)
               AND (?2 IS NULL OR r.id LIKE ?2 OR w.name LIKE ?2 OR r.inputs_json LIKE ?2)
               {status_clause}"
        );

        let like = query.map(|q| format!("%{q}%"));
        let mut count_params: Vec<&dyn rusqlite::ToSql> = vec![&workflow_id, &like];
        for status in statuses {
            count_params.push(status);
        }

        let total: i64 = self.conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM run r JOIN workflow w ON w.id = r.workflow_id {where_clause}"
            ),
            count_params.as_slice(),
            |row| row.get(0),
        )?;

        // started_at 可能为 NULL（刚建还没开始），rowid 保证全序
        let sql = format!(
            "SELECT r.id, r.workflow_id, w.name, r.version_id, r.draft_rev, r.status,
                    r.inputs_json, r.current_node, r.workdir, r.started_at, r.ended_at
             FROM run r JOIN workflow w ON w.id = r.workflow_id
             {where_clause}
             ORDER BY r.started_at DESC, r.rowid DESC
             LIMIT ?{} OFFSET ?{}",
            statuses.len() + 3,
            statuses.len() + 4
        );

        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&workflow_id, &like];
        for status in statuses {
            params.push(status);
        }
        params.push(&limit);
        params.push(&offset);

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params.as_slice(), map_run_row)?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
    }

    /// 丢弃一条**从没被用过**的空草稿，返回是否真的丢了。
    ///
    /// 点一次「新建工作流」就落一条持久草稿，只为了看看编辑器长什么样
    /// 也会留下垃圾 —— 真实库里已经有 82 条「从没跑过的未命名工作流」。
    ///
    /// 四条都满足才丢，任何一条不满足都说明用户是有意在建东西：
    /// - 名字还是「未命名工作流 N」（改过名 = 明确的「我要用它」）
    /// - 图里一个节点都没有
    /// - 没跑过（运行记录引用着它，丢掉会让记录指向不存在的东西）
    /// - 没发布过
    pub fn discard_if_empty(&self, id: &str) -> Result<bool> {
        let Some(row) = self.get_workflow(id)? else {
            // 离开编辑器时触发，那时它可能已经被别处删了
            return Ok(false);
        };

        if !row.name.starts_with("未命名工作流") {
            return Ok(false);
        }

        let used: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM run WHERE workflow_id = ?1)
                  + (SELECT COUNT(*) FROM workflow_version WHERE workflow_id = ?1)",
            params![id],
            |r| r.get(0),
        )?;
        if used > 0 {
            return Ok(false);
        }

        // 最新草稿里有没有节点。图是 JSON，这里只要判断空不空，
        // 完整解析没必要 —— 空图的 nodes 一定是 `"nodes":[]`
        let rev = self.draft_revision(id)?.unwrap_or(0);
        let has_nodes = self
            .get_draft(id, rev)?
            .map(|graph| !graph.replace(' ', "").contains("\"nodes\":[]"))
            .unwrap_or(false);
        if has_nodes {
            return Ok(false);
        }

        self.delete_workflow(id)?;
        Ok(true)
    }

    /// 给工作流改名。
    ///
    /// 新建时只能得到「未命名工作流 N」，没有改名入口的话列表很快
    /// 就全是这种名字 —— 用户操作级测试在真实库里发现了 300 多条。
    pub fn rename_workflow(&self, id: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid(
                "工作流名不能为空 —— 空名字在列表里就是一行看不见的东西".to_string(),
            ));
        }

        let changed = self.conn.execute(
            "UPDATE workflow SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_iso()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                kind: "工作流",
                id: id.to_string(),
            });
        }
        self.index_text("workflow", id, name)?;
        Ok(())
    }

    // ── 记忆 ─────────────────────────────────────────────────────────────

    pub fn create_memory(&self, memory: &NewMemory) -> Result<String> {
        reject_secret_like(&memory.value)?;

        // 同一作用域下 key 唯一：两条同 key 的记忆会让
        // 「注入哪一条」变成运气问题
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM memory
             WHERE scope = ?1 AND COALESCE(scope_id, '') = COALESCE(?2, '') AND key = ?3",
            params![memory.scope, memory.scope_id, memory.key],
            |row| row.get(0),
        )?;
        if exists > 0 {
            return Err(StoreError::Invalid(format!(
                "{} 作用域下已存在 key {}",
                memory.scope, memory.key
            )));
        }

        // AI 提议的默认不启用：「确认后才保存，并注入后续调用」
        let enabled = memory.source != "ai_proposed";

        let id = new_id("mem");
        let now = now_iso();
        let tags =
            serde_json::to_string(&memory.tags).map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO memory(id, scope, scope_id, key, value, summary, source, created_by,
                                created_at, updated_at, sensitivity, ver, tags_json, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, 1, ?11, ?12)",
            params![
                id,
                memory.scope,
                memory.scope_id,
                memory.key,
                memory.value,
                memory.summary,
                memory.source,
                memory.created_by,
                now,
                memory.sensitivity,
                tags,
                i64::from(enabled),
            ],
        )?;
        self.index_text("memory", &id, &format!("{} {}", memory.key, memory.value))?;
        Ok(id)
    }

    pub fn get_memory(&self, id: &str) -> Result<Option<MemoryRow>> {
        let sql = format!("SELECT {MEMORY_COLUMNS} FROM memory WHERE id = ?1");
        let row = self
            .conn
            .query_row(&sql, params![id], map_memory_row)
            .optional()?;
        Ok(row)
    }

    /// 列出记忆。`query` 同时匹配 key、内容与标签
    ///（图纸的搜索框写的是「搜索 key、内容或标签」）。
    pub fn list_memories(
        &self,
        scope: Option<&str>,
        query: Option<&str>,
    ) -> Result<Vec<MemoryRow>> {
        let sql = format!(
            "SELECT {MEMORY_COLUMNS} FROM memory
             WHERE (?1 IS NULL OR scope = ?1)
               AND (?2 IS NULL OR key LIKE ?2 OR value LIKE ?2 OR tags_json LIKE ?2)
             ORDER BY updated_at DESC"
        );
        let like = query.map(|q| format!("%{q}%"));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![scope, like], map_memory_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 列出记忆的一页，同时给出总数。
    pub fn list_memories_paged(
        &self,
        scope: Option<&str>,
        query: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<MemoryRow>, i64)> {
        let like = query.map(|q| format!("%{q}%"));
        let where_clause = "WHERE (?1 IS NULL OR scope = ?1)
               AND (?2 IS NULL OR key LIKE ?2 OR value LIKE ?2 OR tags_json LIKE ?2)";

        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM memory {where_clause}"),
            params![scope, like],
            |row| row.get(0),
        )?;

        let sql = format!(
            "SELECT {MEMORY_COLUMNS} FROM memory {where_clause}
             ORDER BY updated_at DESC, rowid DESC LIMIT ?3 OFFSET ?4"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![scope, like, limit, offset], map_memory_row)?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
    }

    /// 要注入到下一次 AI 调用里的记忆。
    ///
    /// 只取**启用且未过期**的。停用与过期的仍留在列表里 ——
    /// 用户要能看到它们并知道为什么不生效。
    pub fn memories_for_injection(
        &self,
        scope: &str,
        scope_id: Option<&str>,
    ) -> Result<Vec<MemoryRow>> {
        let sql = format!(
            "SELECT {MEMORY_COLUMNS} FROM memory
             WHERE scope = ?1
               AND COALESCE(scope_id, '') = COALESCE(?2, '')
               AND enabled = 1
               AND (expires_at IS NULL OR expires_at > ?3)
             ORDER BY updated_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![scope, scope_id, now_iso()], map_memory_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 更新记忆，**带乐观锁**。
    ///
    /// `base_ver` 与当前版本对不上就拒绝。没有这道锁，AI 通过 MCP 的写入
    /// 会悄悄覆盖用户刚改的内容 —— 而用户不会知道自己的修改没了。
    pub fn update_memory(
        &self,
        id: &str,
        base_ver: i64,
        value: Option<&str>,
        tags: Option<&[String]>,
    ) -> Result<()> {
        if let Some(value) = value {
            reject_secret_like(value)?;
        }
        let tags_json = tags
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| StoreError::Invalid(e.to_string()))?;

        let changed = self.conn.execute(
            "UPDATE memory SET
                value      = COALESCE(?3, value),
                tags_json  = COALESCE(?4, tags_json),
                ver        = ver + 1,
                updated_at = ?5
             WHERE id = ?1 AND ver = ?2",
            params![id, base_ver, value, tags_json, now_iso()],
        )?;

        if changed == 0 {
            let current = self.get_memory(id)?.map_or(0, |m| m.ver);
            return Err(StoreError::Invalid(format!(
                "记忆已被改过：你带的版本是 {base_ver}，当前是 {current}。请重新读取后再改"
            )));
        }
        Ok(())
    }

    pub fn set_memory_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE memory SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, i64::from(enabled), now_iso()],
        )?;
        Ok(())
    }

    pub fn set_memory_expiry(&self, id: &str, expires_at: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE memory SET expires_at = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, expires_at, now_iso()],
        )?;
        Ok(())
    }

    pub fn delete_memory(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM memory WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── 提示词库 ─────────────────────────────────────────────────────────

    pub fn create_prompt(&self, prompt: &NewPrompt) -> Result<String> {
        self.insert_prompt(prompt, false)
    }

    pub fn create_builtin_prompt(&self, prompt: &NewPrompt) -> Result<String> {
        self.insert_prompt(prompt, true)
    }

    fn insert_prompt(&self, prompt: &NewPrompt, builtin: bool) -> Result<String> {
        validate_sections(&prompt.sections_json)?;

        let id = new_id("prompt");
        self.conn.execute(
            "INSERT INTO prompt(id, \"group\", name, sections_json, vars_json, ver, builtin, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
            params![
                id,
                prompt.group,
                prompt.name,
                prompt.sections_json,
                prompt.vars_json,
                i64::from(builtin),
                now_iso(),
            ],
        )?;
        self.index_text(
            "prompt",
            &id,
            &format!("{} {}", prompt.name, prompt.sections_json),
        )?;
        Ok(id)
    }

    pub fn get_prompt(&self, id: &str) -> Result<Option<PromptRow>> {
        let sql = format!("SELECT {PROMPT_COLUMNS} FROM prompt WHERE id = ?1");
        let row = self
            .conn
            .query_row(&sql, params![id], map_prompt_row)
            .optional()?;
        Ok(row)
    }

    /// 列出提示词。同一分组的排在一起 —— 图纸左栏按分组显示，
    /// 交错的话用户会以为列表坏了。
    ///
    /// `query` 同时匹配名称与正文（图纸的搜索框写的是「搜索名称、变量或正文」）。
    pub fn list_prompts(&self, query: Option<&str>) -> Result<Vec<PromptRow>> {
        let sql = format!(
            "SELECT {PROMPT_COLUMNS} FROM prompt
             WHERE (?1 IS NULL OR name LIKE ?1 OR sections_json LIKE ?1 OR vars_json LIKE ?1)
             ORDER BY \"group\" ASC, name ASC"
        );
        let like = query.map(|q| format!("%{q}%"));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![like], map_prompt_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 列出提示词的一页，同时给出总数。
    pub fn list_prompts_paged(
        &self,
        group: Option<&str>,
        query: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<PromptRow>, i64)> {
        let like = query.map(|q| format!("%{q}%"));
        // group 是 SQL 关键字，列名要引起来 —— 用 r#""# 免去转义
        let where_clause = r#"WHERE (?1 IS NULL OR name LIKE ?1
                                     OR sections_json LIKE ?1 OR vars_json LIKE ?1)
                                AND (?2 IS NULL OR "group" = ?2)"#;

        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM prompt {where_clause}"),
            params![like, group],
            |row| row.get(0),
        )?;

        let sql = format!(
            r#"SELECT {PROMPT_COLUMNS} FROM prompt {where_clause}
               ORDER BY updated_at DESC, rowid DESC
               LIMIT ?3 OFFSET ?4"#
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![like, group, limit, offset], map_prompt_row)?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
    }

    /// 更新提示词，版本号递增。
    ///
    /// 「运行记录会引用当时的提示词版本，历史结果始终可解释」——
    /// 版本号必须往前走，否则没法回答「那次运行用的是哪一版」。
    /// 更新提示词，**带乐观锁**，返回新版本号。
    ///
    /// 运行记录引用的是具体版本号，所以版本必须只增不改 ——
    /// 同一个 ver 前后指向两份不同的正文，历史结果就再也解释不清了。
    /// 保存新版本。
    ///
    /// `changed_by` 是「你」还是「AI 提议」—— 分不清人改的还是 AI 改的，
    /// 版本页那句「历史结果始终可解释」就少了一半。缺省算用户改的。
    pub fn update_prompt(
        &self,
        id: &str,
        base_ver: i64,
        name: Option<&str>,
        sections_json: Option<&str>,
        vars_json: Option<&str>,
        changed_by: Option<&str>,
    ) -> Result<i64> {
        // 校验放在乐观锁之前：非法分段无论版本对不对都不该落库
        if let Some(sections) = sections_json {
            validate_sections(sections)?;
        }

        // 把**将被替换掉的那份**存进历史。放在 UPDATE 之前 ——
        // 之后再存的话读到的已经是新内容了。
        // 版本号对不上时这条 INSERT 不影响什么：下面的 UPDATE 会因为
        // 乐观锁失败而整体回滚（同一个连接、同一个隐式事务）
        self.conn.execute(
            "INSERT INTO prompt_version
                (prompt_id, ver, name, sections_json, vars_json, changed_by, created_at)
             SELECT id, ver, name, sections_json, vars_json, ?2, ?3
             FROM prompt WHERE id = ?1 AND ver = ?4
             ON CONFLICT(prompt_id, ver) DO NOTHING",
            params![id, changed_by.unwrap_or("你"), now_iso(), base_ver],
        )?;

        let changed = self.conn.execute(
            "UPDATE prompt SET
                name          = COALESCE(?3, name),
                sections_json = COALESCE(?4, sections_json),
                vars_json     = COALESCE(?5, vars_json),
                ver           = ver + 1,
                updated_at    = ?6
             WHERE id = ?1 AND ver = ?2",
            params![id, base_ver, name, sections_json, vars_json, now_iso()],
        )?;

        if changed == 0 {
            let current = self.get_prompt(id)?.map_or(0, |p| p.ver);
            if current == 0 {
                return Err(StoreError::NotFound {
                    kind: "提示词",
                    id: id.to_string(),
                });
            }
            return Err(StoreError::Invalid(format!(
                "提示词已被改过：你带的版本是 {base_ver}，当前是 {current}。请重新读取后再改"
            )));
        }

        Ok(base_ver + 1)
    }

    pub fn duplicate_prompt(&self, id: &str, new_name: &str) -> Result<String> {
        let source = self.get_prompt(id)?.ok_or(StoreError::NotFound {
            kind: "提示词",
            id: id.to_string(),
        })?;
        self.insert_prompt(
            &NewPrompt {
                group: source.group,
                name: new_name.to_string(),
                sections_json: source.sections_json,
                vars_json: source.vars_json,
            },
            false,
        )
    }

    /// 删除提示词。内置的不能删 —— 「系统调用 AI 的每一处都在这里」，
    /// 删掉内置的会让某处调用没有提示词可用。
    /// 一条提示词的全部历史版本，按版本号倒序（最近的在最前）。
    ///
    /// 当前版本不在里面 —— 它在 prompt 表里，界面自己拼上去。
    pub fn prompt_versions(&self, prompt_id: &str) -> Result<Vec<PromptVersionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT ver, name, sections_json, vars_json, changed_by, created_at
             FROM prompt_version WHERE prompt_id = ?1 ORDER BY ver DESC",
        )?;
        let rows = stmt.query_map(params![prompt_id], |row| {
            Ok(PromptVersionRow {
                ver: row.get(0)?,
                name: row.get(1)?,
                sections_json: row.get(2)?,
                vars_json: row.get(3)?,
                changed_by: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_prompt(&self, id: &str) -> Result<()> {
        let prompt = self.get_prompt(id)?.ok_or(StoreError::NotFound {
            kind: "提示词",
            id: id.to_string(),
        })?;
        if prompt.builtin {
            return Err(StoreError::Invalid(format!(
                "{} 是内置提示词，不能删除。可以复制一份再改",
                prompt.name
            )));
        }
        self.conn
            .execute("DELETE FROM prompt WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── Agent 角色 ───────────────────────────────────────────────────────

    pub fn create_agent(&self, agent: &NewAgent) -> Result<String> {
        self.insert_agent(agent, false)
    }

    /// 内置角色：随应用附带，用户可以复制但不能删。
    pub fn create_builtin_agent(&self, agent: &NewAgent) -> Result<String> {
        self.insert_agent(agent, true)
    }

    fn insert_agent(&self, agent: &NewAgent, builtin: bool) -> Result<String> {
        validate_runtime(&agent.runtime)?;
        if agent.turn_limit <= 0 || agent.timeout_ms <= 0 {
            return Err(StoreError::Invalid("轮次上限与超时必须是正数".to_string()));
        }

        let id = new_id("agent");
        let tools =
            serde_json::to_string(&agent.tools).map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO agent_profile(id, name, role, goal, persona, runtime, model_ref,
                                       fallback_model_ref, tools_json, policy_json,
                                       output_contract, turn_limit, timeout_ms, ver, builtin,
                                       created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?15, ?15)",
            params![
                id,
                agent.name,
                agent.role,
                agent.goal,
                agent.persona,
                agent.runtime,
                agent.model_ref,
                agent.fallback_model_ref,
                tools,
                agent.capabilities_json,
                agent.output_contract,
                agent.turn_limit,
                agent.timeout_ms,
                i64::from(builtin),
                now_iso(),
            ],
        )?;
        Ok(id)
    }

    pub fn get_agent(&self, id: &str) -> Result<Option<AgentRow>> {
        let sql = format!("SELECT {AGENT_COLUMNS} FROM agent_profile WHERE id = ?1");
        let row = self
            .conn
            .query_row(&sql, params![id], map_agent_row)
            .optional()?;
        Ok(row)
    }

    /// 列出角色，按名字排序 —— 顺序跳来跳去会让人找不到刚建的那条。
    pub fn list_agents(&self) -> Result<Vec<AgentRow>> {
        let sql = format!("SELECT {AGENT_COLUMNS} FROM agent_profile ORDER BY name ASC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], map_agent_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    /// 列出角色的一页，同时给出总数。
    ///
    /// name 可能重名（复制出来的副本就叫「X 副本」），补 rowid 保证全序 ——
    /// 排序不稳定的话翻页会看到重复的条目。
    /// 列出角色，可按名字或目标搜。
    ///
    /// 搜索必须在**后端**做：界面只看得到当前页（50 条），
    /// 而角色有一百多条 —— 前端过滤等于「在这一页里找」，
    /// 用户以为搜不到，其实只是不在这一页。
    ///
    /// 目标也参与匹配：名字是用户随手起的，而「定位根因」这种描述
    /// 反而是他记得住的部分。
    pub fn list_agents_paged(
        &self,
        query: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<AgentRow>, i64)> {
        // LIKE 在 SQLite 里对 ASCII 默认就不区分大小写；中文没有大小写之分。
        // 用户不会记得自己当初把角色叫 Builder 还是 builder
        let pattern = query
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| format!("%{text}%"));

        let (filter, params_vec): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match &pattern {
            Some(like) => (
                "WHERE name LIKE ?1 OR goal LIKE ?1",
                vec![Box::new(like.clone())],
            ),
            None => ("", Vec::new()),
        };

        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM agent_profile {filter}"),
            rusqlite::params_from_iter(params_vec.iter().map(std::convert::AsRef::as_ref)),
            |row| row.get(0),
        )?;

        // 最近动过的排最前：按名字排的话，新建的会被埋在中间某一页。
        // rowid 兜底 —— 同一毫秒的几条按时间排顺序不稳定，
        // 翻页会重复看到一些、永远看不到另一些
        let sql = format!(
            "SELECT {AGENT_COLUMNS} FROM agent_profile {filter}
             ORDER BY updated_at DESC, rowid DESC LIMIT ?{} OFFSET ?{}",
            params_vec.len() + 1,
            params_vec.len() + 2
        );
        let mut all: Vec<Box<dyn rusqlite::ToSql>> = params_vec;
        all.push(Box::new(limit));
        all.push(Box::new(offset));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(all.iter().map(std::convert::AsRef::as_ref)),
            map_agent_row,
        )?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
    }

    /// 更新角色，**版本号递增**。
    ///
    /// 图纸的按钮是「保存新版本」：节点引用角色而不是复制 Prompt，
    /// 所以运行记录必须能说清当时用的是第几版。
    /// 更新 Agent 角色，**带乐观锁**，返回新版本号。
    ///
    /// 和 [`Self::update_memory`] 同一套理由：节点引用的是角色 id，
    /// 所以一次覆盖会同时改掉所有引用它的节点的行为 ——
    /// 用户和 AI 同时在改时，无声覆盖比冲突报错糟得多。
    ///
    /// `fallback_model_ref` 用空串表示「不降级」：用 `None` 的话就与
    /// 「这个字段没改」撞了，降级模型一旦设上就再也去不掉。
    pub fn update_agent(&self, id: &str, base_ver: i64, patch: &AgentPatch<'_>) -> Result<i64> {
        let AgentPatch {
            name,
            goal,
            persona,
            model_ref,
            fallback_model_ref,
            capabilities_json,
            tools,
            output_contract,
        } = *patch;

        // 工具是数组，存成 JSON。None 表示没改
        let tools_json =
            tools.map(|list| serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string()));

        let fallback = fallback_model_ref.map(|value| {
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        });

        let changed = self.conn.execute(
            // updated_at 一起推：列表按它排，不推的话改过的角色
            // 仍然停在原来的位置，用户以为自己没保存成功
            "UPDATE agent_profile SET
                name      = COALESCE(?3, name),
                goal      = COALESCE(?4, goal),
                persona   = COALESCE(?5, persona),
                model_ref = COALESCE(?6, model_ref),
                fallback_model_ref = CASE WHEN ?8 THEN ?7 ELSE fallback_model_ref END,
                policy_json = COALESCE(?10, policy_json),
                tools_json = COALESCE(?11, tools_json),
                output_contract = COALESCE(?12, output_contract),
                ver       = ver + 1,
                updated_at = ?9
             WHERE id = ?1 AND ver = ?2",
            params![
                id,
                base_ver,
                name,
                goal,
                persona,
                model_ref,
                fallback.clone().flatten(),
                fallback.is_some(),
                now_iso(),
                capabilities_json,
                tools_json,
                output_contract,
            ],
        )?;

        if changed == 0 {
            let current = self.get_agent(id)?.map_or(0, |a| a.ver);
            if current == 0 {
                return Err(StoreError::NotFound {
                    kind: "Agent 角色",
                    id: id.to_string(),
                });
            }
            return Err(StoreError::Invalid(format!(
                "Agent 角色已被改过：你带的版本是 {base_ver}，当前是 {current}。请重新读取后再改"
            )));
        }

        Ok(base_ver + 1)
    }

    /// 复制成一个可编辑的副本。用户想基于内置角色改，但不该改到内置本身。
    pub fn duplicate_agent(&self, id: &str, new_name: &str) -> Result<String> {
        let source = self.get_agent(id)?.ok_or(StoreError::NotFound {
            kind: "Agent 角色",
            id: id.to_string(),
        })?;

        self.insert_agent(
            &NewAgent {
                name: new_name.to_string(),
                role: source.role,
                goal: source.goal,
                persona: source.persona,
                runtime: source.runtime,
                model_ref: source.model_ref,
                fallback_model_ref: source.fallback_model_ref,
                tools: source.tools,
                capabilities_json: source.capabilities_json,
                output_contract: source.output_contract,
                turn_limit: source.turn_limit,
                timeout_ms: source.timeout_ms,
            },
            false,
        )
    }

    /// 删除角色。内置的不能删 —— 引用它的节点会失效，
    /// 而用户往往意识不到某个节点在用它。
    pub fn delete_agent(&self, id: &str) -> Result<()> {
        let agent = self.get_agent(id)?.ok_or(StoreError::NotFound {
            kind: "Agent 角色",
            id: id.to_string(),
        })?;
        if agent.builtin {
            return Err(StoreError::Invalid(format!(
                "{} 是内置角色，不能删除。可以复制一份再改",
                agent.name
            )));
        }
        self.conn
            .execute("DELETE FROM agent_profile WHERE id = ?1", params![id])?;
        Ok(())
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
            "INSERT INTO model(id, name, runtime, model_id, effort, ctx, caps_json, cred_ref,
                               enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
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
                now_iso(),
            ],
        )?;
        Ok(id)
    }

    /// 记下最近一次连通性测试的延迟。
    ///
    /// **失败也记**：那同样是「最近一次测试」的结果，而用户看到一个
    /// 停在上周的延迟数字会以为现在还是那么快。
    pub fn set_model_latency(&self, id: &str, latency_ms: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE model SET last_latency_ms = ?2 WHERE id = ?1",
            params![id, latency_ms],
        )?;
        Ok(())
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
    /// 把从 runtime 同步来的模型清单写进库，返回新增了几条。
    ///
    /// **按 (runtime, model_id) 去重**：同步是可以反复点的（换了登录态、
    /// 装了新版 CLI 都会再点一次），每次长一批重复条目的话，下拉里会出现
    /// 五个一模一样的 GPT-5.6-Sol，而删哪个都说不清。
    ///
    /// **不删已有条目**：清单里消失的那些（CLI 降级、换了账号）留着，
    /// 因为可能有 Agent 角色正引用它。悄悄删掉的话，那些角色的
    /// `model_ref` 会悬空，症状是角色页打开就报「不合契约」——
    /// 离「我刚点了同步」已经隔了三层。
    ///
    /// `ctx` / `caps_json` / `cred_ref` 这几列给的是占位值：ACP 不用凭据
    /// （登录态由 CLI 自己管），上下文窗口 agent 自己知道且两端语义不同
    /// （claude 报模型窗口、codex 报会话水位），填一个手编的数字更糟。
    pub fn sync_models(&self, runtime: &str, models: &[SyncedModel]) -> Result<usize> {
        validate_runtime(runtime)?;

        let mut 已有 = std::collections::HashSet::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT model_id FROM model WHERE runtime = ?1")?;
            let rows = stmt.query_map(params![runtime], |row| row.get::<_, String>(0))?;
            for row in rows {
                已有.insert(row?);
            }
        }

        let mut 新增 = 0;
        for model in models {
            if 已有.contains(&model.value) {
                // 名字可能变了（adapter 更新了描述），跟着更新
                self.conn.execute(
                    "UPDATE model SET name = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                      WHERE runtime = ?1 AND model_id = ?2",
                    params![runtime, model.value, model.label],
                )?;
                continue;
            }
            self.conn.execute(
                "INSERT INTO model(id, name, runtime, model_id, effort, ctx, caps_json, cred_ref,
                                   enabled, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, 'medium', 0, '[]', NULL, 1,
                        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                        strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![new_id("model"), model.label, runtime, model.value],
            )?;
            新增 += 1;
        }
        Ok(新增)
    }

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

    /// 列出模型的一页，同时给出总数。
    /// 列出模型，可按名字或模型 ID 搜。
    ///
    /// 模型 ID 也参与匹配：那是用户从文档里抄来的字符串，
    /// 比他随手起的显示名更容易记住。
    ///
    /// `?2` 为 NULL 时不筛 —— 空搜索词与「搜一个空串」是两回事。
    pub fn list_models_paged(
        &self,
        enabled_only: bool,
        query: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<ModelRow>, i64)> {
        let flag = i64::from(enabled_only);
        let like = query
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| format!("%{text}%"));

        let 条件 = "WHERE (?1 = 0 OR enabled = 1)
             AND (?2 IS NULL OR name LIKE ?2 OR model_id LIKE ?2)";

        let total: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM model {条件}"),
            params![flag, like],
            |row| row.get(0),
        )?;

        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, name, runtime, model_id, effort, ctx, caps_json, cred_ref, enabled, last_latency_ms
             FROM model
             {条件}
             ORDER BY updated_at DESC, rowid DESC
             LIMIT ?3 OFFSET ?4"
        ))?;
        let rows = stmt.query_map(params![flag, like, limit, offset], map_model_row)?;
        Ok((rows.collect::<std::result::Result<Vec<_>, _>>()?, total))
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
                enabled  = COALESCE(?8, enabled),
                -- 列表按 updated_at 排，不推的话改过的条目停在原位
                updated_at = ?9
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
                now_iso(),
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
        // 先看有没有人在用它。
        //
        // 这里原本是一条裸 DELETE：不查引用、也不查内置（model 表根本
        // 没有 builtin 列）。删掉 `model:codex` 之后四个内置角色的
        // `model_ref` 全部悬空 —— 而种子批次记账保证它**不会在下次启动
        // 被种回来**，唯一的恢复手段是一键初始化。
        //
        // `delete_agent` 那边早就有这道检查了。
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM agent_profile WHERE model_ref = ?1 OR fallback_model_ref = ?1 ORDER BY name")?;
        let 用它的: Vec<String> = stmt
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        if !用它的.is_empty() {
            return Err(StoreError::Invalid(format!(
                "这些 Agent 角色还在用它：{}。先给它们换一个模型再删",
                用它的.join("、")
            )));
        }

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
    /// 返回是否真的更新了。**调用方必须看这个返回值**：
    /// 更新 0 行意味着运行已经进入终态（多半是刚被取消），
    /// 此时继续推进就会在取消之后仍然产生副作用。
    pub fn advance_run_status(
        &self,
        run_id: &str,
        status: &str,
        current_node: Option<&str>,
    ) -> Result<bool> {
        // 进终态时记下结束时间。不记的话「这次跑了多久」在整个应用里都是空的 ——
        // 首页的「4m18s」、执行记录的时长都没有数据来源。
        //
        // waiting_approval 不算终态：它会停很久但随时可能继续，
        // 记了的话审批等待会被算进执行耗时
        let ended_at = TERMINAL_RUN_STATUSES
            .contains(&status)
            .then(now_iso)
            .unwrap_or_default();

        let changed = self.conn.execute(
            "UPDATE run SET status = ?2, current_node = ?3,
                            ended_at = CASE WHEN ?4 = '' THEN ended_at ELSE ?4 END
             WHERE id = ?1 AND status NOT IN ('succeeded', 'failed', 'cancelled')",
            params![run_id, status, current_node, ended_at],
        )?;
        Ok(changed > 0)
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
        // 契约对 `node.*` 有两条硬要求：带 nodeId（否则画布里定位不到）、
        // 带 attempt（重试历史靠它区分轮次）。两条都拦在这里。
        //
        // 拦在这里而不是靠每条写入路径自觉 —— 写入路径会一直加，
        // 而这条是契约的规则不是某条路径的。issue #1 就是这么来的：
        // 引擎多了一条事件通道，它填 `attempt: None`，于是
        // `node.output_emitted` 缺 attempt，界面把**整页**事件流判为不合契约。
        // 一条事件坏了整页看不了，所以宁可写不进去也不能写脏。
        //
        // 只管 `node.*`：conversation / tool / script / reasoning 没有
        // attempt 的概念，一刀切要求的话它们全写不进去。
        if event.kind.starts_with("node.") {
            if event.node_id.is_none() {
                return Err(StoreError::Invalid(format!(
                    "{} 缺 node_id。契约要求每个 node.* 事件带上它 —— 没有它就没法在画布里定位",
                    event.kind
                )));
            }
            if event.attempt.is_none() {
                return Err(StoreError::Invalid(format!(
                    "{} 缺 attempt。契约要求每个 node.* 事件带上它 —— 重试历史靠它区分轮次",
                    event.kind
                )));
            }
        }
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
            "INSERT INTO run_event(id, run_id, seq, ts, type, node_id, node_label, attempt,
                                   actor, status, summary, payload_ref, artifact_refs,
                                   parent_event_id, sensitivity, schema_ver)
             VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_event WHERE run_id = ?2),
                     ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             RETURNING seq",
            params![
                id,
                event.run_id,
                now_iso(),
                event.kind,
                event.node_id,
                event.node_label,
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

    /// 测试脚手架：直接执行一条带两个参数的 SQL。
    ///
    /// 用来造「这个改动之前落库的行」——那种行在正常路径上已经造不出来了。
    #[doc(hidden)]
    pub fn execute_raw(&self, sql: &str, a: &str, b: &str) -> Result<()> {
        self.conn.execute(sql, params![a, b])?;
        Ok(())
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
            "SELECT id, run_id, seq, ts, type, node_id, node_label, attempt, actor, summary,
                    payload_ref, sensitivity
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
                node_label: row.get(6)?,
                attempt: row.get(7)?,
                actor: row.get(8)?,
                summary: row.get(9)?,
                payload_ref: row.get(10)?,
                sensitivity: row.get(11)?,
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

    /// 最近一个**带审批**的检查点。
    ///
    /// 图纸失败横幅的第二个按钮「回到最近审批点改选择」用它：用户在审批
    /// 那一步选错了（批准了一个不该批的 Diff），后面才发现 ——
    /// 「从失败节点重试」没用，那会沿用同一个决定继续往下。
    ///
    /// 取的是最近那个**审批**检查点，不是最新的检查点：每个节点完成后
    /// 都会落一次，最新那个多半是普通节点。
    pub fn latest_approval_checkpoint(&self, run_id: &str) -> Result<Option<CheckpointRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT run_id, seq, env_json, pending_approval_json, created_at
                 FROM run_checkpoint
                 WHERE run_id = ?1 AND pending_approval_json IS NOT NULL
                 ORDER BY seq DESC LIMIT 1",
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

    // ── 全文检索 ────────────────────────────────────────────────────────────

    fn index_text(&self, kind: &str, ref_id: &str, text: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO fts_index(kind, ref_id, text) VALUES (?1, ?2, ?3)",
            params![kind, ref_id, segment_cjk(text)],
        )?;
        // 侧表跟着写：删除触发器靠它按 rowid 定位。
        // 少了这一行，那条索引就再也删不掉了 —— FTS 的 kind/ref_id 是
        // UNINDEXED，没有侧表就只能全表扫，而那正是这张表存在的理由
        self.conn.execute(
            "INSERT INTO fts_ref(kind, ref_id, fts_rowid) VALUES (?1, ?2, ?3)",
            params![kind, ref_id, self.conn.last_insert_rowid()],
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

/// 只有 workflow 表那 6 列时用这个 —— 单条查询不带运行态投影：
/// 打开一条工作流时界面要的是图，不是它上次跑得怎么样。
fn map_supervisor_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SupervisorSessionRow> {
    Ok(SupervisorSessionRow {
        id: row.get(0)?,
        title: row.get(1)?,
        started_at: row.get(2)?,
        updated_at: row.get(3)?,
        message_count: row.get(4)?,
        workflow_id: row.get(5)?,
        run_id: row.get(6)?,
        model_ref: row.get(7)?,
    })
}

/// 标题取问题的前 40 字。整段问题当标题会把列表撑得没法看，
/// 而前几十字足够认出「上次那条」。
fn truncate_title(text: &str) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(40).collect();
    if trimmed.chars().count() > 40 {
        out.push('…');
    }
    if out.is_empty() {
        "未命名会话".to_string()
    } else {
        out
    }
}

fn map_workflow_bare(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRow> {
    Ok(WorkflowRow {
        id: row.get(0)?,
        name: row.get(1)?,
        folder: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        archived: row.get::<_, i64>(5)? != 0,
        latest_version: None,
        last_run: None,
    })
}

fn map_workflow(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRow> {
    let last_run = row.get::<_, Option<String>>(7)?.map(|id| WorkflowLastRun {
        id,
        status: row.get(8).unwrap_or_default(),
        started_at: row.get(9).unwrap_or_default(),
        ended_at: row.get(10).unwrap_or_default(),
        failed_node: row.get(11).unwrap_or_default(),
        version: row.get(12).unwrap_or_default(),
    });

    Ok(WorkflowRow {
        id: row.get(0)?,
        name: row.get(1)?,
        folder: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        archived: row.get::<_, i64>(5)? != 0,
        latest_version: row.get(6)?,
        last_run,
    })
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 这个库里我们自己建的表。
///
/// 从 `sqlite_master` 现查而不是维护一张清单：清单会漏 —— 加了迁移
/// 忘了往清单里补一行，重置之后那张表带着旧数据活下来，
/// 而它看起来完全正常。
///
/// `sqlite_` 前缀的是 SQLite 自己的内部表（`sqlite_sequence` 这些），
/// DROP 它们会报错。
fn 用户表(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let 表: rusqlite::Result<Vec<String>> = stmt.query_map([], |row| row.get(0))?.collect();
    Ok(表?)
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

/// 记忆内容里不能出现看起来像凭据的东西。
///
/// 「Token、密钥和敏感文件内容禁止写入记忆」—— 记忆会被注入
/// **每一次** AI 调用，写进去等于持续发给模型，而且会跟着
/// 导出包、诊断包到处走。
///
/// 这里只挡明显的形态。真正的防线是「Secret 只进 Keychain」，
/// 但那管不住用户手工粘贴 —— 所以这一层要有。
/// 像密钥的前缀。脱敏与拒收共用同一份 —— 两份必然会漂移。
const SECRET_PREFIXES: &[(&str, &str)] = &[
    ("AKIA", "AWS 访问密钥"),
    ("sk-ant-", "Anthropic API Key"),
    ("sk-proj-", "OpenAI 项目密钥"),
    ("sk-", "API Key"),
    ("ghp_", "GitHub 个人令牌"),
    ("gho_", "GitHub OAuth 令牌"),
    ("ghs_", "GitHub 服务端令牌"),
    ("github_pat_", "GitHub 细粒度令牌"),
    ("xoxb-", "Slack Bot 令牌"),
    ("xoxp-", "Slack User 令牌"),
    ("-----BEGIN", "私钥"),
];

/// 把启动参数里像密钥的值遮掉。
///
/// 脱敏发生在**写入时**：只在某一个视图上遮掉的话，换个接口
/// （列表、搜索、导出、MCP）就又漏出去了 —— 而那正是被发现的方式：
/// 详情页写着「Secret 已脱敏」，运行列表却把完整的 sk-proj- 显示出来。
///
/// 字段名留着、值换成 `[已脱敏]`：完全删掉的话用户不知道这里本来有个参数。
/// `keychain://` 原样保留 —— 它本来就是「引用而非明文」的表达方式。
#[must_use]
pub fn redact_inputs(inputs_json: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(inputs_json) else {
        // 解析不了就整段判断：宁可多遮，也不能漏
        return if looks_like_secret(inputs_json) {
            "\"[已脱敏]\"".to_string()
        } else {
            inputs_json.to_string()
        };
    };

    redact_value(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

fn redact_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            if looks_like_secret(text) {
                *text = "[已脱敏]".to_string();
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_value),
        serde_json::Value::Object(map) => map.values_mut().for_each(redact_value),
        _ => {}
    }
}

fn looks_like_secret(value: &str) -> bool {
    // keychain:// 是引用不是明文，遮掉它反而丢信息
    if value.starts_with("keychain://") {
        return false;
    }
    secret_hit(value).is_some()
}

/// 命中了哪一类密钥。没命中返回 None。
///
/// **要边界，也要长度。** 原来是裸的 `value.contains(prefix)`，
/// 而前缀里有 `sk-` —— 于是 `task-manager`（ta**sk-**manager）被判成密钥。
/// 那不是理论问题：`create_run` 的脱敏发生在 INSERT **之前**，
/// 所以仓库叫 `acme/task-manager` 的用户从下拉里选中它，
/// 库里存的就是 `[已脱敏]`，工作流跑向一个不存在的仓库，
/// **而明文从未落库，不可恢复**。同一份判据还挡在设置的写入路径上：
/// 把工作目录设成 `~/work/task-manager` 会被硬拒。
///
/// 两条约束合起来才够：
/// - **前面是边界**：前缀要么在开头，要么前一个字符不是字母/数字/`-`/`_`。
///   `task-manager` 里的 `sk-` 前面是 `a`，不算
/// - **后面够长**：真令牌前缀后面跟着一长串随机字符。
///   一个恰好以 `sk-` 结尾的词后面什么都没有，不算
fn secret_hit(value: &str) -> Option<&'static str> {
    /// 前缀之后至少还要有这么多字符才像个真令牌。
    /// GitHub / OpenAI / AWS 的令牌都远长于此。
    const MIN_TAIL: usize = 12;

    for (prefix, what) in SECRET_PREFIXES {
        let mut from = 0;
        while let Some(offset) = value[from..].find(prefix) {
            let at = from + offset;
            let 前面是边界 = at == 0
                || !value[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '-' || c == '_');
            // 私钥块自带 `-----` 边界，长度另算：它后面跟的是换行与 base64
            let 够长 = *prefix == "-----BEGIN" || value.len() - at - prefix.len() >= MIN_TAIL;
            if 前面是边界 && 够长 {
                return Some(what);
            }
            from = at + prefix.len();
        }
    }
    None
}

fn reject_secret_like(value: &str) -> Result<()> {
    // 与 looks_like_secret 同一份判据 —— 两处各写一个 contains 的话，
    // 「什么算密钥」就有了两个互不知道的答案
    if let Some(what) = secret_hit(value) {
        return Err(StoreError::Invalid(format!(
            "内容里像是有{what}。记忆会被注入每一次 AI 调用，密钥请存进钥匙串后用 keychain:// 引用"
        )));
    }
    Ok(())
}

/// 分段必须是非空的 JSON 数组。
///
/// 一条没有任何分段的提示词等于没有提示词，让它存进去只会在
/// 真正调用 AI 的时候才发现 —— 那时已经在一次运行中间了。
fn validate_sections(sections_json: &str) -> Result<()> {
    let parsed: serde_json::Value = serde_json::from_str(sections_json)
        .map_err(|error| StoreError::Invalid(format!("分段不是合法 JSON：{error}")))?;

    match parsed.as_array() {
        Some(items) if !items.is_empty() => Ok(()),
        Some(_) => Err(StoreError::Invalid("提示词至少要有一个分段".to_string())),
        None => Err(StoreError::Invalid("分段必须是数组".to_string())),
    }
}

/// 契约里的接入方式枚举（`AGENT_RUNTIMES`）。
///
/// Rust 侧留一份镜像，是为了让绕过界面的调用路径（MCP、脚本、HTTP 桥接）
/// 同样写不进脏数据。contract_sync_test 守住它不脱离契约。
pub const AGENT_RUNTIMES: &[&str] = &["acp.claude", "acp.codex"];

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

/// 工作区设置的三项。全部可空 —— 没配过就是没配过，界面照实显示。
#[derive(Debug, Default, Clone)]
pub struct WorkspaceSettings {
    /// 已授权的工作目录。顶栏面包屑最前面显示它。
    pub workdir: Option<String>,
    /// 权限档：图纸的三档之一（Review Every Change / Workspace Safe / Trusted Workflow）。
    pub permission_preset: Option<String>,
    /// 上次环境检查的时间。侧栏据此显示「环境正常」还是「环境尚未检查」。
    pub env_checked_at: Option<String>,
}

/// 允许写入的设置键。
///
/// 不挡的话这张 key-value 表会慢慢变成什么都往里塞的垃圾桶，
/// 而每个消费方都得自己猜键名对不对 —— 猜错了不报错，只是读不到。
const WORKSPACE_SETTING_KEYS: &[&str] = &["workdir", "permissionPreset", "envCheckedAt"];

impl Store {
    /// 读全部工作区设置。没配过的项是 None。
    pub fn workspace_settings(&self) -> Result<WorkspaceSettings> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM workspace_setting")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut settings = WorkspaceSettings::default();
        for row in rows {
            let (key, value) = row?;
            match key.as_str() {
                "workdir" => settings.workdir = Some(value),
                "permissionPreset" => settings.permission_preset = Some(value),
                "envCheckedAt" => settings.env_checked_at = Some(value),
                // 旧版本写进去的键：读的时候忽略，不报错 —— 降级回滚时还能用
                _ => {}
            }
        }
        Ok(settings)
    }

    /// 写一项工作区设置。同名键覆盖。
    pub fn set_workspace_setting(&self, key: &str, value: &str) -> Result<()> {
        if !WORKSPACE_SETTING_KEYS.contains(&key) {
            return Err(StoreError::Invalid(format!(
                "不认识的设置项 {key}。允许的是：{}",
                WORKSPACE_SETTING_KEYS.join("、")
            )));
        }
        // 设置会被诊断报告导出，也会显示在界面上 —— 明文密钥进了这里就到处都是
        reject_secret_like(value)?;

        self.conn.execute(
            "INSERT INTO workspace_setting (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_iso()],
        )?;
        Ok(())
    }
}

/// 新建工作流时用的默认名前缀。
const UNTITLED_PREFIX: &str = "未命名工作流 ";

impl Store {
    /// 下一个可用的「未命名工作流 N」。
    ///
    /// 编号必须由存储层给：界面看到的是**当前页**（分页后固定 50 条），
    /// 用页内条数 +1 的话永远得到「未命名工作流 51」——
    /// codex 复测时数据库里已经有 23 条同名记录，靠名字根本认不出哪条是哪条。
    ///
    /// 不回收被删掉的编号：回收的话，旧运行记录里写的名字会指向一条
    /// **不同的**工作流，而那种错位没有任何提示。
    pub fn next_untitled_name(&self) -> Result<String> {
        // LIKE 只做粗筛（前缀匹配走索引），真正的判定在 Rust 侧 ——
        // 「未命名工作流的第 3 版」这种名字不该把编号推到 4
        let pattern = format!("{UNTITLED_PREFIX}%");
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM workflow WHERE name LIKE ?1")?;
        let rows = stmt.query_map([&pattern], |row| row.get::<_, String>(0))?;

        let mut max = 0_u32;
        for row in rows {
            let name = row?;
            let Some(rest) = name.strip_prefix(UNTITLED_PREFIX) else {
                continue;
            };
            if let Ok(number) = rest.parse::<u32>() {
                max = max.max(number);
            }
        }
        Ok(format!("{UNTITLED_PREFIX}{}", max + 1))
    }
}

/// MCP 提交的一条待确认写操作。
#[derive(Debug, Clone)]
pub struct ConfirmationRow {
    pub id: String,
    pub tool: String,
    pub input_json: String,
    /// pending / approved / rejected / expired
    pub status: String,
    pub created_at: String,
    pub decided_at: Option<String>,
}

impl Store {
    /// MCP 提交一条待确认的写操作。
    ///
    /// 入参会原样显示给用户 —— 他要看清楚「它到底要改什么」才能决定，
    /// 所以这里也拒明文密钥（那份内容会留在库里，也会出现在界面上）。
    pub fn create_confirmation(&self, tool: &str, input_json: &str) -> Result<String> {
        reject_secret_like(input_json)?;

        let id = new_id("mcpc");
        self.conn.execute(
            "INSERT INTO mcp_confirmation (id, tool, input_json, status, created_at)
             VALUES (?1, ?2, ?3, 'pending', ?4)",
            params![id, tool, input_json, now_iso()],
        )?;
        Ok(id)
    }

    pub fn get_confirmation(&self, id: &str) -> Result<Option<ConfirmationRow>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, tool, input_json, status, created_at, decided_at
                 FROM mcp_confirmation WHERE id = ?1",
                params![id],
                map_confirmation,
            )
            .optional()?;
        Ok(row)
    }

    /// 还没决定的那些。应用轮询它来显示确认卡。
    pub fn pending_confirmations(&self) -> Result<Vec<ConfirmationRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, tool, input_json, status, created_at, decided_at
             FROM mcp_confirmation WHERE status = 'pending' ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], map_confirmation)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// 用户的决定。**只能决定一次** —— 否则同一条写操作可能被批准两次，
    /// 或者批准后又被改成拒绝，而 MCP 那边可能已经读到第一个结果动手了。
    /// 认领一条已批准的确认：找到就把它标成已消费，并回报「找到了」。
    ///
    /// 这一步原本不存在 —— `call_tool` 每次都无条件重跑 `gate_for`，
    /// 而没有任何一处代码读 `status = 'approved'`。于是默认权限档下
    /// 40 多个写工具一个都用不了：用户点了「批准」，agent 再调一次
    /// 仍然被挡，而且**又入队一条新的**，用户被同一个弹层反复砸。
    ///
    /// **一次批准换一次执行**：认领成功就改成 `consumed`。
    /// 不消费的话，agent 拿着一条旧批准可以把同一个写操作重复做任意多次 ——
    /// 而用户以为自己只批准了一次。
    ///
    /// 匹配 tool + input_json 完全一致：用户批准的是「建一个叫『新的』
    /// 的工作流」，不是「建任何工作流」。
    ///
    /// 单条 UPDATE 完成查找与消费，两个并发调用不会都认领到同一条 ——
    /// 先到的那条把 status 改掉，后到的 `changed` 就是 0。
    pub fn claim_approved_confirmation(&self, tool: &str, input_json: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE mcp_confirmation SET status = 'consumed', decided_at = ?3
             WHERE id = (
               SELECT id FROM mcp_confirmation
                WHERE tool = ?1 AND input_json = ?2 AND status = 'approved'
                ORDER BY created_at
                LIMIT 1
             )",
            params![tool, input_json, now_iso()],
        )?;
        Ok(changed > 0)
    }

    pub fn decide_confirmation(&self, id: &str, approved: bool) -> Result<()> {
        let status = if approved { "approved" } else { "rejected" };
        let changed = self.conn.execute(
            "UPDATE mcp_confirmation SET status = ?2, decided_at = ?3
             WHERE id = ?1 AND status = 'pending'",
            params![id, status, now_iso()],
        )?;

        if changed == 0 {
            return Err(StoreError::Invalid(format!(
                "确认 {id} 不存在或已经决定过了"
            )));
        }
        Ok(())
    }

    /// 把超过 `ttl_secs` 还没人理的标成过期，返回处理了几条。
    ///
    /// **默认拒绝**：没人理的写操作不该在几小时后突然生效。
    pub fn expire_confirmations(&self, ttl_secs: i64) -> Result<usize> {
        let changed = self.conn.execute(
            "UPDATE mcp_confirmation SET status = 'expired', decided_at = ?2
             WHERE status = 'pending'
               AND (julianday(?2) - julianday(created_at)) * 86400.0 >= ?1",
            params![ttl_secs, now_iso()],
        )?;
        Ok(changed)
    }
}

fn map_confirmation(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConfirmationRow> {
    Ok(ConfirmationRow {
        id: row.get(0)?,
        tool: row.get(1)?,
        input_json: row.get(2)?,
        status: row.get(3)?,
        created_at: row.get(4)?,
        decided_at: row.get(5)?,
    })
}
