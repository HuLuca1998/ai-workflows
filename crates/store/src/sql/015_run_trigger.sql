-- 这一条运行是谁发起的：手动点的，还是调度器到点起的。
--
-- 两个用处，缺一不可：
--   1. 界面上标出来 —— 用户第二天早上看到一条自己没点过的运行，
--      要能一眼知道那是定时任务干的
--   2. 调度器据此查「上次自动跑是什么时候」。放内存里的话，
--      09:30 跑完、09:31 重启，宽限期内会再跑一次
--
-- 默认 manual：历史数据全是人点出来的。
ALTER TABLE run ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'manual';

-- 调度器每次扫描都要按 (workflow_id, trigger_kind) 找最近一条
CREATE INDEX IF NOT EXISTS idx_run_trigger ON run(workflow_id, trigger_kind, started_at);
