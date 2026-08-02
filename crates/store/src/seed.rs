//! 随应用附带的内置数据。
//!
//! **不在 `Store::open` 里跑。** 打开一个数据库与初始化一个工作区是两件事：
//! 前者是每个工作线程都要做的（每人一条连接），后者一辈子只做一次。
//! 混在一起的话，存储层的每一条「列表返回几条」的测试都得先绕开
//! 四个内置角色 —— 而那些测试问的是分页与搜索，与内置什么无关。
//!
//! 应用入口（桌面壳、开发桥接、MCP 二进制）走 [`Store::open_workspace`]。
//!
//! 「一次」的语义是认真的：
//! - 用户改了内置角色的目标，下次启动不该被冲回去（图纸说内置角色可改可复制）
//! - 用户删了一条内置记忆，下次启动不该自己长回来
//!   （记忆会注入每一次 AI 调用，那个开关必须是真的）
//!
//! 所以判据是 `bootstrap` 表里「这批种过没有」，不是「现在长得对不对」。

use rusqlite::Connection;

use crate::Result;

/// 一个批次种什么。
///
/// 多数是一段 SQL。示例工作流是例外：它的图是**生成物**
/// （见 `sample.rs`），塞进 `.sql` 就等于把生成物抄进源码。
enum Body {
    Sql(&'static str),
    Code(fn(&Connection) -> Result<()>),
}

/// (批次名, 内容)。**只增不改** —— 与迁移同一条规矩：
/// 改一个已经发出去的批次，只会让老库与新库分叉，而且不会有人发现。
const BATCHES: &[(&str, Body)] = &[
    (
        "builtins.v1",
        Body::Sql(include_str!("sql/seed_builtins.sql")),
    ),
    // v1 种进去的数据不合契约（时间不是 ISO、prompt 的 vars 形状错、
    // memory.source 用了枚举外的值），界面上「提示词」与「记忆」两页
    // 因此整页打不开。v1 本身已经改对，但那只管新库 ——
    // 已经种过的机器靠这一批把旧数据修回去。
    //
    // 这是「只增不改」的一个**有意例外**：v1 改了，同时用这一批
    // 消掉由此产生的老库/新库分叉。两条路径的终点逐字一致，
    // `seed_fix_test.rs` 压着这件事。
    (
        "builtins.v1-fix",
        Body::Sql(include_str!("sql/seed_builtins_FIX.sql")),
    ),
    ("sample.v1", Body::Code(crate::sample::seed_sample)),
    // 内置角色的降级模型曾指向跨 runtime 的 model:claude（角色是 codex）——
    // 界面按 runtime 过滤后显示「不降级」，引擎也没法把 claude 的模型
    // 交给 codex 的 adapter（第 5 轮实测 P3）。只清「还保持坏形态」的：
    // 用户改成过别的值就不碰
    (
        "builtins.v2-fallback-fix",
        Body::Sql(
            "UPDATE agent_profile SET fallback_model_ref = NULL
             WHERE id LIKE 'builtin:%' AND runtime = 'acp.codex'
               AND fallback_model_ref = 'model:claude';",
        ),
    ),
    // sample.v1 的图曾带坏脚本（$ISSUE 环境变量，引擎注入的叫 AIWF_*）。
    // 生成物早已修好，这一批把老库里「从未被用户动过」的样例修到同一终点。
    // 与 builtins.v1-fix 同一条理由与同一份克制：用户动过的一概不碰。
    ("sample.v1-fix", Body::Code(crate::sample::fix_sample)),
    // 出厂的标准工作流。示例那一条（sample.v1）留着不动 ——
    // 它是「一键初始化之后立刻有一条能点开的东西」，
    // 而这一批是「一套能直接用的标准流程」，两件事
    (
        "builtin-workflows.v1",
        Body::Code(crate::builtin_workflows::seed_builtin_workflows),
    ),
];

/// 把没种过的批次种上。
pub(crate) fn seed(conn: &Connection) -> Result<()> {
    for (name, batch) in BATCHES {
        let seeded: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bootstrap WHERE name = ?1",
            rusqlite::params![name],
            |row| row.get(0),
        )?;
        if seeded > 0 {
            continue;
        }

        // 一个批次一个事务：中途失败时不会留下半批数据，
        // 而记账那一行也不会被写下 —— 下次启动会重来一遍
        conn.execute_batch("BEGIN")?;
        let result = (|| -> Result<()> {
            match batch {
                Body::Sql(sql) => conn.execute_batch(sql)?,
                Body::Code(seed_one) => seed_one(conn)?,
            }
            conn.execute(
                "INSERT INTO bootstrap(name, applied_at) VALUES (?1, ?2)",
                rusqlite::params![name, crate::now_iso()],
            )?;
            Ok(())
        })();

        match result {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(error) => {
                conn.execute_batch("ROLLBACK")?;
                return Err(error);
            }
        }
    }
    Ok(())
}

/// `builtins.v1-fix` 把老库修到与新库同一个终点。
///
/// 这批存在的前提是「v1 改了」——而改一个已经发出去的批次，正是
/// 本模块开头那条「只增不改」禁止的事。允许这个例外的唯一理由是
/// **分叉被消掉了**：老库（v1 原始数据 + fix）与新库（改过的 v1）
/// 逐字一致。下面几条测的就是这句话，不是「fix 跑起来不报错」。
#[cfg(test)]
mod fix_batch {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use rusqlite::Connection;

    const FIX: &str = include_str!("sql/seed_builtins_FIX.sql");

    /// `builtins.v1` 最初发出去的样子。取三条覆盖两种变量个数与记忆的 source。
    ///
    /// 这是**历史快照，不要跟着 v1 一起改** —— 用户机器上躺着的就是它，
    /// 它变了的话这条测试就不再是在测老库了。
    const ORIGINAL_V1: &str = r#"
INSERT INTO prompt (id, "group", name, sections_json, vars_json, ver, builtin, updated_at)
VALUES
  ('prompt:analyze-root-cause', '分析', '根因分析',
   json_array(
     json_object('title', 'Role', 'body',
       '你是一名代码分析师。你的判断会被用来决定接下来改什么，所以宁可说「不确定」也不要猜。'),
     json_object('title', 'Task', 'body',
       '读 {{target}}，定位根因，给出 2–3 个可选方案。'),
     json_object('title', 'Context', 'body',
       '仓库：{{repo}}。相关文件由上游节点提供，不要自己去找无关的部分。'),
     json_object('title', 'Constraints', 'body',
       '只读，不要改任何文件。信息不足时列出缺什么，而不是先给一个完整的猜测。'),
     json_object('title', 'Output contract', 'body',
       '根因一段；方案清单，每个含改动点、风险、验证方式。按改动面从小到大排。')
   ),
   json_array(
     json_object('name', 'target', 'required', json('true'), 'description', '要分析的对象'),
     json_object('name', 'repo', 'required', json('false'), 'description', '仓库路径')
   ),
   1, 1, datetime('now')),

  ('prompt:decide-risk', '决策', '风险分级',
   json_array(
     json_object('title', 'Role', 'body', '你负责判断一次改动的影响面，决定要不要人工确认。'),
     json_object('title', 'Task', 'body', '给 {{target}} 一个 L1–L3 的等级。'),
     json_object('title', 'Context', 'body',
       'L1：只影响本地、可随时撤销。L2：影响本仓库但未对外。L3：对外部世界有写操作（push / PR / 发布 / 删除）。'),
     json_object('title', 'Constraints', 'body',
       '拿不准往高了报。报高了只是多一次人工确认，报低了是直接放行。'),
     json_object('title', 'Output contract', 'body', '等级 + 一句理由 + 需要人工确认的具体事项。')
   ),
   json_array(json_object('name', 'target', 'required', json('true'), 'description', '要分级的改动')),
   1, 1, datetime('now'));

INSERT INTO memory (id, scope, scope_id, key, value, summary, source, created_by,
                    created_at, updated_at, expires_at, sensitivity, ver, tags_json, enabled)
VALUES
  ('memory:builtin:small-steps', 'workspace', NULL,
   '小步可验证',
   '改动分成能单独验证的小步。一次提交只做一件事，改完立刻跑验证命令；'
   || '红了就地修，不要把失败往下堆。',
   '改动分小步，每步可验证', 'builtin', 'system',
   datetime('now'), datetime('now'), NULL, 'internal', 1,
   json_array('工作方式'), 1);
"#;

    fn empty_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::migrate(&conn).unwrap();
        conn
    }

    /// 已经启动过应用的机器：种的是原始 v1，这次启动补上修正批次。
    fn old_db() -> Connection {
        let conn = empty_db();
        conn.execute_batch(ORIGINAL_V1).unwrap();
        conn.execute_batch(FIX).unwrap();
        conn
    }

    /// 全新安装：v1 已经是改对的那份，修正批次跟着跑一遍（应当是空转）。
    fn new_db() -> Connection {
        let conn = empty_db();
        conn.execute_batch(include_str!("sql/seed_builtins.sql"))
            .unwrap();
        conn.execute_batch(FIX).unwrap();
        conn
    }

    fn get(conn: &Connection, sql: &str) -> String {
        conn.query_row(sql, [], |row| row.get::<_, String>(0))
            .unwrap()
    }

    #[test]
    fn 老库与新库的提示词逐字一致() {
        let (old, fresh) = (old_db(), new_db());

        for id in ["prompt:analyze-root-cause", "prompt:decide-risk"] {
            for col in ["sections_json", "vars_json"] {
                let sql = format!("SELECT {col} FROM prompt WHERE id = '{id}'");
                assert_eq!(
                    get(&old, &sql),
                    get(&fresh, &sql),
                    "{id} 的 {col} 两条路径不一致 —— 分叉没消掉，\
                     那「只增不改」的例外就不成立了"
                );
            }
        }
    }

    #[test]
    fn 老库与新库的记忆逐字一致() {
        let (old, fresh) = (old_db(), new_db());
        let sql = "SELECT source || '|' || created_by || '|' || value
                     FROM memory WHERE id = 'memory:builtin:small-steps'";
        assert_eq!(get(&old, sql), get(&fresh, sql));
    }

    #[test]
    fn 占位符换成了引擎认得的形式() {
        let old = old_db();
        let text = get(
            &old,
            "SELECT sections_json FROM prompt WHERE id = 'prompt:analyze-root-cause'",
        );
        // `{{target}}` 引擎与界面都当它是普通文字 —— 变量页显示「0 变量」，
        // 运行时那串花括号原样发给 agent
        assert!(text.contains("${input.target}"), "{text}");
        assert!(text.contains("${input.repo}"), "{text}");
        assert!(!text.contains("{{"), "还留着旧形式：{text}");
    }

    #[test]
    fn 变量表变成契约要的形状() {
        let old = old_db();
        let vars = get(
            &old,
            "SELECT vars_json FROM prompt WHERE id = 'prompt:analyze-root-cause'",
        );
        assert!(vars.contains(r#""name":"${input.target}""#), "{vars}");
        // required: true → fail；false → empty_and_log
        assert!(vars.contains(r#""onMissing":"fail""#), "{vars}");
        assert!(vars.contains(r#""onMissing":"empty_and_log""#), "{vars}");
        // 契约里没有这两列，Zod 会静默剥掉 —— 留着只会让人以为它们有用
        assert!(!vars.contains("required"), "{vars}");
        assert!(!vars.contains("description"), "{vars}");
    }

    #[test]
    fn 时间补成了_iso8601() {
        let old = old_db();
        for sql in [
            "SELECT updated_at FROM prompt WHERE id = 'prompt:decide-risk'",
            "SELECT created_at FROM memory WHERE id = 'memory:builtin:small-steps'",
            "SELECT updated_at FROM memory WHERE id = 'memory:builtin:small-steps'",
        ] {
            let value = get(&old, sql);
            assert!(
                value.contains('T') && value.ends_with('Z'),
                "{sql} 拿到的还是 SQLite 格式：{value}"
            );
        }
    }

    #[test]
    fn 跑第二遍什么都不动() {
        // 这批会在每台机器上跑一次，但用户可能手动重置过工作区 ——
        // 不幂等的话第二遍会把 `${input.target}` 再套一层
        let old = old_db();
        let before = get(
            &old,
            "SELECT sections_json || vars_json || updated_at FROM prompt
              WHERE id = 'prompt:analyze-root-cause'",
        );

        old.execute_batch(FIX).unwrap();

        let after = get(
            &old,
            "SELECT sections_json || vars_json || updated_at FROM prompt
              WHERE id = 'prompt:analyze-root-cause'",
        );
        assert_eq!(before, after, "修正批次不幂等");
    }

    #[test]
    fn 用户自己的数据一个字都不动() {
        // 「改坏数据的格式」与「覆盖用户写过的内容」是两回事。
        // 这批带的 WHERE 条件全部是为了这句话。
        let conn = empty_db();
        conn.execute_batch(
            r#"
INSERT INTO prompt (id, "group", name, sections_json, vars_json, ver, builtin, updated_at)
VALUES ('prompt:mine', '我的', '我写的',
        json_array(json_object('title', 'Task', 'body', '处理 {{手动写的花括号}}')),
        json_array(json_object('name', '${input.x}', 'source', '我填的', 'onMissing', 'fail')),
        1, 0, '2026-01-01T00:00:00.000Z');

INSERT INTO memory (id, scope, scope_id, key, value, summary, source, created_by,
                    created_at, updated_at, expires_at, sensitivity, ver, tags_json, enabled)
VALUES ('memory:mine', 'workspace', NULL, '我的记忆', '正文', NULL, 'user', '本地用户',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'internal', 1, '[]', 1);
"#,
        )
        .unwrap();

        let snapshot = |c: &Connection| {
            (
                get(
                    c,
                    "SELECT sections_json || vars_json || updated_at FROM prompt WHERE id = 'prompt:mine'",
                ),
                get(
                    c,
                    "SELECT source || created_at FROM memory WHERE id = 'memory:mine'",
                ),
            )
        };
        let before = snapshot(&conn);
        conn.execute_batch(FIX).unwrap();
        assert_eq!(before, snapshot(&conn), "修正批次动了用户自己的数据");
    }
}
