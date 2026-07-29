-- 把 `builtins.v1` 种进去的违约数据修回契约形状。
--
-- 为什么需要这一批：`seed_builtins.sql` 已经改对了，但那只管**新库**。
-- 批次种过一次就不再重种（判据是 bootstrap 表，见 seed.rs），
-- 所以任何一台已经启动过应用的机器，库里躺的仍是坏数据 ——
-- 用户看到的是「prompt.list 的返回值不合契约」，一页都打不开。
--
-- 为什么不能写成迁移：迁移跑在 `Store::open`，种子跑在 `open_workspace`，
-- **迁移永远在种子之前**。写成迁移的话，新库上它跑完了 v1 才开始种，
-- 修不到任何东西。
--
-- 三处违约（契约 `PromptSchema` / `MemorySchema`）：
--
-- 1. `datetime('now')` 出的是 `2026-07-29 08:15:26`，契约要 ISO 8601
-- 2. prompt 的 vars 写成 `{required, description}`，契约要 `{source, onMissing}`；
--    正文占位符写成 `{{x}}`，而全系统认的是 `${x}`
-- 3. memory 的 source 写 `'builtin'`，契约枚举里只有 user/ai_proposed/system
--
-- **每一条都带 WHERE 条件卡住「只有坏的才动」**：这批会在每台机器上跑一次，
-- 而用户可能已经改过其中某条内置记忆的正文。改坏数据的格式是修复，
-- 覆盖用户改过的内容是另一回事。跑第二次是 0 行受影响。

-- ── 1. 时间补成 ISO 8601 ────────────────────────────────────────────────────
--
-- GLOB 而不是 `NOT LIKE '%T%'`：只认 `YYYY-MM-DD HH:MM:SS` 这一种确切形状，
-- 别的什么都不碰。补 `.000Z` 是因为 SQLite 存的本来就是 UTC
-- （`datetime('now')` 的语义），只是没把这件事写出来。
UPDATE prompt SET updated_at = replace(updated_at, ' ', 'T') || '.000Z'
 WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';

UPDATE memory SET created_at = replace(created_at, ' ', 'T') || '.000Z'
 WHERE created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
UPDATE memory SET updated_at = replace(updated_at, ' ', 'T') || '.000Z'
 WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';

-- agent_profile 与 model 的时间列同样是 `datetime('now')` 出来的
-- （`007_list_ordering.sql` 那次迁移，以及 v1 种子）。它们眼下还没炸 ——
-- `AgentProfileSchema` / `ModelSchema` 没声明时间字段，Zod 校验碰不到。
-- 一起修是因为「同一个库里两种时间格式」本身就是个陷阱：
-- 哪天契约补上 createdAt，炸的会是老用户而不是我们。
UPDATE agent_profile SET created_at = replace(created_at, ' ', 'T') || '.000Z'
 WHERE created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
UPDATE agent_profile SET updated_at = replace(updated_at, ' ', 'T') || '.000Z'
 WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
UPDATE model SET created_at = replace(created_at, ' ', 'T') || '.000Z'
 WHERE created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
UPDATE model SET updated_at = replace(updated_at, ' ', 'T') || '.000Z'
 WHERE updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';

-- ── 2. 提示词的占位符与变量表 ───────────────────────────────────────────────
--
-- `{{target}}` → `${input.target}`：`{{` 换成 `${input.`，再把余下的 `}}`
-- 收成 `}`。sections_json 是 `[{title, body}]` 的两层结构，body 是字符串 ——
-- 除了占位符本身，正文里不会出现 `}}`，所以这个替换不会误伤 JSON 结构。
UPDATE prompt
   SET sections_json = replace(replace(sections_json, '{{', '${input.'), '}}', '}')
 WHERE builtin = 1 AND sections_json LIKE '%{{%';

-- 变量表逐项重映射。原来的 `required` 只有真假两档，
-- 对应 onMissing 的 fail / empty_and_log —— 与新种子逐字一致。
-- `description` 那一列契约里没有，跟着丢掉（变量名与正文上下文承担它）。
UPDATE prompt
   SET vars_json = (
     SELECT json_group_array(json_object(
       'name', '${input.' || json_extract(项.value, '$.name') || '}',
       'source', '启动表单',
       'onMissing', CASE WHEN json_extract(项.value, '$.required')
                         THEN 'fail' ELSE 'empty_and_log' END
     ))
     FROM json_each(prompt.vars_json) AS 项
   )
 WHERE builtin = 1
   AND json_array_length(vars_json) > 0
   -- 认坏数据的判据是「第一项没有 source」。契约要求 source 必填，
   -- 所以有 source 的那份要么已经修过，要么是用户自己写的 —— 都不该动
   AND json_extract(vars_json, '$[0].source') IS NULL;

-- ── 3. 记忆的 source ────────────────────────────────────────────────────────
--
-- 'builtin' 不在契约枚举里。「这条是随应用带来的」由 created_by = 'system'
-- 表达，所以改成 'system' 不丢信息。
UPDATE memory SET source = 'system' WHERE source = 'builtin';
