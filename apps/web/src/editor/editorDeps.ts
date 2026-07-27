/**
 * 编辑器用到的契约与客户端出口。
 * 单独一层是为了让纯逻辑测试能在 node 环境引入，不连带拉进 React。
 */
export {
  CoreApiError,
  NODE_LIBRARY,
  diffGraphs,
  fieldDescriptors,
  getNodeDefinition,
  resolveNodeOutputs,
  validateGraph,
  type PatchOperation,
  type ValidationIssue,
  type FieldDescriptor,
  type GraphNode,
  type NodeType,
  type ValidationResult,
  type WorkflowDiff,
  type WorkflowGraph,
} from '@aiwf/contracts';
export { DraftStore } from '@aiwf/client-core';
