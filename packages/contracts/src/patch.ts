import { z } from 'zod';
import { CapabilitiesSchema } from './capabilities.js';
import { CoreApiError } from './errors.js';
import {
  GraphEdgeSchema,
  JoinConfigSchema,
  RetryPolicySchema,
  validateGraph,
  type ValidationResult,
  type WorkflowGraph,
} from './graph.js';
import { NODE_TYPES, getNodeDefinition, type NodeType } from './nodes/index.js';

/**
 * 结构化 Patch —— 唯一的写入形态。
 *
 * 刻意**没有** replaceGraph / setGraphJson 这类操作：整份回写会绕过版本守卫与 Diff，
 * AI 一旦写坏就无法解释和回滚（技术选型 §6）。
 */

const PositionSchema = z.object({ x: z.number(), y: z.number() });

export const PatchOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addNode'),
    nodeId: z.string().min(1).optional(),
    type: z.enum(NODE_TYPES),
    title: z.string().min(1),
    position: PositionSchema,
    config: z.unknown(),
  }),
  z.object({ op: z.literal('removeNode'), nodeId: z.string().min(1) }),
  z.object({ op: z.literal('renameNode'), nodeId: z.string().min(1), title: z.string().min(1) }),
  z.object({ op: z.literal('moveNode'), nodeId: z.string().min(1), position: PositionSchema }),
  z.object({ op: z.literal('setConfig'), nodeId: z.string().min(1), config: z.unknown() }),
  z.object({ op: z.literal('setJoin'), nodeId: z.string().min(1), join: JoinConfigSchema }),
  z.object({
    op: z.literal('setCapabilities'),
    nodeId: z.string().min(1),
    capabilities: CapabilitiesSchema.partial(),
  }),
  z.object({
    op: z.literal('setRetry'),
    nodeId: z.string().min(1),
    retry: RetryPolicySchema.partial(),
  }),
  z.object({
    op: z.literal('connect'),
    edgeId: z.string().min(1).optional(),
    source: GraphEdgeSchema.shape.source,
    target: GraphEdgeSchema.shape.target,
  }),
  z.object({ op: z.literal('disconnect'), edgeId: z.string().min(1) }),
  z.object({
    op: z.literal('createGroup'),
    groupId: z.string().min(1).optional(),
    title: z.string().min(1),
    nodeIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({ op: z.literal('deleteGroup'), groupId: z.string().min(1) }),
]);
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

/**
 * 所有合法的操作名。
 *
 * 从 Schema 自己派生，不手写第二份 —— 手写的那份迟早会漏一个。
 * Rust 侧（主管 AI 解析提议时）要用它做最小校验，
 * 所以它进了生成物，由 contract_sync_test 守着不漂移。
 */
export const PATCH_OPS = PatchOperationSchema.options.map(
  (option) => option.shape.op.value,
) as readonly PatchOperation['op'][];

export const WorkflowPatchSchema = z.object({
  /** 调用方读到的草稿修订号；与当前不符即拒绝，避免并发覆盖。 */
  baseRevision: z.number().int().min(0),
  operations: z.array(PatchOperationSchema).min(1),
});
export type WorkflowPatch = z.infer<typeof WorkflowPatchSchema>;

export interface DiffEntry {
  kind: 'node' | 'edge' | 'group';
  id: string;
  /** 面向用户的一行描述，直接渲染在 Diff 面板里。 */
  label: string;
  before?: unknown;
  after?: unknown;
}

export interface WorkflowDiff {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
}

export interface PatchResult {
  rev: number;
  graph: WorkflowGraph;
  diff: WorkflowDiff;
  validation: ValidationResult;
}

const notFound = (what: string, id: string) =>
  new CoreApiError({
    code: 'VALIDATION',
    message: `${what} ${id} 不存在`,
    hint: '先用 workflow.get 读取当前草稿，再基于真实 id 重试',
  });

/**
 * 应用一批操作。要么全部成功，要么整批不生效——不留半截草稿。
 * 返回的图是新对象，调用方的草稿不会被就地改写。
 */
export function applyPatch(
  graph: WorkflowGraph,
  currentRevision: number,
  patch: WorkflowPatch,
): PatchResult {
  if (patch.baseRevision !== currentRevision) {
    throw new CoreApiError({
      code: 'REVISION_CONFLICT',
      message: `草稿已变化：baseRevision ${patch.baseRevision}，当前 rev ${currentRevision}`,
      hint: '重新读取草稿并基于最新 rev 重新生成 Patch',
      details: { baseRevision: patch.baseRevision, currentRevision },
    });
  }

  const next = structuredClone(graph) as WorkflowGraph;
  const diff: WorkflowDiff = { added: [], removed: [], changed: [] };

  const findNode = (nodeId: string) => {
    const node = next.nodes.find((n) => n.id === nodeId);
    if (!node) throw notFound('节点', nodeId);
    return node;
  };

  for (const [index, operation] of patch.operations.entries()) {
    switch (operation.op) {
      case 'addNode': {
        const nodeId =
          operation.nodeId ?? `${operation.type.replace(/\./gu, '_')}_${next.nodes.length + 1}`;
        if (next.nodes.some((n) => n.id === nodeId)) {
          throw new CoreApiError({ code: 'VALIDATION', message: `节点 id ${nodeId} 已存在` });
        }
        // 用节点定义解析一次，把 Schema 默认值固化进草稿：运行时行为不依赖读取方
        const parsed = getNodeDefinition(operation.type as NodeType).configSchema.safeParse(
          operation.config ?? {},
        );
        if (!parsed.success) {
          throw new CoreApiError({
            code: 'VALIDATION',
            message: `第 ${index + 1} 个操作的节点配置不合法`,
            details: parsed.error.issues,
          });
        }
        next.nodes.push({
          id: nodeId,
          type: operation.type,
          title: operation.title,
          position: operation.position,
          config: parsed.data,
        });
        diff.added.push({
          kind: 'node',
          id: nodeId,
          label: `node ${operation.type}「${operation.title}」`,
          after: parsed.data,
        });
        break;
      }

      case 'removeNode': {
        const node = findNode(operation.nodeId);
        next.nodes = next.nodes.filter((n) => n.id !== operation.nodeId);
        // 删节点必须连带断线，否则会留下悬空边
        const orphanEdges = next.edges.filter(
          (e) => e.source.nodeId === operation.nodeId || e.target.nodeId === operation.nodeId,
        );
        next.edges = next.edges.filter((e) => !orphanEdges.includes(e));
        diff.removed.push({
          kind: 'node',
          id: node.id,
          label: `node ${node.type}「${node.title}」`,
          before: node,
        });
        for (const edge of orphanEdges) {
          diff.removed.push({
            kind: 'edge',
            id: edge.id,
            label: `edge ${edge.source.nodeId} → ${edge.target.nodeId}`,
            before: edge,
          });
        }
        break;
      }

      case 'renameNode': {
        const node = findNode(operation.nodeId);
        const before = node.title;
        node.title = operation.title;
        diff.changed.push({
          kind: 'node',
          id: node.id,
          label: `node ${node.id}：标题 ${before} → ${operation.title}`,
          before,
          after: operation.title,
        });
        break;
      }

      case 'moveNode': {
        const node = findNode(operation.nodeId);
        node.position = operation.position;
        break; // 位置变化不进 Diff：它不改变执行语义
      }

      case 'setConfig': {
        const node = findNode(operation.nodeId);
        const parsed = getNodeDefinition(node.type).configSchema.safeParse(operation.config ?? {});
        if (!parsed.success) {
          throw new CoreApiError({
            code: 'VALIDATION',
            message: `节点 ${node.id} 的新配置不合法`,
            details: parsed.error.issues,
          });
        }
        const before = node.config;
        node.config = parsed.data;
        diff.changed.push({
          kind: 'node',
          id: node.id,
          label: `node ${node.id}：配置更新`,
          before,
          after: parsed.data,
        });
        break;
      }

      case 'setJoin': {
        const node = findNode(operation.nodeId);
        const before = node.join;
        node.join = operation.join;
        diff.changed.push({
          kind: 'node',
          id: node.id,
          label: `node ${node.id}：汇聚策略 → ${operation.join.strategy}`,
          before,
          after: operation.join,
        });
        break;
      }

      case 'setCapabilities': {
        const node = findNode(operation.nodeId);
        const before = node.capabilities;
        node.capabilities = { ...node.capabilities, ...operation.capabilities };
        diff.changed.push({
          kind: 'node',
          id: node.id,
          label: `node ${node.id}：能力声明变更（扩权会让已保存的信任策略失效）`,
          before,
          after: node.capabilities,
        });
        break;
      }

      case 'setRetry': {
        const node = findNode(operation.nodeId);
        const before = node.retry;
        node.retry = { ...node.retry, ...operation.retry };
        diff.changed.push({
          kind: 'node',
          id: node.id,
          label: `node ${node.id}：重试策略变更`,
          before,
          after: node.retry,
        });
        break;
      }

      case 'connect': {
        findNode(operation.source.nodeId);
        findNode(operation.target.nodeId);
        const edgeId = operation.edgeId ?? `edge_${next.edges.length + 1}`;
        if (next.edges.some((e) => e.id === edgeId)) {
          throw new CoreApiError({ code: 'VALIDATION', message: `连线 id ${edgeId} 已存在` });
        }
        const edge = { id: edgeId, source: operation.source, target: operation.target };
        next.edges.push(edge);
        diff.added.push({
          kind: 'edge',
          id: edgeId,
          label: `edge ${operation.source.nodeId}.${operation.source.port} → ${operation.target.nodeId}`,
          after: edge,
        });
        break;
      }

      case 'disconnect': {
        const edge = next.edges.find((e) => e.id === operation.edgeId);
        if (!edge) throw notFound('连线', operation.edgeId);
        next.edges = next.edges.filter((e) => e.id !== operation.edgeId);
        diff.removed.push({
          kind: 'edge',
          id: edge.id,
          label: `edge ${edge.source.nodeId}.${edge.source.port} → ${edge.target.nodeId}`,
          before: edge,
        });
        break;
      }

      case 'createGroup': {
        const groupId = operation.groupId ?? `group_${next.groups.length + 1}`;
        for (const nodeId of operation.nodeIds) findNode(nodeId);
        const group = { id: groupId, title: operation.title, nodeIds: operation.nodeIds };
        next.groups.push(group);
        diff.added.push({
          kind: 'group',
          id: groupId,
          label: `group「${operation.title}」`,
          after: group,
        });
        break;
      }

      case 'deleteGroup': {
        const group = next.groups.find((g) => g.id === operation.groupId);
        if (!group) throw notFound('分组', operation.groupId);
        next.groups = next.groups.filter((g) => g.id !== operation.groupId);
        diff.removed.push({
          kind: 'group',
          id: group.id,
          label: `group「${group.title}」`,
          before: group,
        });
        break;
      }
    }
  }

  // 校验结果一并返回：由调用方（UI / MCP）决定是否让用户确认后落草稿
  return { rev: currentRevision + 1, graph: next, diff, validation: validateGraph(next) };
}
