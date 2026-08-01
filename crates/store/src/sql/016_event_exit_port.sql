-- 节点从哪个端口出去的。
--
-- 端口此前只进了事件摘要的文案（「完成 · 走 success 分支」），
-- 调度器从不读它 —— 于是**端口路由是假的**：不管上游走哪个口，
-- 所有下游一律执行。实测症状：一条成功的运行把标着
-- 「结束 · 材料不足」的失败终点也跑了一遍（run_4b439b16806ef3f3 的事件 #78）。
--
-- 存成独立一列而不是从摘要里解析：摘要是给人看的，
-- 改一次措辞就会把调度器弄坏，而那种坏法不会有任何报错。
ALTER TABLE run_event ADD COLUMN exit_port TEXT;

CREATE INDEX IF NOT EXISTS idx_event_exit_port ON run_event(run_id, type, exit_port);
