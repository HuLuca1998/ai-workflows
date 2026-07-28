-- 主管 AI 的会话与消息。
--
-- 不存的话每次关掉抽屉对话就没了，而用户常常是隔天回来接着问：
-- 「上次它说那个节点为什么会失败来着」。
--
-- 关联对象（workflow / run / model）都可空：不在任何上下文里问的问题
-- （「这个应用怎么用」）也是一次会话。
CREATE TABLE supervisor_session (
  id           TEXT PRIMARY KEY,
  -- 取第一个问题的前几十字。用户靠它认出「上次那条」
  title        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  workflow_id  TEXT REFERENCES workflow(id) ON DELETE SET NULL,
  run_id       TEXT REFERENCES run(id) ON DELETE SET NULL,
  model_ref    TEXT
);

CREATE TABLE supervisor_message (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES supervisor_session(id) ON DELETE CASCADE,
  -- 只有 user 与 agent。系统提示词不进这里 —— 它是实现细节，
  -- 而且每次都可能不同，混进对话会让历史读起来莫名其妙
  role       TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  text       TEXT NOT NULL,
  at         TEXT NOT NULL,
  -- 同一会话内的顺序。按 at 排会在同秒的两条上不稳定
  seq        INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_supervisor_session_updated ON supervisor_session(updated_at DESC);
