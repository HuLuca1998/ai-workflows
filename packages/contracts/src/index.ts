/**
 * @aiwf/contracts —— M0 冻结的三件事：Core API 契约、RunEvent 类型清单、节点定义 Schema。
 *
 * UI、引擎、MCP Server 都从这里取类型；任何一方私自扩展都属于契约破坏。
 * 修改流程见 docs/CONTRIBUTING.md：先改这里 + 测试，再改实现。
 */

export * from './api.js';
export * from './approval.js';
export * from './capabilities.js';
export * from './diff.js';
export * from './domain.js';
export * from './report.js';
export * from './errors.js';
export * from './events.js';
export * from './graph.js';
export * from './nodes/index.js';
export * from './patch.js';
export * from './state-machine.js';
export * from './templates.js';
export * from './trigger.js';

/** 契约版本。破坏性变更时递增，两端据此拒绝不兼容的对端。 */
export const CONTRACTS_VERSION = 1;
