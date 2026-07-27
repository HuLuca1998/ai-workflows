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
        if status == "waiting_approval" {
            // 还卡在审批上，恢复不了 —— 需要的是审批决定，不是恢复
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

    fn spawn(&self, run_id: &str) -> Result<()> {
        let flag = Arc::new(AtomicBool::new(false));
        self.lock_cancels()?
            .insert(run_id.to_string(), flag.clone());

        let db_path = self.db_path.clone();
        let cancels = self.cancels.clone();
        let run_id = run_id.to_string();

        std::thread::spawn(move || {
            // 各自一条连接：跑十分钟的脚本不该卡住界面的查询
            if let Ok(store) = Store::open(&db_path) {
                let _ = Runner::new().run_until_pause(&store, &run_id, &flag);
            }
            // 无论结束还是挂起都释放执行槽 ——
            // 挂在审批上的运行不该占着一个槽，哪怕用户三天不理它
            if let Ok(mut cancels) = cancels.lock() {
                cancels.remove(&run_id);
            }
        });
        Ok(())
    }

    fn lock_cancels(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>>> {
        self.cancels.lock().map_err(|_| SupervisorError::Poisoned)
    }
}
