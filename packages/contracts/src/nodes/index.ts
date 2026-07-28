/**
 * 节点定义的出口。
 *
 * 定义表在 definitions.ts，表单字段描述符在 fields.ts——
 * 后者要引用前者，拆开避免循环引用。
 */

export {
  NODE_GROUPS,
  NODE_LIBRARY,
  NODE_TYPES,
  getNodeDefinition,
  listNodeDefinitions,
  resolveNodeOutputs,
  type DynamicOutputRule,
  type NodeDefinition,
  type NodeGroup,
  type NodeLibraryEntry,
  type NodeType,
  type Port,
} from './definitions.js';

export { fieldDescriptors, type FieldControl, type FieldDescriptor } from './fields.js';

export { describeIssue } from './issue-text.js';
