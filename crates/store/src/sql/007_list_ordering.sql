-- Agent 与模型的时间戳。
--
-- 列表原来按名字排，新建的东西会被埋在中间某一页 ——
-- 而用户刚建完最想看到的就是它。
--
-- 已有行填 created_at 为迁移时刻：它们的真实创建时间没有记录，
-- 而给一个假的具体时间比给同一个时刻更误导。
ALTER TABLE agent_profile ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profile ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE model ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE model ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE agent_profile SET created_at = datetime('now'), updated_at = datetime('now')
  WHERE created_at = '';
UPDATE model SET created_at = datetime('now'), updated_at = datetime('now')
  WHERE created_at = '';

CREATE INDEX idx_agent_updated ON agent_profile(updated_at DESC);
CREATE INDEX idx_model_updated ON model(updated_at DESC);
