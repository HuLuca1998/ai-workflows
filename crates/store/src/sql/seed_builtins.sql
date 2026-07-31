-- 首次启动的内置数据：模型、Agent 角色、提示词、记忆。
--
-- 为什么是迁移而不是「每次启动 upsert 一遍」：
-- 迁移**只跑一次**，正好是这批数据要的语义 ——
--
-- - 用户改了内置角色的目标，下次启动不该被冲回去（图纸说内置角色可改可复制）
-- - 用户删掉一条内置记忆，下次启动不该自己长回来
--   （记忆会注入每一次 AI 调用，那个开关必须是真的）
--
-- 每次启动 upsert 的写法两条都做不到。往后要补新的内置条目，
-- 追加一个新迁移，别改这一个 —— 迁移只增不改。
--
-- **这个文件破过一次例**：它最初种进去的数据不合契约（时间不是 ISO、
-- prompt 的 vars 形状错、memory.source 用了枚举外的值），
-- 界面上「提示词」与「记忆」两页因此整页打不开。改这里只管新库，
-- 所以配了一批 `builtins.v1-fix`（`seed_builtins_fix.sql`）
-- 把已经种过的机器修到同一个终点 —— 分叉消掉了，例外才成立。
-- `seed.rs` 的 `mod 修正批次` 逐字比两条路径的结果。
--
-- id 是**写死的**（`builtin:analyst` 这种），不是随机的：
-- `packages/contracts/src/templates.ts` 的内置模板直接引用它们，
-- 随机 id 会让模板搭出来的图指向不存在的角色。

-- ── 模型 ────────────────────────────────────────────────────────────────────
--
-- 两个 ACP 运行时各一条。只装了其中一个的机器也要能用 ——
-- 「优先 codex」是偏好，不是「绝不用 claude」。
--
-- model_id 写的是 adapter 那边的默认模型名。ACP adapter 用的其实是
-- 你在那个 CLI 里登录的账号所能用的模型，这里登记的是「让哪个 adapter 去跑」。
-- 凭据一列留空：ACP adapter 自己管登录态，这里没有密钥可存 ——
-- 填一个假的 keychain:// 引用会让「凭据只进 Keychain」这条看起来被遵守了，
-- 而实际上根本没有那一环。
-- enabled = 0：这两条的 model_id 是**示例值**，两端 adapter 实测都不认
-- （真实候选见 docs/acp/transcripts/{codex,claude}-model.jsonl，且随版本变）。
-- 启用着的话，引用它们的每个 AI 节点每次运行都写一条 model_downgraded ——
-- 而用户从没选过模型。停用条目不参与解析（executor 的 resolve_model
-- 把「已停用」按「没配」处理），真实清单由「模型」页的 sync 拉取。
INSERT INTO model (id, name, runtime, model_id, effort, ctx, caps_json, cred_ref, enabled,
                   created_at, updated_at)
VALUES
  ('model:codex', 'Codex（本地 ACP）', 'acp.codex', 'gpt-5-codex', 'high', 400000,
   '["text","tools","structured_output"]', NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('model:claude', 'Claude Code（本地 ACP）', 'acp.claude', 'claude-opus-5', 'high', 1000000,
   '["text","tools","structured_output","vision"]', NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ── Agent 角色 ──────────────────────────────────────────────────────────────
--
-- 四个，对应内置模板里那四个 agentProfileId。
--
-- 能力（policy_json）是**逐个收紧**的，不是一律全开：
-- 图纸「05 Agent 角色」写着「权限（引擎强制，Prompt 无法越权）」——
-- 内置角色如果一上来就是 file: read-write + command: any，那句话就是空的。
--
-- runtime 一律 acp.codex：这个应用本身跑在 Claude Code 里开发，
-- 默认用 claude 的 adapter 会与开发环境互相干扰（嵌套会话、共用登录态、同一份配额）。
INSERT INTO agent_profile (id, name, role, goal, persona, runtime, model_ref,
                           fallback_model_ref, tools_json, policy_json,
                           output_contract, turn_limit, timeout_ms, ver, builtin,
                           created_at, updated_at)
VALUES
  ('builtin:analyst', '分析师', '分析',
   '读懂问题，定位根因，给出 2–3 个可选方案，每个都写清风险与验证方式。',
   '只看证据说话。拿不准的地方明说「这里我不确定，需要先确认 X」，'
   || '而不是给一个听起来完整的猜测。方案按「改动面 × 风险」排序，最小的在前。',
   'acp.codex', 'model:codex', 'model:claude',
   '["read_file","search"]',
   -- 分析只读：它不该改任何东西
   '{"file":"read","command":"none","network":"none","memory":"read","secret":[]}',
   '一段根因说明 + 一个方案清单，每个方案含：改动点、风险、怎么验证。',
   12, 900000, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('builtin:builder', '执行者', '执行',
   '按选定方案改代码，小步提交，每一步都能单独验证。',
   '一次只做一件事。改完立刻跑一遍验证命令，红了就地修，不往下堆。'
   || '不确定要不要动的文件先不动，回来问。',
   'acp.codex', 'model:codex', 'model:claude',
   '["read_file","write_file","run_command","search"]',
   -- 执行者要写文件、跑命令，但命令必须是节点里显式声明过的；
   -- network 关着 —— 要联网的活儿由脚本节点显式声明
   '{"file":"read-write","command":"declared","network":"none","memory":"read","secret":[]}',
   '改了哪些文件、每一处为什么改、验证命令与它的输出。',
   24, 1800000, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('builtin:reviewer', '审查者', '审查',
   '只读检查改动：正确性、测试覆盖、风险，按严重度排序，最多 5 条。',
   '挑毛病，但每一条都要能落到具体某一行。说不出「怎么复现」的就不算问题。'
   || '没问题时直接说没问题，不凑数。',
   'acp.codex', 'model:codex', 'model:claude',
   '["read_file","search"]',
   -- 审查是只读的。给它写权限就等于让它顺手把问题「改掉」，
   -- 而那样用户永远看不到那条问题
   '{"file":"read","command":"none","network":"none","memory":"read","secret":[]}',
   '一个问题清单，每条含：严重度、文件与行、怎么复现、建议怎么改。',
   12, 900000, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('builtin:operator', '决策者', '决策',
   '按影响面给出 L1–L3 分级，并说清这一级为什么。',
   '保守。拿不准就往高了报 —— 报高了只是多一次人工确认，报低了是直接放行。',
   'acp.codex', 'model:codex', 'model:claude',
   '["read_file"]',
   '{"file":"read","command":"none","network":"none","memory":"read","secret":[]}',
   '一个等级（L1 / L2 / L3）+ 一句理由 + 需要人工确认的具体事项。',
   8, 600000, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ── 提示词库 ────────────────────────────────────────────────────────────────
--
-- 分段是**有序数组**，不是一坨文本：图纸「06 提示词库」按分段渲染，
-- 每段可单独折叠与编辑。段名沿用 Role / Task / Context / Constraints /
-- Output contract 这套框架。
--
-- 占位符只有 `${…}` 一种形式 —— 引擎的 `interp.rs` 认的是它，
-- 界面 `PromptsPage` 的 extractVars 扫的也是它。写成 `{{…}}` 的话
-- 两边都当它是普通文字：变量页显示「0 变量」而正文里明明有占位符，
-- 运行时那串花括号原样发给 agent。
--
-- `vars` 每项是 `{name, source, onMissing}`（契约 `PromptSchema`）：
-- name **带完整的 `${}`**，界面拿它跟正文里扫出来的占位符逐字比对。
-- source 是给人看的「运行时来源」；onMissing 只有
-- empty_and_log / fail / default 三档。契约里没有「描述」那一列 ——
-- 变量名与它在正文中的上下文承担这件事。
INSERT INTO prompt (id, "group", name, sections_json, vars_json, ver, builtin, updated_at)
VALUES
  ('prompt:analyze-root-cause', '分析', '根因分析',
   json_array(
     json_object('title', 'Role', 'body',
       '你是一名代码分析师。你的判断会被用来决定接下来改什么，所以宁可说「不确定」也不要猜。'),
     json_object('title', 'Task', 'body',
       '读 ${input.target}，定位根因，给出 2–3 个可选方案。'),
     json_object('title', 'Context', 'body',
       '仓库：${input.repo}。相关文件由上游节点提供，不要自己去找无关的部分。'),
     json_object('title', 'Constraints', 'body',
       '只读，不要改任何文件。信息不足时列出缺什么，而不是先给一个完整的猜测。'),
     json_object('title', 'Output contract', 'body',
       '根因一段；方案清单，每个含改动点、风险、验证方式。按改动面从小到大排。')
   ),
   json_array(
     json_object('name', '${input.target}', 'source', '启动表单', 'onMissing', 'fail'),
     json_object('name', '${input.repo}', 'source', '启动表单', 'onMissing', 'empty_and_log')
   ),
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prompt:review-diff', '审查', 'Diff 审查',
   json_array(
     json_object('title', 'Role', 'body',
       '你是一名只读的代码审查者。你不能改代码 —— 发现问题就写清楚，由别人去改。'),
     json_object('title', 'Task', 'body', '审查 ${input.target}，按严重度排序，最多 5 条。'),
     json_object('title', 'Context', 'body', '检查清单：${input.checklist}。'),
     json_object('title', 'Constraints', 'body',
       '每条问题都要能落到具体某一行，并说清怎么复现。说不出复现方式的不算问题，不要凑数。'),
     json_object('title', 'Output contract', 'body',
       '问题清单：严重度、文件与行、复现方式、建议改法。没问题就直接说没问题。')
   ),
   json_array(
     json_object('name', '${input.target}', 'source', '启动表单', 'onMissing', 'fail'),
     json_object('name', '${input.checklist}', 'source', '启动表单', 'onMissing', 'empty_and_log')
   ),
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prompt:fix-by-plan', '执行', '按方案修复',
   json_array(
     json_object('title', 'Role', 'body', '你是一名执行者，按已经定好的方案改代码。'),
     json_object('title', 'Task', 'body', '按 ${input.plan} 修改代码，小步提交。'),
     json_object('title', 'Context', 'body', '工作目录是一个独立的 git worktree，改动不影响主分支。'),
     json_object('title', 'Constraints', 'body',
       '每改一步跑一遍 ${input.verify}。红了就地修，不要往下堆。方案没覆盖到的文件先别动。'),
     json_object('title', 'Output contract', 'body', '改了哪些文件、每处为什么改、验证命令与输出。')
   ),
   json_array(
     json_object('name', '${input.plan}', 'source', '启动表单', 'onMissing', 'fail'),
     json_object('name', '${input.verify}', 'source', '启动表单', 'onMissing', 'empty_and_log')
   ),
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prompt:decide-risk', '决策', '风险分级',
   json_array(
     json_object('title', 'Role', 'body', '你负责判断一次改动的影响面，决定要不要人工确认。'),
     json_object('title', 'Task', 'body', '给 ${input.target} 一个 L1–L3 的等级。'),
     json_object('title', 'Context', 'body',
       'L1：只影响本地、可随时撤销。L2：影响本仓库但未对外。L3：对外部世界有写操作（push / PR / 发布 / 删除）。'),
     json_object('title', 'Constraints', 'body',
       '拿不准往高了报。报高了只是多一次人工确认，报低了是直接放行。'),
     json_object('title', 'Output contract', 'body', '等级 + 一句理由 + 需要人工确认的具体事项。')
   ),
   json_array(json_object('name', '${input.target}', 'source', '启动表单', 'onMissing', 'fail')),
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ── 记忆 ────────────────────────────────────────────────────────────────────
--
-- 会被注入后续每一次 AI 调用。所以这里放的必须是**普遍成立的约定**，
-- 不是某一次任务的细节 —— 后者应该由节点配置带进去。
--
-- source 是 'system'：契约（`MemorySchema`）只认 user / ai_proposed / system
-- 三档。这里曾经写 'builtin' —— 界面上「记忆」整页因此加载不出来，
-- 报的是「memory.list 的返回值不合契约」。
-- 「这条是随应用带来的」由 created_by = 'system' 表达，信息没丢。
INSERT INTO memory (id, scope, scope_id, key, value, summary, source, created_by,
                    created_at, updated_at, expires_at, sensitivity, ver, tags_json, enabled)
VALUES
  ('memory:builtin:small-steps', 'workspace', NULL,
   '小步可验证',
   '改动分成能单独验证的小步。一次提交只做一件事，改完立刻跑验证命令；'
   || '红了就地修，不要把失败往下堆。',
   '改动分小步，每步可验证', 'system', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'internal', 1,
   json_array('工作方式'), 1),

  ('memory:builtin:say-unsure', 'workspace', NULL,
   '不确定就说不确定',
   '信息不足时列出「缺什么」，不要给一个听起来完整的猜测。'
   || '一个标着「不确定」的结论比一个自信的错误有用得多。',
   '拿不准时明说，不要猜', 'system', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'internal', 1,
   json_array('工作方式'), 1),

  ('memory:builtin:external-writes', 'workspace', NULL,
   '外部写操作要先确认',
   'push、建 PR、发布、删除都算对外部世界的写操作，一律先等人确认。'
   || '重试这类操作之前必须先核对外部的实际状态 —— 上一次可能已经成功了一半。'
   -- SQLite 没有 E'\n' 那种转义字面量（那是 PostgreSQL 的），换行用 char(10)
   || char(10)
   -- 边界要说清。只说前半句的话，Agent 会把「在隔离 worktree 里改文件」
   -- 也算进去，然后只做只读检查就交差 —— 端到端验证里真的发生过一次：
   -- 同一个修复节点，一次真的改了代码并提交，另一次「我先只做只读检查」
   || '**本地改文件、在隔离 worktree 里提交，不算外部写操作** —— '
   || '那正是你被派来做的事，放手做。',
   'push / PR / 删除等外部写操作需人工确认；本地改动不算', 'system', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'internal', 1,
   json_array('安全'), 1),

  ('memory:builtin:secrets', 'workspace', NULL,
   '凭据只用引用',
   '任何密钥、令牌、密码都以 keychain:// 引用出现，不要把明文写进配置、'
   || '脚本、提交信息或输出。已经看到明文的话，在输出里替换成 ***。',
   '密钥只用 keychain:// 引用，明文永不落库', 'system', 'system',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'internal', 1,
   json_array('安全'), 1);
