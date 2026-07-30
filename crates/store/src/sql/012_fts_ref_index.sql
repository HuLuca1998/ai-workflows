-- 让 FTS 的级联删除不再全表扫。
--
-- `fts_index` 的 kind / ref_id 都是 UNINDEXED（FTS5 里那意味着「存但不建索引」），
-- 而三个删除触发器的条件正是 `WHERE kind = ? AND ref_id = ?` ——
-- **每删一条事件全扫一遍整个 FTS 表**。
--
-- 实测（40,000 条索引行、逐条删 2,000 条，就是删掉一条工作流时
-- 触发器真实的形态）：**9.76 秒**。按一年日用量的库（73,000 条事件）
-- 删一条含 3,640 条事件的工作流是 50 秒量级。
--
-- 而 SQLite 是单写者、busy_timeout 只有 5 秒：这一条语句占着写锁的几十秒里，
-- MCP 的 8 条连接、桌面主连接、主管 AI 那条、正在执行的运行的 append_event
-- 全部失败。`workflow_delete` 界面上没有入口，但它对 MCP 开放 ——
-- 主管 AI 想「清理一下」就能把应用冻住，同时把正在跑的运行的事件写丢。
--
-- 侧表只做一件事：把 (kind, ref_id) 映射到 FTS 的 rowid，并给它一个真索引。
-- 触发器改成先查 rowid 再按 rowid 删 —— 那是 FTS5 唯一的快路径。
CREATE TABLE fts_ref (
  kind    TEXT    NOT NULL,
  ref_id  TEXT    NOT NULL,
  -- 对应 fts_index 的 rowid。不加外键：虚拟表没有可引用的主键
  fts_rowid INTEGER NOT NULL
);

CREATE INDEX idx_fts_ref ON fts_ref(kind, ref_id);

-- 回填已有的索引行。老库里可能已经有几万条，这一步只在迁移时跑一次
INSERT INTO fts_ref (kind, ref_id, fts_rowid)
  SELECT kind, ref_id, rowid FROM fts_index;

-- 三个触发器改成走侧表。
-- 顺带清掉侧表自己那一行，否则它会变成第二种孤儿
DROP TRIGGER IF EXISTS trg_workflow_fts_delete;
DROP TRIGGER IF EXISTS trg_run_event_fts_delete;
DROP TRIGGER IF EXISTS trg_artifact_fts_delete;

CREATE TRIGGER trg_workflow_fts_delete AFTER DELETE ON workflow BEGIN
  DELETE FROM fts_index WHERE rowid IN
    (SELECT fts_rowid FROM fts_ref WHERE kind = 'workflow' AND ref_id = old.id);
  DELETE FROM fts_ref WHERE kind = 'workflow' AND ref_id = old.id;
END;

CREATE TRIGGER trg_run_event_fts_delete AFTER DELETE ON run_event BEGIN
  DELETE FROM fts_index WHERE rowid IN
    (SELECT fts_rowid FROM fts_ref WHERE kind = 'run_event' AND ref_id = old.id);
  DELETE FROM fts_ref WHERE kind = 'run_event' AND ref_id = old.id;
END;

CREATE TRIGGER trg_artifact_fts_delete AFTER DELETE ON artifact BEGIN
  DELETE FROM fts_index WHERE rowid IN
    (SELECT fts_rowid FROM fts_ref WHERE kind = 'artifact' AND ref_id = old.id);
  DELETE FROM fts_ref WHERE kind = 'artifact' AND ref_id = old.id;
END;
