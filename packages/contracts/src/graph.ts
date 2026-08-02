import { z } from 'zod';
import { CapabilitiesSchema } from './capabilities.js';
import {
  NODE_TYPES,
  describeIssue,
  fieldName,
  getNodeDefinition,
  resolveNodeOutputs,
} from './nodes/index.js';

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
  // 还带着 seed 里那个占位值的字段。warning ——
  // 编辑中途留着占位是正常状态（DEBT O-14）
  'PLACEHOLDER_CONFIG',
  // 选了定时/间隔触发却没填时刻或间隔。error ——
  // 这种图发布出去，调度器只能沉默地不跑它
  'TRIGGER_INCOMPLETE',
  // 自动触发 + 必填参数没有默认值。error ——
  // 定时没有人在场填表，调度器只能拿 inputSchema 的默认值
  'TRIGGER_INPUT_NO_DEFAULT',
  // 某个输出端口没有下游，而同一节点的别的端口有。warning ——
  // 走到那个口就静默停下，运行**以成功结束而什么都没做**
  'PORT_NO_DOWNSTREAM',
  // 多条入边来自不同来源，却没显式声明汇聚策略。error ——
  // 默认「等全部到齐」，互斥端口只会走一条，那个节点永远执行不到
  'JOIN_STRATEGY_MISSING',
  /** AI 节点的指令里没引用上游的产出 —— 它看不到上一步的结论。 */
  'UPSTREAM_UNUSED',
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
  const err = (
    code: ValidationCode,
    message: string,
    at: { nodeId?: string; edgeId?: string } = {},
  ) => issues.push({ level: 'error', code, message, ...at });
  const warn = (
    code: ValidationCode,
    message: string,
    at: { nodeId?: string; edgeId?: string } = {},
  ) => issues.push({ level: 'warning', code, message, ...at });

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
    const definition = getNodeDefinition(node.type);
    const parsed = definition.configSchema.safeParse(node.config);
    if (!parsed.success) {
      // 走 describeIssue 而不是 `i.message`。
      //
      // 后者漏的是 Zod 的英文（`Invalid input: expected string, received
      // undefined`），于是同一个配置问题在配置弹层里是中文、在校验面板里
      // 是半句英文 —— 而两处说的是同一件事。
      //
      // 还有一层：英文文案是 Zod 的实现细节，跟着它的版本走。
      // Rust 侧要给出同一句话（`crates/engine/src/validate.rs`），
      // 就不能把「用户看到什么」交给一个第三方库的版本号
      const detail = parsed.error.issues
        .map((issue) => describeIssue(issue, definition.configSchema))
        .join('；');
      err('INVALID_CONFIG', `配置不合法 —— ${detail}`, { nodeId: node.id });
    }

    /*
     * 还带着占位值的字段。
     *
     * 拖进画布时用 `seed` 填一份能过 configSchema 的初始配置，而那些
     * 占位值是**真实字符串**（`待填写指令` / `待选择角色`），于是
     * `z.string().min(1)` 一路放行：顶栏说「校验通过」，用户放心保存，
     * 点运行才发现 Dry Run 报「8 项缺失」（DEBT O-14）。
     *
     * warning 而不是 error：编辑中途留着占位是正常状态，
     * 此时禁掉保存会很难用。判据是「值与 seed 里那个占位一模一样」——
     * 用户自己打出「待填写指令」这几个字的概率可以忽略，
     * 而按前缀猜会误伤「待办清单」这类正当内容。
     */
    const seed = definition.seed ?? {};
    const unfilled = Object.entries(seed)
      .filter(([key, placeholder]) => {
        if (typeof placeholder !== 'string' || !/待[填选]/u.test(placeholder)) return false;
        return (node.config as Record<string, unknown>)[key] === placeholder;
      })
      .map(([key]) => fieldName([key], definition.configSchema));

    if (unfilled.length > 0) {
      warn('PLACEHOLDER_CONFIG', `这几项还没填：${unfilled.join('、')}`, { nodeId: node.id });
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
  for (const entry of entries) {
    /*
     * 选了定时却没填时刻 —— 调度器读不出触发点，只能跳过这个工作流。
     * 报 error 而不是 warning：这不是「编辑中途」的正常状态，
     * 而是一份发布出去也永远不会自己跑起来的图，且没有任何地方会告诉他。
     */
    const config = entry.config as Record<string, unknown>;
    if (config['trigger'] === 'schedule' && typeof config['scheduleTime'] !== 'string') {
      err('TRIGGER_INCOMPLETE', '选了每天定时，但没填几点（HH:MM）', { nodeId: entry.id });
    }
    if (config['trigger'] === 'interval' && typeof config['intervalMinutes'] !== 'number') {
      err('TRIGGER_INCOMPLETE', '选了按间隔触发，但没填间隔多少分钟', { nodeId: entry.id });
    }
    /*
     * 自动触发时**没有人在场填启动表单** —— 调度器只能拿
     * `inputSchema` 里每个字段的 `default`。必填字段没有默认值的话，
     * 这份图一到点就死在第一个用到那个参数的节点上
     * （`未定义的引用 ${input.repo}`），而手动跑一切正常，
     * 所以问题只在半夜发生、只留下一条查不出原因的失败运行。
     *
     * 在**发布时**拦下来，而不是等它每天失败一次。
     */
    if (config['trigger'] === 'schedule' || config['trigger'] === 'interval') {
      const schema = config['inputSchema'] as
        { required?: unknown; properties?: Record<string, { default?: unknown }> } | undefined;
      const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
      const 没默认值 = required.filter((key) => schema?.properties?.[key]?.default === undefined);
      if (没默认值.length > 0) {
        err(
          'TRIGGER_INPUT_NO_DEFAULT',
          `自动触发时没有人填表，这些必填参数要有默认值：${没默认值.join('、')}`,
          { nodeId: entry.id },
        );
      }
    }
  }
  if (byId.size > 0 && ![...byId.values()].some((n) => n.type === 'end')) {
    warn('END_MISSING', '没有结束节点，运行结果不会被显式标记');
  }

  /*
   * 端口有没有下游 / 汇聚策略有没有声明。
   *
   * 这两条原来只在 `tests/templates.test.ts` 里守着内置模板 ——
   * **用户自己画的图完全不受保护**：Dry Run 全绿，跑起来一条
   * 静默停在半路（运行以成功结束而什么都没做），另一条判 failed
   * 且没有 `node.failed` 事件（界面上是一条不知道死在哪的失败运行）。
   * 两种症状都是独立复核实跑出来的。
   */
  const 出边 = new Map<string, Set<string>>();
  const 入边 = new Map<string, { nodeId: string; port: string }[]>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source.nodeId) || !byId.has(edge.target.nodeId)) continue;
    const ports = 出边.get(edge.source.nodeId) ?? new Set<string>();
    ports.add(edge.source.port);
    出边.set(edge.source.nodeId, ports);
    const list = 入边.get(edge.target.nodeId) ?? [];
    list.push({ nodeId: edge.source.nodeId, port: edge.source.port });
    入边.set(edge.target.nodeId, list);
  }

  for (const node of byId.values()) {
    if (!knownTypes.has(node.type)) continue;
    const 用过的 = 出边.get(node.id);
    // 一条出边都没有 = 这是个终点，正常
    if (用过的 && 用过的.size > 0) {
      const 全部 = resolveNodeOutputs(node.type, node.config).map((port) => port.id);
      const 漏掉的 = 全部.filter((port) => !用过的.has(port));
      if (漏掉的.length > 0) {
        warn(
          'PORT_NO_DOWNSTREAM',
          `这些端口没有下游：${漏掉的.join('、')}。走到它们时运行会静默停下 —— ` +
            `以「成功」结束而后面什么都没做`,
          { nodeId: node.id },
        );
      }
    }

    const ins = 入边.get(node.id) ?? [];
    // 来源不同（节点或端口不同）才需要汇聚策略；同一来源的重复边不算
    const 来源 = new Set(ins.map((e) => `${e.nodeId}.${e.port}`));
    if (来源.size >= 2 && node.join?.strategy === undefined) {
      err(
        'JOIN_STRATEGY_MISSING',
        `有 ${来源.size} 条来自不同来源的入边，却没声明汇聚策略。` +
          `默认是「等全部到齐」—— 那几条如果是互斥分支（走了这条就不走那条），` +
          `这个节点永远执行不到，而运行会判失败且看不出死在哪`,
        { nodeId: node.id },
      );
    }
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

  // 可达性（从入口出发）。
  //
  // 这里是 **warning**：编辑中途拖入一个还没连线的节点是正常状态，
  // 此时禁掉保存会很难用。
  //
  // 但文案必须说对 —— 原来写的是「运行时会被跳过」，那是反的：
  // 调度器挑的是「上游都完成了的节点」，一个没有上游的节点
  // 从第一轮起就满足条件，**它会被执行**。
  // 真正的拦截在 Dry Run（`crates/engine/src/preflight.rs` 的可达性检查），
  // 那时用户是要真的跑了，孤立节点就该是硬错误。
  if (entries[0]) {
    const reachable = reachableFrom(graph, entries[0].id);
    for (const node of byId.values()) {
      if (!reachable.has(node.id)) {
        warn('ORPHAN_NODE', '从入口连不到这个节点，但运行时它仍会被执行 —— 多半是忘了连线', {
          nodeId: node.id,
        });
      }
    }
  } else {
    for (const node of byId.values()) {
      warn('ORPHAN_NODE', '没有入口节点，无法判定可达性', { nodeId: node.id });
    }
  }

  /*
   * **上一个节点的产出，下一个 AI 节点用到了吗。**
   *
   * 每个 AI 节点各开一条 ACP 会话，没有跨节点上下文 —— 上一步的结论
   * 不显式写进 `instruction` / `target`，模型就真的看不到，
   * 它的提示词里只有角色、记忆和这段指令。
   *
   * 实测（真 GitHub 仓库的 issue 修复）：`fix` 节点指令全文是
   * 「按选定方案修改代码，小步提交，每步可验证。」——
   * 上游分析给出的方案一个字都没接进来，那个 agent 手上什么都没有，
   * 最后开出的 PR 里只有一个多余的锁文件。
   *
   * **穿过审批节点往上找**：审批不携带内容往下传，
   * 只看直接上游的话，`分析 → 审批 → 执行` 这条链上什么都查不出来。
   *
   * warning 不是 error：编辑中途还没写完指令是正常状态，
   * 而「有意不引用、让 agent 自己用系统 MCP 去读」也是合法做法。
   */
  for (const node of byId.values()) {
    if (!AI_NODE_TYPES.has(node.type)) continue;
    const referenced = new Set(
      [...JSON.stringify(node.config ?? {}).matchAll(/\$\{(\w+)\./gu)].map((m) => m[1]!),
    );
    const missing = nearestProducers(graph, node.id).filter((id) => !referenced.has(id));
    if (missing.length > 0) {
      warn(
        'UPSTREAM_UNUSED',
        `上游 ${missing.join('、')} 的产出没有出现在这个节点的指令里 —— ` +
          'AI 节点之间没有共享上下文，不用 ${节点id.端口} 接进来它就看不到',
        { nodeId: node.id },
      );
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}

/** 指令里引用上游才看得到内容的节点类型。 */
const AI_NODE_TYPES = new Set(['ai.analyze', 'ai.execute', 'ai.review', 'ai.decide']);

/** 会产出内容、值得被下游引用的节点类型。 */
const PRODUCER_TYPES = new Set([
  'script.shell',
  'ai.analyze',
  'ai.execute',
  'ai.review',
  'ai.decide',
  'subworkflow',
]);

/**
 * 穿过审批等不产出内容的节点，找最近的产出祖先。
 *
 * `entry` 不算：它的产出是 `${input.*}`，不以节点 id 引用。
 */
export function nearestProducers(graph: WorkflowGraph, nodeId: string): string[] {
  const byType = new Map(graph.nodes.map((n) => [n.id, n.type]));
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = parents.get(edge.target.nodeId) ?? [];
    list.push(edge.source.nodeId);
    parents.set(edge.target.nodeId, list);
  }

  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const parent of parents.get(id) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (PRODUCER_TYPES.has(byType.get(parent) ?? '')) found.add(parent);
      else walk(parent);
    }
  };
  walk(nodeId);
  return [...found].sort();
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
function kahn(
  graph: WorkflowGraph,
  byId: Map<string, GraphNode>,
): { order: string[]; stuck: string[] } {
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
