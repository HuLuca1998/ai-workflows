-- 运行的工作目录。
--
-- 图纸「同一工作流可用不同参数并行运行，环境快照互不影响」——
-- 工作目录是这句话里最实在的一部分：两个并行运行必须能落在不同目录，
-- 否则 worktree 和产物就会互相覆盖。
--
-- 放独立列而不是塞进 env_snapshot_json：运行列表要按它筛选与显示。
ALTER TABLE run ADD COLUMN workdir TEXT;
