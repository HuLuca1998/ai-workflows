/**
 * @aiwf/client-core —— 界面与 Core API 之间的那一层。
 *
 * UI 只做两件事：订阅 RunEvent 的只读投影、发命令。文件与进程一律不碰。
 */

export { CoreApiClient, type CoreApiClientOptions } from './client.js';
export {
  DraftStore,
  type DraftSnapshot,
  type PatchOutcome,
  type PendingProposal,
} from './draft-store.js';
export {
  EventStore,
  type ArtifactEntry,
  type ConversationItem,
  type NodeProgress,
  type Provenance,
} from './event-store.js';
export { MemoryTransport, type Transport } from './transport.js';
