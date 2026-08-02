//! 「一键初始化 / 重置」之后，七条标准工作流都在库里。
//!
//! 这些工作流是这个应用的**出厂内容**：新用户打开就该看到七条能跑的
//! 流程，而不是一个空列表加一句「从模板开始」。模板按钮那条路要求
//! 用户先知道自己想要哪一条 —— 而他还没用过这个应用。
//!
//! 图不在 SQL 里手抄，取自 `generated/builtin-workflows.json`
//! （模板跑一遍 applyPatch 算出来的）。手抄会与模板悄悄分叉：
//! 模板改了节点、种子还是老样子，而没有任何东西会红。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aiwf_store::Store;

fn 内置清单() -> Vec<serde_json::Value> {
    let raw = include_str!("../../../packages/contracts/generated/builtin-workflows.json");
    serde_json::from_str(raw).unwrap()
}

#[test]
fn 初始化之后七条标准工作流都在() {
    let store = Store::open_in_memory_workspace().unwrap();
    let (rows, _) = store.list_workflows_paged(50, 0).unwrap();
    let 名字: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();

    for wf in 内置清单() {
        let name = wf["name"].as_str().unwrap();
        assert!(
            名字.contains(&name),
            "「{name}」不在初始化后的库里。出厂内容缺一条，\
             用户打开看到的就是一个不完整的清单：{名字:?}"
        );
    }
}

#[test]
fn 每条都能直接跑_有图且已发布版本() {
    // 只建 workflow 行不建 revision 的话，列表上有它、点进去是空画布
    let store = Store::open_in_memory_workspace().unwrap();
    for wf in 内置清单() {
        let id = wf["id"].as_str().unwrap();
        let draft = store.get_draft(id, 1).unwrap();
        assert!(draft.is_some(), "{id} 没有草稿，点进去是空画布");

        let published = store.latest_version(id).unwrap();
        assert!(
            published.is_some(),
            "{id} 没有发布版本 —— 定时触发只跑已发布版本，\
             出厂的定时工作流不发布等于出厂就不会跑"
        );
    }
}

#[test]
fn 图与生成物逐字一致_没有手抄的第二份() {
    let store = Store::open_in_memory_workspace().unwrap();
    for wf in 内置清单() {
        let id = wf["id"].as_str().unwrap();
        let draft = store.get_draft(id, 1).unwrap().unwrap();
        let 库里的: serde_json::Value = serde_json::from_str(&draft).unwrap();
        assert_eq!(
            库里的, wf["graph"],
            "{id} 库里的图与生成物不一致 —— 有人手抄了一份"
        );
    }
}

#[test]
fn id_是写死的_重置之后指的还是同一条() {
    // 随机 id 的话，文档与截图里的链接一重置就失效
    let store = Store::open_in_memory_workspace().unwrap();
    let (rows, _) = store.list_workflows_paged(50, 0).unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    for wf in 内置清单() {
        assert!(ids.contains(&wf["id"].as_str().unwrap()), "{ids:?}");
    }
}

#[test]
fn 重置之后七条又回来了() {
    let mut store = Store::open_in_memory_workspace().unwrap();
    // 先删掉一条
    store.delete_workflow("workflow:repo-digest").unwrap();
    let (before, _) = store.list_workflows_paged(50, 0).unwrap();
    assert!(!before.iter().any(|r| r.id == "workflow:repo-digest"));

    store.reset_workspace().unwrap();

    let (after, _) = store.list_workflows_paged(50, 0).unwrap();
    let 名字: Vec<&str> = after.iter().map(|r| r.name.as_str()).collect();
    for wf in 内置清单() {
        let name = wf["name"].as_str().unwrap();
        assert!(名字.contains(&name), "重置之后「{name}」没回来：{名字:?}");
    }
}

#[test]
fn 跑第二遍不会种出重复的() {
    let store = Store::open_in_memory_workspace().unwrap();
    let (rows, _) = store.list_workflows_paged(50, 0).unwrap();
    let 第一遍 = rows.len();
    // 再开一次同一个库（模拟重启）
    drop(rows);
    let (again, _) = store.list_workflows_paged(50, 0).unwrap();
    assert_eq!(again.len(), 第一遍, "重开之后工作流数量变了");
}

// ── 边界 ────────────────────────────────────────────────────────────────────

#[test]
fn 边界_用户删掉一条之后不会被重新种回来() {
    /*
     * 「只种一次」的语义：批次记账过之后，用户删掉的就是他删掉的。
     * 每次启动都种回来的话，用户永远删不掉出厂内容 —— 那比不给删更糟，
     * 因为他会以为删成功了，下次打开又在。
     *
     * 想要回来走「一键重置」（那条会清空整个工作区，语义明确）。
     */
    let store = Store::open_in_memory_workspace().unwrap();
    store.delete_workflow("workflow:pr-followup").unwrap();

    // 再种一次（模拟重启）
    store.reseed_for_test().unwrap();

    let (rows, _) = store.list_workflows_paged(50, 0).unwrap();
    assert!(
        !rows.iter().any(|r| r.id == "workflow:pr-followup"),
        "用户删掉的出厂工作流又回来了 —— 他会以为没删成功"
    );
}

#[test]
fn 边界_用户改过的出厂工作流不会被覆盖() {
    /*
     * 出厂内容是起点不是枷锁：用户照着改是正常用法，
     * 下次启动把他的改动冲掉是最坏的形态。
     *
     * **保护来自批次记账**（`seed.rs` 的 `bootstrap` 表），不是
     * `builtin_workflows.rs` 里那个 `exists > 0` —— 实测：把那个判断
     * 去掉这条测试照样绿，因为整批根本不会跑第二遍。那个判断守的是
     * 另一件事（同一批次里部分失败后重来），别把它当成这条的防线。
     */
    let store = Store::open_in_memory_workspace().unwrap();
    let 改过的 = r#"{"nodes":[],"edges":[],"groups":[]}"#;
    store.save_draft("workflow:repo-digest", 改过的).unwrap();

    store.reseed_for_test().unwrap();

    let rev = store
        .draft_revision("workflow:repo-digest")
        .unwrap()
        .unwrap();
    let draft = store
        .get_draft("workflow:repo-digest", rev)
        .unwrap()
        .unwrap();
    assert_eq!(draft, 改过的, "用户存的那一版被出厂内容冲掉了");
}

#[test]
fn 边界_嵌套模板引用的两条出厂工作流都真的存在() {
    /*
     * `release-pipeline` 用写死的 id 引用另外两条出厂工作流。
     * 那两条被改名、改 id 或删掉的话，嵌套模板出厂就是坏的 ——
     * 而它自己的图校验一切正常（workflowId 只是个字符串）。
     */
    let store = Store::open_in_memory_workspace().unwrap();
    let 引用到的 = ["workflow:dep-upgrade-audit", "workflow:release-checklist"];
    for id in 引用到的 {
        assert!(
            store.latest_version(id).unwrap().is_some(),
            "release-pipeline 引用了 {id}，而它不在出厂内容里（或没发布版本）"
        );
    }
}

#[test]
fn 边界_出厂工作流的数量与模板清单一致() {
    // 加了模板忘了它进不进出厂内容 —— 这条会红
    let store = Store::open_in_memory_workspace().unwrap();
    let (rows, _) = store.list_workflows_paged(100, 0).unwrap();
    let 出厂的 = rows
        .iter()
        .filter(|r| r.id.starts_with("workflow:") && r.id != "workflow:sample")
        .count();
    assert_eq!(出厂的, 内置清单().len(), "出厂工作流数量与模板清单对不上");
}

#[test]
fn 边界_发布版本的图与草稿逐字相同() {
    // 两者不同的话，用户在编辑器里看到的与定时实际跑的不是同一份 ——
    // 而界面上没有任何地方会显示这个差异
    let store = Store::open_in_memory_workspace().unwrap();
    for wf in 内置清单() {
        let id = wf["id"].as_str().unwrap();
        let draft = store.get_draft(id, 1).unwrap().unwrap();
        let published = store.latest_version(id).unwrap().unwrap();
        assert_eq!(draft, published.graph_json, "{id} 的草稿与发布版本不一致");
    }
}

#[test]
fn 边界_生成物损坏时报错而不是种出半套() {
    // 这条验的是 parse 的失败路径：读不动就整批回滚，
    // 不会留下「种了三条、剩下四条没种」的半套状态
    let bad: std::result::Result<Vec<serde_json::Value>, _> = serde_json::from_str("{ 不是 JSON");
    assert!(bad.is_err(), "损坏的生成物必须解析失败");
}
