-- 初始 schema。对应技术选型 §10 的数据模型。
--
-- 约定：
--   * 时间一律 ISO-8601 UTC 字符串，方便直接给到界面与导出物；
--   * 大 payload 与日志落 artifacts/ 目录，事件只存 summary 与 payload_ref；
--   * 删除工作流会级联清掉它的运行与事件，避免留下无主记录。

CREATE TABLE workflow (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  folder      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived    INTEGER NOT NULL DEFAULT 0
);

-- 草稿：rev 单调递增，编辑草稿不影响运行中的版本
CREATE TABLE workflow_revision (
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,
  graph_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (workflow_id, rev)
);

-- 已发布版本：不可变快照，运行记录永远引用它
CREATE TABLE workflow_version (
  id                       TEXT PRIMARY KEY,
  workflow_id              TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  version                  INTEGER NOT NULL,
  graph_json               TEXT NOT NULL,
  config_hash              TEXT NOT NULL,
  dependency_manifest_json TEXT NOT NULL DEFAULT '{}',
  published_at             TEXT NOT NULL,
  published_by             TEXT NOT NULL,
  UNIQUE (workflow_id, version)
);

CREATE TABLE node_definition (
  type        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  ports_json  TEXT NOT NULL,
  caps_json   TEXT NOT NULL,
  PRIMARY KEY (type, version)
);

CREATE TABLE agent_profile (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  persona     TEXT NOT NULL DEFAULT '',
  model_ref   TEXT NOT NULL,
  tools_json  TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  ver         INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE prompt (
  id            TEXT PRIMARY KEY,
  "group"       TEXT NOT NULL,
  name          TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  vars_json     TEXT NOT NULL DEFAULT '[]',
  ver           INTEGER NOT NULL DEFAULT 1,
  builtin       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

CREATE TABLE model (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  runtime   TEXT NOT NULL,
  model_id  TEXT NOT NULL,
  effort    TEXT NOT NULL DEFAULT 'medium',
  ctx       INTEGER NOT NULL,
  caps_json TEXT NOT NULL DEFAULT '[]',
  cred_ref  TEXT,
  enabled   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE run (
  id                TEXT PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES workflow_version(id) ON DELETE SET NULL,
  draft_rev         INTEGER,
  status            TEXT NOT NULL,
  inputs_json       TEXT NOT NULL DEFAULT '{}',
  env_snapshot_json TEXT NOT NULL DEFAULT '{}',
  current_node      TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  -- 子工作流以独立 Run 表达，审批冒泡到父运行
  parent_run_id     TEXT REFERENCES run(id) ON DELETE CASCADE
);

CREATE TABLE run_event (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  type            TEXT NOT NULL,
  node_id         TEXT,
  attempt         INTEGER,
  actor           TEXT NOT NULL,
  status          TEXT,
  summary         TEXT NOT NULL,
  payload_ref     TEXT,
  artifact_refs   TEXT NOT NULL DEFAULT '[]',
  parent_event_id TEXT,
  sensitivity     TEXT NOT NULL DEFAULT 'internal',
  schema_ver      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (run_id, seq)
);

-- 恢复点：杀掉 App 后重启，凭它回到同一审批点
CREATE TABLE run_checkpoint (
  run_id                TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq                   INTEGER NOT NULL,
  env_json              TEXT NOT NULL DEFAULT '{}',
  pending_approval_json TEXT,
  session_refs_json     TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE artifact (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE approval (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  request_json  TEXT NOT NULL,
  decision_json TEXT,
  decided_at    TEXT,
  actor         TEXT
);

CREATE TABLE memory (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  scope_id    TEXT,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  summary     TEXT,
  source      TEXT NOT NULL DEFAULT 'user',
  created_by  TEXT NOT NULL DEFAULT 'user',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  expires_at  TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  ver         INTEGER NOT NULL DEFAULT 1,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 凭据只存引用；明文永远在 Keychain 里
CREATE TABLE credential_ref (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  label            TEXT NOT NULL,
  keychain_account TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_tested_at   TEXT
);

-- ── 索引 ────────────────────────────────────────────────────────────────────
CREATE INDEX idx_run_status_started ON run(status, started_at);
CREATE INDEX idx_run_workflow ON run(workflow_id);
CREATE INDEX idx_run_event_run_seq ON run_event(run_id, seq);
CREATE INDEX idx_artifact_run ON artifact(run_id);
CREATE INDEX idx_approval_run ON approval(run_id);
CREATE UNIQUE INDEX idx_memory_scope_key ON memory(scope, IFNULL(scope_id, ''), key);

-- ── 全文检索 ────────────────────────────────────────────────────────────────
-- 写入由 Rust 侧负责（要先对 CJK 做分字，SQLite 内置分词器不切中文）；
-- 删除交给触发器，保证级联删除不留孤儿索引行。
CREATE VIRTUAL TABLE fts_index USING fts5(kind UNINDEXED, ref_id UNINDEXED, text);

CREATE TRIGGER trg_workflow_fts_delete AFTER DELETE ON workflow BEGIN
  DELETE FROM fts_index WHERE kind = 'workflow' AND ref_id = old.id;
END;

CREATE TRIGGER trg_run_event_fts_delete AFTER DELETE ON run_event BEGIN
  DELETE FROM fts_index WHERE kind = 'run_event' AND ref_id = old.id;
END;

CREATE TRIGGER trg_artifact_fts_delete AFTER DELETE ON artifact BEGIN
  DELETE FROM fts_index WHERE kind = 'artifact' AND ref_id = old.id;
END;
