-- 清掉老库里 `provider.api` 的残留。
--
-- 那一格枚举是「直连模型厂商 HTTP API」的占位，**一行实现都没有**：
-- 界面能选、库里能存、跑到 AI 节点必然失败在「不认识的 runtime」。
-- 契约里去掉它之后，这些行会变成写不回去的死数据 ——
-- 用户点开能看见，一保存就被 Core API 挡在门口，而错误信息说的是
-- 「不认识的接入方式」，指向一个他压根没选过的东西。
--
-- 顺序要紧：先改角色、再删模型。反过来的话 `delete_model` 那道
-- 引用检查（"这些 Agent 角色还在用它"）会挡住，而迁移里没有人去读那个错。
--
-- 角色**不删**只改接入方式：角色上有用户写的 goal / persona /
-- output_contract，那是他的东西。改到 acp.codex 之后跑得起来，
-- 而模型引用在下一步补：指向被删模型的角色，改指到内置的 model:codex。

-- 1. 引用了 provider.api 模型的角色，模型引用先挪走
UPDATE agent_profile
   SET model_ref = 'model:codex'
 WHERE model_ref IN (SELECT id FROM model WHERE runtime = 'provider.api');

UPDATE agent_profile
   SET fallback_model_ref = NULL
 WHERE fallback_model_ref IN (SELECT id FROM model WHERE runtime = 'provider.api');

-- 2. 角色自己的接入方式
UPDATE agent_profile
   SET runtime = 'acp.codex'
 WHERE runtime = 'provider.api';

-- 3. 现在没人引用了，模型行可以删
DELETE FROM model WHERE runtime = 'provider.api';
