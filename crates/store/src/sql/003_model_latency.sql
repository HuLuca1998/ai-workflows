-- 最近一次连通性测试的延迟。
--
-- 图纸「07 模型」的凭据卡里有一行「延迟 · xxx（最近一次测试）」。
-- 存在模型行上而不是另开一张历史表：界面只显示最近一次，
-- 留一张会无限增长的历史表却没人看，是纯粹的负担。
ALTER TABLE model ADD COLUMN last_latency_ms INTEGER;
