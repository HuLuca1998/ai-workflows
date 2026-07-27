-- Agent 角色补齐契约要求的字段。
--
-- 图纸「05 Agent 角色」的详情区分四块：角色与目标、性格与指令、
-- 模型与 Runtime、权限与工具。原表只有 persona / model_ref / tools / policy，
-- 其余几项没有落点。
--
-- 权限（capabilities）仍放在 policy_json 里：它是一个有嵌套结构的对象，
-- 拆成列会让「引擎强制的权限」这件事散落在七八个字段上，
-- 而它需要作为一个整体被校验。
ALTER TABLE agent_profile ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profile ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profile ADD COLUMN runtime TEXT NOT NULL DEFAULT 'acp.claude';
ALTER TABLE agent_profile ADD COLUMN fallback_model_ref TEXT;
ALTER TABLE agent_profile ADD COLUMN output_contract TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_profile ADD COLUMN turn_limit INTEGER NOT NULL DEFAULT 12;
ALTER TABLE agent_profile ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 900000;
