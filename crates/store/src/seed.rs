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
enum 内容 {
    Sql(&'static str),
    代码(fn(&Connection) -> Result<()>),
}

/// (批次名, 内容)。**只增不改** —— 与迁移同一条规矩：
/// 改一个已经发出去的批次，只会让老库与新库分叉，而且不会有人发现。
const BATCHES: &[(&str, 内容)] = &[
    (
        "builtins.v1",
        内容::Sql(include_str!("sql/seed_builtins.sql")),
    ),
    ("sample.v1", 内容::代码(crate::sample::seed_sample)),
];

/// 把没种过的批次种上。
pub(crate) fn seed(conn: &Connection) -> Result<()> {
    for (name, 这批) in BATCHES {
        let 种过: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bootstrap WHERE name = ?1",
            rusqlite::params![name],
            |row| row.get(0),
        )?;
        if 种过 > 0 {
            continue;
        }

        // 一个批次一个事务：中途失败时不会留下半批数据，
        // 而记账那一行也不会被写下 —— 下次启动会重来一遍
        conn.execute_batch("BEGIN")?;
        let 结果 = (|| -> Result<()> {
            match 这批 {
                内容::Sql(sql) => conn.execute_batch(sql)?,
                内容::代码(种) => 种(conn)?,
            }
            conn.execute(
                "INSERT INTO bootstrap(name, applied_at) VALUES (?1, ?2)",
                rusqlite::params![name, crate::now_iso()],
            )?;
            Ok(())
        })();

        match 结果 {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(error) => {
                conn.execute_batch("ROLLBACK")?;
                return Err(error);
            }
        }
    }
    Ok(())
}
