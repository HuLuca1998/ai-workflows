import { z } from 'zod';
import { CapabilitiesSchema } from './capabilities.js';
import { NODE_TYPES, getNodeDefinition, resolveNodeOutputs } from './nodes/index.js';

/**
 * 工作流图。
 *
 * 执行语义由连线决定：1→N 并行分发、N→N 并行、N→1 阻塞汇聚（功能文档 §3.1）。
 * 汇聚策略挂在「被汇聚的那个节点」上，因为它才是需要等待的一方。
 */

export const JOIN_STRATEGIES = ['all', 'any', 'quorum', 'sequential'] as const;
export type JoinStrategy = (typeof JOIN_STRATEGIES)[number];

export const JoinConfigSchema = z.object({
  strategy: z.enum(JOIN_STRATEGIES).default('all'),
  /** strategy = quorum 时必填：需要多少条上游到达才继续。 */
  quorum: z.number().int().positive().optional(),
  merge: z.enum(['namespaced', 'shallow', 'deep']).default('namespaced'),
  onPartialFailure: z.enum(['fail', 'continue']).default('fail'),
  timeoutMs: z.number().int().positive().optional(),
});
export type JoinConfig = z.infer<typeof JoinConfigSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  backoff: z.enum(['none', 'fixed', 'exponential']).default('exponential'),
  timeoutMs: z.number().int().positive().default(900_000),
  /** 副作用操作重试前必须先核对外部实际状态（验收标准 §9）。 */
  idempotency: z.enum(['none', 'check_external']).default('check_external'),
  fallbackModel: z.string().min(1).optional(),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  title: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.unknown(),
  join: JoinConfigSchema.optional(),
  /** 节点可收紧能力，但不能静默扩大 Agent 角色的声明。 */
  capabilities: CapabilitiesSchema.partial().optional(),
  retry: RetryPolicySchema.partial().optional(),
  groupId: z.string().min(1).optional(),
});
/**
 * 画布上的节点用「输入形态」表达：带默认值的字段（join / retry）可以省略，
 * 由读取方按 Schema 补全。存储与执行前会先规范化一次。
 */
export type GraphNode = z.input<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.object({ nodeId: z.string().min(1), port: z.string().min(1) }),
  target: z.object({ nodeId: z.string().min(1), port: z.string().min(1) }),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphGroupSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
});
export type GraphGroup = z.infer<typeof GraphGroupSchema>;

export const WorkflowGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  // 不给默认值：图必须显式声明分组，避免「有时有、有时无」的形状分歧
  groups: z.array(GraphGroupSchema),
});
export type WorkflowGraph = z.input<typeof WorkflowGraphSchema>;

// ── 校验 ────────────────────────────────────────────────────────────────────

export const VALIDATION_CODES = [
  'ENTRY_MISSING',
  'ENTRY_DUPLICATE',
  'ENTRY_HAS_INPUT',
  'END_MISSING',
  'UNKNOWN_NODE_TYPE',
  'INVALID_CONFIG',
  'DUPLICATE_NODE_ID',
  'DANGLING_EDGE',
  'UNKNOWN_PORT',
  'DUPLICATE_EDGE',
  'CYCLE',
  'ORPHAN_NODE',
  'JOIN_QUORUM_INVALID',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: ValidationCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function validateGraph(graph: WorkflowGraph): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: ValidationCode, message: string, at: { nodeId?: string; edgeId?: string } = {}) =>
    issues.push({ level: 'error', code, message, ...at });
  const warn = (code: ValidationCode, message: string, at: { nodeId?: string; edgeId?: string } = {}) =>
    issues.push({ level: 'warning', code, message, ...at });

  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      err('DUPLICATE_NODE_ID', `节点 id ${node.id} 重复`, { nodeId: node.id });
      continue;
    }
    byId.set(node.id, node);
  }

  // 节点类型与配置
  const knownTypes = new Set<string>(NODE_TYPES);
  for (const node of byId.values()) {
    if (!knownTypes.has(node.type)) {
      err('UNKNOWN_NODE_TYPE', `节点类型 ${node.type} 未登记`, { nodeId: node.id });
      continue;
    }
    const parsed = getNodeDefinition(node.type).configSchema.safeParse(node.config);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('；');
      err('INVALID_CONFIG', `配置不合法 —— ${detail}`, { nodeId: node.id });
    }
  }

  // 入口与结束
  const entries = [...byId.values()].filter((n) => n.type === 'entry');
  if (entries.length === 0) {
    err('ENTRY_MISSING', '工作流缺少入口节点，启动表单无从生成');
  } else if (entries.length > 1) {
    for (const extra of entries.slice(1)) {
      err('ENTRY_DUPLICATE', '入口节点必须全图唯一', { nodeId: extra.id });
    }
  }
  if (byId.size > 0 && ![...byId.values()].some((n) => n.type === 'end')) {
    warn('END_MISSING', '没有结束节点，运行结果不会被显式标记');
  }

  // 连线
  const seenEdgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const source = byId.get(edge.source.nodeId);
    const target = byId.get(edge.target.nodeId);
    if (!source || !target) {
      err('DANGLING_EDGE', `连线指向不存在的节点`, { edgeId: edge.id });
      continue;
    }

    const key = `${edge.source.nodeId}:${edge.source.port}->${edge.target.nodeId}:${edge.target.port}`;
    if (seenEdgeKeys.has(key)) {
      warn('DUPLICATE_EDGE', '重复连线', { edgeId: edge.id });
    }
    seenEdgeKeys.add(key);

    if (knownTypes.has(source.type)) {
      const outputs = resolveNodeOutputs(source.type, source.config);
      if (!outputs.some((p) => p.id === edge.source.port)) {
        err('UNKNOWN_PORT', `${source.id} 没有输出端口 ${edge.source.port}`, { edgeId: edge.id });
      }
    }
    if (knownTypes.has(target.type)) {
      if (target.type === 'entry') {
        err('ENTRY_HAS_INPUT', '入口节点不能有入边', { nodeId: target.id, edgeId: edge.id });
      }
      const inputs = getNodeDefinition(target.type).ports.inputs;
      if (target.type !== 'entry' && !inputs.some((p) => p.id === edge.target.port)) {
        err('UNKNOWN_PORT', `${target.id} 没有输入端口 ${edge.target.port}`, { edgeId: edge.id });
      }
    }
  }

  // 汇聚策略
  for (const node of byId.values()) {
    if (node.join?.strategy !== 'quorum') continue;
    const incoming = fanIn(graph, node.id);
    const quorum = node.join.quorum;
    if (quorum === undefined || quorum < 1 || quorum > incoming) {
      err('JOIN_QUORUM_INVALID', `Quorum 需在 1..${incoming} 之间，当前为 ${quorum ?? '未设置'}`, {
        nodeId: node.id,
      });
    }
  }

  // 环
  const cyclic = findCyclicNodes(graph, byId);
  for (const nodeId of cyclic) {
    err('CYCLE', '节点位于环上，工作流必须是有向无环图', { nodeId });
  }

  // 可达性（从入口出发）
  if (entries[0]) {
    const reachable = reachableFrom(graph, entries[0].id);
    for (const node of byId.values()) {
      if (!reachable.has(node.id)) {
        warn('ORPHAN_NODE', '从入口节点不可达，运行时会被跳过', { nodeId: node.id });
      }
    }
  } else {
    for (const node of byId.values()) {
      warn('ORPHAN_NODE', '没有入口节点，无法判定可达性', { nodeId: node.id });
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}

// ── 拓扑工具 ────────────────────────────────────────────────────────────────

export function fanOut(graph: WorkflowGraph, nodeId: string): number {
  return graph.edges.filter((e) => e.source.nodeId === nodeId).length;
}

export function fanIn(graph: WorkflowGraph, nodeId: string): number {
  return graph.edges.filter((e) => e.target.nodeId === nodeId).length;
}

function reachableFrom(graph: WorkflowGraph, startId: string): Set<string> {
  const seen = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const edge of graph.edges) {
      if (edge.source.nodeId !== current || seen.has(edge.target.nodeId)) continue;
      seen.add(edge.target.nodeId);
      stack.push(edge.target.nodeId);
    }
  }
  return seen;
}

/** Kahn 算法；返回未能排序的节点即位于环上的节点。 */
function kahn(graph: WorkflowGraph, byId: Map<string, GraphNode>): { order: string[]; stuck: string[] } {
  const indegree = new Map<string, number>();
  for (const id of byId.keys()) indegree.set(id, 0);
  for (const edge of graph.edges) {
    if (!byId.has(edge.source.nodeId) || !byId.has(edge.target.nodeId)) continue;
    indegree.set(edge.target.nodeId, (indegree.get(edge.target.nodeId) ?? 0) + 1);
  }

  // 按 nodes 数组顺序入队，保证同层节点的输出顺序稳定（执行记录列表依赖它）
  const queue = [...byId.keys()].filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const edge of graph.edges) {
      if (edge.source.nodeId !== current || !byId.has(edge.target.nodeId)) continue;
      const left = (indegree.get(edge.target.nodeId) ?? 0) - 1;
      indegree.set(edge.target.nodeId, left);
      if (left === 0) queue.push(edge.target.nodeId);
    }
  }

  return { order, stuck: [...byId.keys()].filter((id) => !order.includes(id)) };
}

function findCyclicNodes(graph: WorkflowGraph, byId: Map<string, GraphNode>): string[] {
  return kahn(graph, byId).stuck;
}

/**
 * 执行记录里「按连线拓扑排序显示执行顺序」的依据。
 * 有环时抛错——调用方必须先跑 validateGraph。
 */
export function topologicalOrder(graph: WorkflowGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const { order, stuck } = kahn(graph, byId);
  if (stuck.length > 0) {
    throw new Error(`图中存在环，无法拓扑排序：${stuck.join(', ')}`);
  }
  return order;
}
