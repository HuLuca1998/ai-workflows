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
}

impl Supervisor {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 启动运行：同步做完 preflight 与建 Run（这样调用方立刻拿到 runId
    /// 或立刻知道图有问题），执行本身丢给后台线程。
    pub fn start(&self, store: &Store, request: RunRequest) -> Result<String> {
        let runner = Runner::new();
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
        if Runner::new().status(store, run_id)? == "running" {
            self.spawn(run_id)?;
        }
        Ok(())
    }

    /// 从检查点恢复。
    ///
    /// 只对挂起或已失败的运行有意义；已经在跑的运行重复 spawn 会让
    /// 两个线程抢同一个 Run，那是最难查的一类 bug。
    pub fn resume(&self, store: &Store, run_id: &str) -> Result<()> {
        if self.is_active(run_id) {
            return Ok(());
        }
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

        std::thread::spawn(move || {
            // 各自一条连接：跑十分钟的脚本不该卡住界面的查询
            match Store::open(&db_path) {
                Ok(store) => {
                    if let Err(error) = Runner::new().run_until_pause(&store, &run_id, &flag) {
                        // 后台错误必须留下痕迹：吞掉的话运行会永远停在
                        // running 却没有线程在推进它，用户只看到「一直在跑」
                        record_background_failure(&store, &run_id, &error.to_string());
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
fn record_background_failure(store: &Store, run_id: &str, message: &str) {
    let _ = store.append_event(&aiwf_store::NewRunEvent {
        run_id: run_id.to_string(),
        kind: "run.failed".to_string(),
        node_id: None,
        attempt: None,
        actor: "engine".to_string(),
        status: None,
        summary: format!("执行线程异常退出：{message}"),
        payload_ref: None,
        artifact_refs: vec![],
        parent_event_id: None,
        sensitivity: "internal".to_string(),
        schema_ver: 1,
    });
    let _ = store.advance_run_status(run_id, "failed", None);
}
