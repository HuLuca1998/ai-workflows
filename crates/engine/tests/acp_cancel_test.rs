//! `session/cancel` 是**通知**，不是请求。发错形态等于没取消。
//!
//! ## 这条守的是什么
//!
//! 原实现 `self.request("session/cancel", …)` 带 `id` 发出去，
//! 而 adapter 把它当成一个不认识的**请求**：
//!
//! ```text
//! → {"jsonrpc":"2.0","id":4,"method":"session/cancel","params":{…}}
//! ← {"jsonrpc":"2.0","id":4,"error":{"code":-32601,
//!    "message":"\"Method not found\": session/cancel"}}
//! ```
//!
//! **实测两种形态的差别（codex-acp 1.1.7，scratchpad/cancel-probe.mjs）**：
//!
//! | 形态             | 应答                  | 那一轮                                  |
//! | ---------------- | --------------------- | --------------------------------------- |
//! | 请求（带 id）    | `-32601 Method not found` | **照跑** —— 6 秒里又出了 323 个流式帧 |
//! | 通知（不带 id）  | 无（本来就不该有）    | **7ms 停下**，`stopReason: "cancelled"` |
//!
//! 差一个 `id` 字段，一个是「什么都没发生」，一个是当场停。
//! 而两者在我们这一侧都不报错 —— `cancel()` 的返回值原来还被
//! `let _ =` 丢掉过。
//!
//! ## 判据
//!
//! 不连真 adapter（那要 10 到 30 秒且要登录态）。判据是**写出去的那一行
//! 字节**：`session/cancel` 那条 JSON 里不能有 `id`。
//! 这是协议层面的事实，不依赖某个 adapter 的实现。

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader};

/// 一个假 adapter：把收到的每一行原样抄进文件，并对带 id 的请求回一个空应答。
///
/// 用 shell 脚本而不是 mock 对象 —— 要验的正是「进程边界上写出去的字节」，
/// 在 Rust 结构体上打桩会把那一层跳过去，于是测试测的是我自己的假设。
fn 假_adapter(记录: &std::path::Path) -> std::path::PathBuf {
    let script = 记录.with_extension("sh");
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{}}}}}}' ;;
  esac
done
"#,
            记录.display()
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    std::fs::set_permissions(&script, perms).unwrap();
    script
}

/// 假 adapter 收到的每一行。
fn 收到的行(记录: &std::path::Path) -> Vec<serde_json::Value> {
    let file = std::fs::File::open(记录).unwrap();
    BufReader::new(file)
        .lines()
        .map_while(std::result::Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

#[test]
fn 取消发出去的那一行不带_id_否则_adapter_按未知方法拒掉() {
    let dir = tempfile::tempdir().unwrap();
    let 记录 = dir.path().join("收到.jsonl");
    std::fs::write(&记录, "").unwrap();
    let script = 假_adapter(&记录);

    let mut client = aiwf_engine::acp::AcpClient::connect(
        &script.display().to_string(),
        &[],
        &[],
        std::time::Duration::from_secs(5),
    )
    .expect("假 adapter 连不上");

    client
        .cancel("sess_x")
        .expect("取消不该报错 —— 通知本来就没有应答可等");

    // 进程边界上的字节要先落盘
    drop(client);
    std::thread::sleep(std::time::Duration::from_millis(200));

    let 行 = 收到的行(&记录);
    let 取消 = 行
        .iter()
        .find(|line| {
            line.get("method").and_then(serde_json::Value::as_str) == Some("session/cancel")
        })
        .unwrap_or_else(|| panic!("根本没发出 session/cancel，收到的是：{行:?}"));

    assert!(
        取消.get("id").is_none(),
        "session/cancel 带了 id，adapter 会按未知**请求**拒掉（-32601），\
         那一轮照跑不误 —— 实测 6 秒又出了 323 个流式帧。\
         实际发出的是：{取消}"
    );
}

#[test]
fn 取消不等应答_所以不会被超时拖住() {
    /*
     * 元测试的另一半：形态对了，还要确认它**不等**。
     *
     * 通知没有应答。用 `request` 发的话，那个 loop 会一直
     * `recv_timeout(self.timeout)` —— 而 supervisor 的超时是 180 秒。
     * 用户按下「取消」之后界面要等三分钟才回来，比不取消还糟。
     *
     * 假 adapter 对 session/cancel 什么都不回，所以「很快返回」
     * 就证明了它没在等。
     */
    let dir = tempfile::tempdir().unwrap();
    let 记录 = dir.path().join("收到2.jsonl");
    std::fs::write(&记录, "").unwrap();
    let script = 假_adapter(&记录);

    let mut client = aiwf_engine::acp::AcpClient::connect(
        &script.display().to_string(),
        &[],
        &[],
        // 超时设 30 秒：真等应答的话这条测试至少跑 30 秒
        std::time::Duration::from_secs(30),
    )
    .unwrap();

    let 起 = std::time::Instant::now();
    client.cancel("sess_x").unwrap();
    let 耗时 = 起.elapsed();

    assert!(
        耗时 < std::time::Duration::from_secs(2),
        "取消花了 {耗时:?} —— 它在等一个永远不会来的应答。\
         用户按下取消之后界面要干等到超时"
    );
}

/// 说 60 帧（约 3 秒）然后自己收尾的假 adapter，收到取消就提前停。
///
/// **它真的在说**：`prompt` 那一侧真的在阻塞读，
/// 于是「另一条线程能不能插进去」这件事被真的验到了。
/// 直接返回的假 adapter 会让这条测试在零并发下变绿。
///
/// **为什么要它自己收尾、而不是靠 `prompt` 的超时兜底**：
/// 那个超时是**每条消息**的（`recv_timeout` 在循环里，每收到一条就重置），
/// 不是整轮的。一个说个不停的 adapter 能让 `prompt` 永远挂着 ——
/// 第一版这条测试就是这么挂死的，跑了 10 分钟没结束。
/// 那本身是个真问题，记在 DEBT 里。
fn 话痨_adapter(dir: &std::path::Path) -> std::path::PathBuf {
    let script = dir.join("话痨.sh");
    std::fs::write(
        &script,
        r#"#!/bin/sh
# 说个不停的后台循环，收到取消就停。
# 函数名与变量名用英文 —— sh 不接受非 ASCII 标识符
FLAG=$(mktemp)
babble() {
  n=0
  while [ -f "$FLAG" ] && [ "$n" -lt 60 ]; do
    printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"."}}}}'
    n=$((n+1))
    sleep 0.05
  done
  # 说完自己收尾。不收尾的话没被取消的那一支会永远挂着 ——
  # prompt 的超时是每条消息的，收得到消息就不会触发
  [ -f "$FLAG" ] && printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
}
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}' ;;
    *'"method":"session/prompt"'*)
      babble &
      BABBLE_PID=$! ;;
    *'"method":"session/cancel"'*)
      rm -f "$FLAG"
      wait "$BABBLE_PID" 2>/dev/null
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"cancelled"}}' ;;
  esac
done
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    std::fs::set_permissions(&script, perms).unwrap();
    script
}

#[test]
fn 一轮正在跑时_另一条线程能把它取消掉() {
    /*
     * **这条才是取消按钮真正依赖的那件事。**
     *
     * `prompt` 一跑起来就持着槽位锁不放。走池子的常规路径去取消，
     * 只会阻塞到这一轮自己结束 —— 界面上「已取消」立刻显示，
     * 而 agent 照说不误，配额照烧。
     *
     * 判据是**这一轮真的提前结束了**：不设取消的话话痨 adapter
     * 会一直说下去，`prompt` 撞到 5 秒超时才返回。
     */
    let dir = tempfile::tempdir().unwrap();
    let script = 话痨_adapter(dir.path());

    let pool = aiwf_engine::acp::SessionPool::new(std::time::Duration::from_secs(60));
    let pool = std::sync::Arc::new(pool);

    let 取消线程 = {
        let pool = std::sync::Arc::clone(&pool);
        std::thread::spawn(move || {
            // 等这一轮真的跑起来（登记完取消句柄）
            for _ in 0..100 {
                std::thread::sleep(std::time::Duration::from_millis(20));
                if matches!(pool.cancel("k"), Ok(true)) {
                    return true;
                }
            }
            false
        })
    };

    let 起 = std::time::Instant::now();
    let 结果 = pool.prompt(
        "k",
        || {
            let client = aiwf_engine::acp::AcpClient::connect(
                &script.display().to_string(),
                &[],
                &[],
                std::time::Duration::from_secs(10),
            )?;
            Ok((client, "s".to_string()))
        },
        "说点什么",
        |_| {},
    );
    let 耗时 = 起.elapsed();

    assert!(
        取消线程.join().unwrap(),
        "取消线程一次都没找到正在跑的轮次 —— `arm` 没登记"
    );
    // 不取消的话这一轮要说满 60 帧（约 3 秒）才自己收尾。
    // 取消线程最快在 20ms 就够得着，所以 1.5 秒这条线两边都不贴边
    assert!(
        耗时 < std::time::Duration::from_secs_f64(1.5),
        "这一轮跑了 {耗时:?} —— 取消没让它提前停，它是自己说完 60 帧收尾的。\
         症状就是界面显示「已取消」而 agent 照说不误"
    );
    assert!(
        matches!(结果, Ok(outcome) if format!("{outcome:?}").contains("Cancel")),
        "取消之后 prompt 的收尾原因不是 cancelled"
    );
}

#[test]
fn 没有正在跑的轮次时_取消返回_false_而不是报错() {
    // 用户按取消时那一轮刚好答完，是很正常的时序。
    // 报错的话界面会弹一个红条，而实际上什么问题都没有
    let pool = aiwf_engine::acp::SessionPool::new(std::time::Duration::from_secs(60));
    assert!(matches!(pool.cancel("从来没有过的会话"), Ok(false)));
}
