//! 后台运行管理器。
//!
//! 每个运行一个线程，各自开一条 SQLite 连接（WAL 支持并发读 + 单写者，
//! busy_timeout 兜住偶发写冲突）。共用一把 Mutex 的话，一个跑十分钟的
//! 脚本会把整个界面的查询全卡住。
//!
//! 挂起在审批上的运行**不占线程**：线程直接结束，等审批决定时再起一个新的。
//! 一个用户放着不管三天的审批不该占着一个执行槽。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use aiwf_store::Store;

use crate::runner::{RunError, RunRequest, Runner};

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error(transparent)]
    Run(#[from] RunError),
    #[error("存储错误：{0}")]
    Store(#[from] aiwf_store::StoreError),
    #[error("内部锁已损坏，需要重启应用")]
    Poisoned,
    #[error("运行 {0} 已经在执行中")]
    AlreadyRunning(String),
}

pub type Result<T> = std::result::Result<T, SupervisorError>;

/// 正在执行的运行：一个取消标志，线程在每个节点边界检查它。
type Cancels = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

pub struct Supervisor {
    db_path: PathBuf,
    cancels: Cancels,
    /// 谁把系统通知发出去。桌面壳在 setup 里注入，
    /// 每条运行的后台线程都从这里拿一份。
    notifier: Option<Arc<dyn crate::notify::Notifier>>,
    /// 系统 MCP 的接入点，转给每一条运行的 AI 节点。
    ///
    /// **与 notifier 同一条理由**：由执行宿主注入 —— 引擎不知道
    /// MCP 起在哪个端口、用什么令牌。不接的话 AI 节点建会话时
    /// 发的是空的 `mcpServers`，它能不能用工具就取决于本机
    /// `~/.codex/config.toml` 碰巧指对了没有，而 acp.claude 不读那份。
    mcp: Vec<crate::acp::McpHttpServer>,
    /// AI 节点的实时帧往哪推。与 notifier 一样要跟进后台线程。
    stream: Option<Arc<dyn crate::acp::ChunkSink>>,
}

impl Supervisor {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            cancels: Arc::new(Mutex::new(HashMap::new())),
            notifier: None,
            mcp: Vec::new(),
            stream: None,
        }
    }

    /// 接上系统通知的发送器。桌面壳在 setup 里调它 ——
    /// 不调的话 `notify` 节点会明确报「这个环境发不了」。
    #[must_use]
    /// 把系统 MCP 接给每一条运行的 AI 节点。
    ///
    /// 执行宿主起完 MCP 之后调它。守卫
    /// `crates/engine/tests/node_mcp_reach_test.rs`。
    pub fn with_mcp(mut self, servers: &[crate::acp::McpHttpServer]) -> Self {
        self.mcp = servers.to_vec();
        self
    }

    pub fn with_notifier(mut self, notifier: Arc<dyn crate::notify::Notifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    /// 接上 AI 节点的实时帧通道。
    ///
    /// **与 notifier 同一条理由**：真正跑节点的是 `spawn` 起的后台线程，
    /// 不跟进去的话，一个 AI 节点的帧都推不出来。
    #[must_use]
    pub fn with_stream(mut self, sink: Arc<dyn crate::acp::ChunkSink>) -> Self {
        self.stream = Some(sink);
        self
    }

    /// 建一个接好了通知与实时帧的 Runner。
    fn runner(&self) -> Runner {
        let mut runner = Runner::new().with_mcp(&self.mcp);
        if let Some(notifier) = &self.notifier {
            runner = runner.with_notifier(notifier.clone());
        }
        if let Some(sink) = &self.stream {
            runner = runner.with_stream(sink.clone());
        }
        runner
    }

    /// 启动运行：同步做完 preflight 与建 Run（这样调用方立刻拿到 runId
    /// 或立刻知道图有问题），执行本身丢给后台线程。
    pub fn start(&self, store: &Store, request: RunRequest) -> Result<String> {
        let runner = self.runner();
        let run_id = runner.start(store, request)?;

        // preflight 没过的运行已经是 failed，不必再起线程
        if runner.status(store, &run_id)? == "running" {
            self.spawn(&run_id)?;
        }
        Ok(run_id)
    }

    /// 提交审批决定，并把运行接着跑下去。
    /// 提交审批决定，并把运行接着跑下去。
    ///
    /// Runner 会先校验「现在等的确实是这个节点」——所以连点两次的第二次
    /// 会在那里被拒绝，不会走到 spawn。
    pub fn decide_approval(
        &self,
        store: &Store,
        run_id: &str,
        node_id: &str,
        decision: &str,
    ) -> Result<()> {
        Runner::new().decide_approval(store, run_id, node_id, decision)?;
        if Runner::new().status(store, run_id)? != "running" {
            return Ok(());
        }
        /*
         * **子运行由父运行的线程推进，这里不能再 spawn 一条。**
         *
         * `run_subworkflow` 起的子运行绕过 `Supervisor::start`，
         * 所以它不在 `cancels` 里，`spawn` 那道「已经在跑就别重复起」
         * 的保护看不到它 —— 两条线程同时推进同一条运行，
         * 审批下游的每个节点会执行**两遍**。
         *
         * 实测（独立复核 probe5）：`node.started` 计数
         * `{c_entry:1, c_gate:1, c_do:2, c_end:1}`，副作用文件两行。
         * 模板里那一步是 `git push` + `gh pr create`。
         */
        if store
            .get_run(run_id)?
            .and_then(|row| row.parent_run_id)
            .is_some()
        {
            return Ok(());
        }
        self.spawn(run_id)?;
        Ok(())
    }

    /// 从检查点恢复。
    ///
    /// 只对挂起或已失败的运行有意义；已经在跑的运行重复 spawn 会让
    /// 两个线程抢同一个 Run，那是最难查的一类 bug。
    pub fn resume(&self, store: &Store, run_id: &str) -> Result<()> {
        // 状态校验放在 is_active 之前：一个刚被取消的运行，线程可能还在
        // 收尾（cancels 里还有它），先查 is_active 会直接返回 Ok，
        // 于是「恢复一个已取消的运行」悄悄成功了
        let runner = Runner::new();
        let status = runner.status(store, run_id)?;

        // 只有中断或失败的运行能恢复。
        //
        // succeeded 恢复没有意义；cancelled 恢复会把用户明确停掉的东西
        // 重新跑起来；waiting_approval 需要的是审批决定而不是恢复。
        if !matches!(status.as_str(), "failed" | "interrupted" | "paused") {
            return Err(SupervisorError::Run(crate::runner::RunError::WrongState {
                run_id: run_id.to_string(),
                status,
                action: "恢复",
            }));
        }

        // 已经有线程在推进它就不必再起一个
        if self.is_active(run_id) {
            return Ok(());
        }

        store.set_run_status(run_id, "running", None)?;
        self.spawn(run_id)?;
        Ok(())
    }

    /// 取消：先置标志让线程在下一个节点边界停下，再写 cancelled 事件。
    ///
    /// 顺序反过来的话，线程可能在事件写完后又推进一个节点 ——
    /// 运行记录上就会出现「取消之后还发生了事情」。
    pub fn cancel(&self, store: &Store, run_id: &str) -> Result<()> {
        if let Some(flag) = self.lock_cancels()?.get(run_id) {
            flag.store(true, Ordering::SeqCst);
        }
        Runner::new().cancel(store, run_id)?;
        Ok(())
    }

    /// 这个运行现在是否占着一个执行线程。
    pub fn is_active(&self, run_id: &str) -> bool {
        self.cancels
            .lock()
            .is_ok_and(|cancels| cancels.contains_key(run_id))
    }

    /// 起一个执行线程。**同一个运行只允许有一个。**
    ///
    /// 直接 insert 覆盖的话，重复的审批或并发的 resume 会起出第二个线程：
    /// 两个线程读到同一份 completed 集合、挑中同一个 ready 节点，
    /// 于是同一个脚本执行两遍，副作用也发生两遍。
    /// 而且旧线程结束时按 run_id 直接 remove，会把新线程的取消标志删掉 ——
    /// 新线程仍在跑，却显示 inactive、也取消不了。
    fn spawn(&self, run_id: &str) -> Result<()> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut cancels = self.lock_cancels()?;
            if cancels.contains_key(run_id) {
                return Err(SupervisorError::AlreadyRunning(run_id.to_string()));
            }
            cancels.insert(run_id.to_string(), flag.clone());
        }

        let db_path = self.db_path.clone();
        let cancels = self.cancels.clone();
        let run_id = run_id.to_string();
        let owned_flag = flag.clone();
        // 通知发送器要跟进后台线程 —— **真正跑节点的是这里**。
        // 只给 `start` 那条路径上的 Runner 接上是不够的：那个 Runner
        // 只做 preflight 与建 Run，一个 notify 节点都不会经过它
        let notifier = self.notifier.clone();
        let stream = self.stream.clone();

        std::thread::spawn(move || {
            let mut runner = Runner::new();
            if let Some(notifier) = notifier {
                runner = runner.with_notifier(notifier);
            }
            // 帧通道也要跟进来 —— 这条线程才是真正跑 AI 节点的地方
            if let Some(sink) = stream {
                runner = runner.with_stream(sink);
            }
            // 各自一条连接：跑十分钟的脚本不该卡住界面的查询
            match Store::open(&db_path) {
                Ok(store) => {
                    if let Err(error) = runner.run_until_pause(&store, &run_id, &flag) {
                        // 后台错误必须留下痕迹：吞掉的话运行会永远停在
                        // running 却没有线程在推进它，用户只看到「一直在跑」
                        if let Err(record_error) =
                            record_background_failure(&store, &run_id, &error.to_string())
                        {
                            // 连痕迹都留不下（磁盘满、锁死）—— stderr 是最后一条通道。
                            // 孤儿扫描（store::mark_orphan_runs）下次启动会把它标成 interrupted
                            eprintln!(
                                "运行 {run_id} 失败（{error}），而失败记录也写不进去：{record_error}"
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!("运行 {run_id} 无法打开数据库：{error}");
                }
            }

            // 无论结束还是挂起都释放执行槽 ——
            // 挂在审批上的运行不该占着一个槽，哪怕用户三天不理它。
            // 只移除自己那一份：万一已经被换成别的线程，不能误删它的标志
            if let Ok(mut cancels) = cancels.lock() {
                if cancels
                    .get(&run_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &owned_flag))
                {
                    cancels.remove(&run_id);
                }
            }
        });
        Ok(())
    }

    fn lock_cancels(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>>> {
        self.cancels.lock().map_err(|_| SupervisorError::Poisoned)
    }
}

/// 把后台线程的失败写成事件并让运行进入 failed。
///
/// 不写的话，运行会停在 running 但已经没有线程在推进它 ——
/// 界面显示「运行中」，实际永远不会有下一步，而日志里也没有线索。
/// 把后台线程的失败写进事件流与运行状态。
///
/// 写不进去（磁盘满、锁竞争）时把错误**传播出去**由调用方记日志 ——
/// 这里曾经是两个 `let _ =`：数据库暂时不可写时运行「表面上正常结束」
/// 而事件流缺档，事件流是唯一事实来源，缺了就无法重建（DEBT L-1）。
fn record_background_failure(store: &Store, run_id: &str, message: &str) -> aiwf_store::Result<()> {
    store.append_event(&aiwf_store::NewRunEvent {
        run_id: run_id.to_string(),
        kind: "run.failed".to_string(),
        node_id: None,
        node_label: None,
        attempt: None,
        actor: "engine".to_string(),
        status: None,
        summary: format!("执行线程异常退出：{message}"),
        payload_ref: None,
        artifact_refs: vec![],
        parent_event_id: None,
        sensitivity: "internal".to_string(),
        schema_ver: 1,
        exit_port: None,
    })?;
    store.advance_run_status(run_id, "failed", None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    /// DEBT L-1：这里曾是两个 `let _ =`。数据库暂时不可写时
    /// 失败记录悄悄丢失，运行「表面上正常结束」而事件流缺档。
    /// 把实现改回吞错（返回 Ok），这条会红（已做过元测试）。
    #[test]
    fn 失败记录写不进去时错误要传播出来() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aiwf.sqlite");
        let run_id = {
            let store = Store::open(&path).unwrap();
            let workflow = store.create_workflow("会失败的流程", None).unwrap();
            store.create_run_for_test(&workflow).unwrap()
        };

        // 模拟磁盘满 / 权限丢失：库文件设为只读（目录仍可写）
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        let store = Store::open(&path).unwrap();
        let result = record_background_failure(&store, &run_id, "线程 panic");
        assert!(result.is_err(), "写不进去必须报错，不能悄悄返回成功");
    }

    /// 对照组：库可写时记录成功，事件与状态都落了。
    #[test]
    fn 失败记录可写时事件与状态都落库() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aiwf.sqlite");
        let store = Store::open(&path).unwrap();
        let workflow = store.create_workflow("会失败的流程", None).unwrap();
        let run_id = store.create_run_for_test(&workflow).unwrap();

        record_background_failure(&store, &run_id, "线程 panic").unwrap();

        assert_eq!(
            store.run_status(&run_id).unwrap().as_deref(),
            Some("failed")
        );
        assert!(
            store
                .events(&run_id, 0, 100)
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.failed")
        );
    }
}
