-- MCP 写操作的确认队列。
--
-- 「AI 的改动一律先出 Diff，用户确认才落草稿」是这个产品的核心规则。
-- 主管 AI 遵守了（DraftStore.propose），MCP 之前不能遵守 ——
-- 那个进程弹不出应用里的对话框，于是写工具只能整体关掉
-- （AIWF_MCP_ALLOW_WRITE=1 才开，开了就没有确认那一步）。
--
-- 这张表是两个进程之间的信箱：MCP 放一条待确认进来，应用把它显示给用户，
-- 用户决定后 MCP 那边的轮询读到结果。
--
-- **超时默认拒绝**：没人理的写操作不该在几小时后突然生效。
CREATE TABLE mcp_confirmation (
  id         TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  -- 入参原文。用户要看清楚「它到底要改什么」才能决定
  input_json TEXT NOT NULL,
  -- pending / approved / rejected / expired
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX idx_mcp_confirmation_pending
  ON mcp_confirmation(status, created_at);
