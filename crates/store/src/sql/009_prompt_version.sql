-- 提示词的版本历史。
--
-- 图纸「06 提示词库」的版本页列的是「v4 · 当前 / 2 天前 · 你 /
-- 加入『信息不足时列出缺什么』约束」，下面还有 v3、v2。
-- 之前只显示当前版本，而那一页底部写着「运行记录会引用当时的提示词版本，
-- 历史结果始终可解释」—— 历史都看不到，那句话就是空的。
--
-- 存的是**旧版本的快照**：prompt 表里那份始终是当前版本，
-- 每次保存把被替换掉的那份挪进来。
CREATE TABLE prompt_version (
  prompt_id     TEXT NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
  ver           INTEGER NOT NULL,
  name          TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  vars_json     TEXT NOT NULL,
  -- 「你」还是「AI 提议」。分不清人改的还是 AI 改的，
  -- 「历史结果可解释」就少了一半
  changed_by    TEXT NOT NULL DEFAULT '你',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (prompt_id, ver)
);
