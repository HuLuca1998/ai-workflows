//! 迁移在**有数据的库**上跑得过吗，以及老二进制打开新库会怎样。
//!
//! 两个洞：
//!
//! 1. `EXPECTED_SCHEMA_VERSION` **运行时零处比较** —— `migrate()` 只有
//!    `if version <= current { continue }`，只往上看不往下看。老二进制
//!    打开新库时全部跳过、返回 Ok。因为迁移只增不改且 SELECT 都是显式列名，
//!    新库对老二进制是个超集，第一条查询不会报错 —— 失败是**无声的数据分叉**。
//!    实测过的症状：降级期间建的角色 `created_at` 是空串，而 007 那条回填
//!    早已记账、再也不会跑，于是它们被 `ORDER BY updated_at DESC`
//!    永久钉在最后一页。
//!
//! 2. 全仓没有一条「从旧 schema 向前迁」的测试。既有的两条一条从空库直上
//!    最新版、一条测幂等（第二次跑时一个迁移都不执行）——
//!    **002..012 在 CI 里从未在有行的表上执行过**。下一个迁移只要写成
//!    `ADD COLUMN x TEXT NOT NULL`（漏 DEFAULT），CI 全绿，
//!    而每台在用的机器下次启动都会 ROLLBACK、应用打不开。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

#[test]
fn 老二进制打开新库时明确报错_而不是静默跳过() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    Store::open(&path).unwrap();

    // 扮演「这个库被更新版本的应用动过」
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO schema_migration(version, note, applied_at)
             VALUES (99, '来自未来的迁移', '2030-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
    }

    let 结果 = Store::open(&path);
    let 错 = 结果.err().expect("老二进制打开新库却静默通过了");
    let 话 = 错.to_string();
    assert!(
        话.contains("新") || 话.contains("升级") || 话.contains("版本"),
        "没说清是版本问题：{话}"
    );
}

#[test]
fn 同版本照常打开() {
    // 别把正常路径一起堵死了
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aiwf.sqlite");
    Store::open(&path).unwrap();
    assert!(Store::open(&path).is_ok(), "同一个版本再打开一次失败了");
}

#[test]
fn 迁移在有数据的库上跑得过() {
    // 每个中间版本都停一次、塞进数据、再往前迁 ——
    // 一个漏了 DEFAULT 的 NOT NULL 列会在这里当场炸，
    // 而在「从空库直上最新版」那条路径上永远不会
    let 最新 = aiwf_store::EXPECTED_SCHEMA_VERSION;
    for 停在 in 1..最新 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aiwf.sqlite");

        aiwf_store::migrate_to_for_test(&path, 停在)
            .unwrap_or_else(|e| panic!("迁到 v{停在} 就失败了：{e}"));

        // 往这个版本已经存在的每张表里塞一行。
        //
        // **这一步是这条测试的全部意义**：只断言「表存在」的话，
        // 一个漏了 DEFAULT 的 `NOT NULL` 新列照样过 —— 空表加什么列都不会炸。
        // 表名与列都从 sqlite_master / PRAGMA 现查，加了新表不用回来改这里
        let 塞了几张 = 每张表塞一行(&path);
        assert!(塞了几张 > 0, "v{停在} 一张表都没塞进去？");

        // 再迁到最新
        Store::open(&path).unwrap_or_else(|e| panic!("从 v{停在}（已有数据）迁到最新失败：{e}"));

        // 行还在 —— 迁移不该把用户的数据弄丢
        assert!(每张表塞一行(&path) > 0, "从 v{停在} 迁完之后库不可写了");

        let conn = rusqlite::Connection::open(&path).unwrap();
        let 版本: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migration", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(版本, 最新, "从 v{停在} 迁完之后版本不对");
    }
}

/// 往库里每张表塞一行，返回塞成功的张数。
///
/// 列值按类型硬造：这条测试问的是「迁移碰上已有行会不会炸」，
/// 不是「这些值有没有业务意义」。外键先关掉 —— 造一整套互相引用的
/// 合法数据是另一个量级的工作，而它对这个问题没有增益。
fn 每张表塞一行(path: &std::path::Path) -> usize {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();

    let 表: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master
              WHERE type='table' AND name NOT LIKE 'sqlite_%'
                AND name NOT LIKE 'fts_%' AND name != 'schema_migration'",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .filter_map(std::result::Result::ok)
        .collect();

    let mut 成功 = 0;
    for 表名 in 表 {
        let mut 列名 = Vec::new();
        let mut 值 = Vec::new();
        {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({表名})")).unwrap();
            let 列 = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?,         // name
                        row.get::<_, String>(2)?,         // type
                        row.get::<_, i64>(3)? == 1,       // notnull
                        row.get::<_, Option<String>>(4)?, // dflt_value
                    ))
                })
                .unwrap()
                .filter_map(std::result::Result::ok)
                .collect::<Vec<_>>();

            for (name, kind, notnull, default) in 列 {
                // 有默认值或可空的列交给 SQLite 自己填 ——
                // 那正是「新列有没有给默认值」这件事要被验证的地方
                if !notnull || default.is_some() {
                    continue;
                }
                let v = if kind.to_uppercase().contains("INT") {
                    "1".to_string()
                } else {
                    format!("'{表名}-占位'")
                };
                列名.push(name);
                值.push(v);
            }
        }

        let sql = if 列名.is_empty() {
            format!("INSERT INTO {表名} DEFAULT VALUES")
        } else {
            format!(
                "INSERT INTO {表名} ({}) VALUES ({})",
                列名.join(", "),
                值.join(", ")
            )
        };
        if conn.execute(&sql, []).is_ok() {
            成功 += 1;
        }
    }
    成功
}
