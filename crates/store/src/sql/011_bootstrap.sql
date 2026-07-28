-- 一次性引导数据的记账表。
--
-- 与 schema_migration 分开：那张表记的是「表结构走到哪一版」，
-- 这张记的是「哪几批随应用附带的数据已经种过了」。混在一起的话，
-- 一次 schema 变更会顺带把内置数据再种一遍。
--
-- **只记名字，不记内容**。用户改了内置角色的目标、删了一条内置记忆，
-- 都不该在下次启动被冲回去 —— 判据是「这批种过没有」，
-- 而不是「现在长得对不对」。
CREATE TABLE bootstrap (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
