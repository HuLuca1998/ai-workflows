/**
 * @aiwf/acp-sidecar —— Node 侧的 ACP 适配。
 *
 * 引擎以子进程 + JSON-RPC 的方式调用它：崩溃不影响主应用。
 * M0 只落地 runtime 注册表与进程环境构造（把踩过的坑固化成约束），
 * 会话与真流式在 M3 接上，参考实现见 docs/acp/reference/。
 */

export {
  ACP_RUNTIME_REGISTRY,
  buildSpawnEnv,
  resolveRuntimeCommand,
  validateSessionCwd,
  type AcpRuntimeEntry,
  type SpawnEnvOptions,
} from './runtime.js';
