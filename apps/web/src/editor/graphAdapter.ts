import { MarkerType, type Edge, type Node } from '@xyflow/react';
import {
  IMPLEMENTED_NODE_TYPES,
  fanIn,
  fanOut,
  getNodeDefinition,
  describeTrigger,
  resolveNodeOutputs,
  type NodeType,
  type TriggerConfig,
  type ValidationIssue,
  type WorkflowGraph,
} from '@aiwf/contracts';
import { NODE_HEIGHT, NODE_WIDTH, joinBadge, type NodeTone } from './nodeVisuals.js';
import type { WorkflowNodeData } from './WorkflowNode.tsx';

/**
 * 契约里的工作流图 ↔ XYFlow 的节点 / 边。
 *
 * 单独一层的原因：图是持久化格式（要与 Rust 侧一致），XYFlow 的结构是渲染细节，
 * 两者不该互相污染。转换是纯函数，能单测——错了的症状是「画布上少了东西」
 * 而不是报错。
 */

/** 节点副文本：图纸里放的是关键配置摘要，让人不打开弹层就知道这节点在干什么。 */
export function summarize(type: NodeType, config: unknown): string {
  const c = (config ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'entry':
      // 走契约里那份 —— 画布、工作流列表、Rust 侧的调度日志说的
      // 必须是同一句话（trigger_reach_test 守着两侧一致）。
      // 原来是把枚举值原样贴出去：「触发：schedule」，
      // 用户既不知道几点，也不知道那到底生效没有
      return `触发：${describeTrigger(c as TriggerConfig)}`;
    case 'script.shell':
    case 'script.python': {
      const script = typeof c.script === 'string' ? c.script : '';
      const first = script.split('\n')[0] ?? '';
      return `${c.interpreter ?? ''} · ${first.slice(0, 28)}`.trim();
    }
    case 'approval':
      return typeof c.title === 'string' && c.title ? c.title : '等待人工决定';
    case 'git.worktree':
      return `${c.baseBranch ?? ''} → ${c.branchTemplate ?? ''}`;
    case 'notify':
      return typeof c.title === 'string' ? c.title : '系统通知';
    case 'ai.analyze':
    case 'ai.review':
    case 'ai.decide':
    case 'ai.execute':
      return typeof c.instruction === 'string' && c.instruction
        ? c.instruction.slice(0, 30)
        : String(c.agentProfileId ?? '未指定角色');
    case 'subworkflow':
      return `${c.workflowId ?? '未选择'} · ${c.mode ?? 'sync'}`;
    case 'branch':
      return `${Array.isArray(c.cases) ? c.cases.length : 0} 个分支`;
    case 'transform':
      return `${Array.isArray(c.mappings) ? c.mappings.length : 0} 条映射`;
    case 'end':
      return `标记为 ${c.outcome ?? 'success'}`;
    case 'env':
      return `${Array.isArray(c.operations) ? c.operations.length : 0} 项操作`;
    case 'mcp.tool':
      return `${c.serverId ?? '未选择 Server'}`;
    default:
      return getNodeDefinition(type).summary;
  }
}

export interface ToFlowOptions {
  /** 校验问题：带 nodeId 的会让节点显示问题标记。 */
  issues?: readonly ValidationIssue[];
  /** M1 还没有运行数据，节点一律是 idle；M2 起按运行状态给 tone。 */
  toneOf?: (nodeId: string) => NodeTone;
  /**
   * 选中的节点。
   *
   * 节点是受控的（nodes prop 来自这个函数），所以 React Flow 内部的
   * `setNodes({selected})` 会被下一次渲染覆盖 —— 选中状态必须从这里进去。
   */
  selected?: ReadonlySet<string>;
}

export function toFlowNodes(graph: WorkflowGraph, options: ToFlowOptions = {}): Node[] {
  const issueNodeIds = new Set(
    (options.issues ?? []).filter((i) => i.level === 'error' && i.nodeId).map((i) => i.nodeId),
  );

  return graph.nodes.map((node) => {
    const data: WorkflowNodeData = {
      type: node.type,
      title: node.title,
      sub: summarize(node.type, node.config),
      tone: options.toneOf?.(node.id) ?? 'idle',
      joinBadge: joinBadge(fanIn(graph, node.id), fanOut(graph, node.id), node.join?.strategy),
      ...(issueNodeIds.has(node.id) ? { hasIssue: true } : {}),
      /*
       * 引擎跑不了这种节点。
       *
       * 节点库标了，而拖进画布之后卡片上什么都没有 —— 用户搭图时看的是
       * 画布，不是节点库（复核实测 F）。判据取自契约，不在这里抄一份。
       */
      ...(IMPLEMENTED_NODE_TYPES.includes(node.type) ? {} : { unimplemented: true }),
    };
    return {
      id: node.id,
      type: 'workflow',
      position: node.position,
      ...(options.selected?.has(node.id) ? { selected: true } : {}),
      data: data as unknown as Record<string, unknown>,
    };
  });
}

/**
 * 端口名 → 语义色。
 *
 * 规范 §2 第二条原则：「绿 = 成功；红 = 失败……**同一语义在全应用只有一种表达**」。
 * 节点右上角的「完成」是绿字，那连线上的 `success` 就不能是灰的。
 * 对工作流编辑器来说「失败走哪条线」恰恰是最需要一眼看清的信息。
 *
 * branch 的 cases 端口（`high` / `low` 这类自定义名）归强调紫 ——
 * 它表达的是「这里要做判断」，与成功/失败是不同性质的分叉。
 */
function portLabelColor(port: string): string {
  if (port === 'success' || port === 'approved') return 'var(--color-status-success)';
  if (port === 'failed' || port === 'rejected' || port === 'error') {
    return 'var(--color-status-failed)';
  }
  if (port === 'timeout' || port === 'changes_requested') return 'var(--color-status-waiting)';
  // 内建的「就这一条路」端口不承载判断信息，保持中性
  if (port === 'out' || port === 'next' || port === 'done') return 'var(--color-neutral-500)';
  return 'var(--color-accent-300)';
}

/**
 * 哪些源节点**实际上**分叉了 —— 只有它们的出边需要标端口名。
 *
 * 判据是「这个源节点**实际上**分叉了没有」，而不是「它的类型允许几个输出端口」。
 * 按类型判的话，script.shell 定义里有 success/failed 两个端口，于是一条纯线性
 * 的流程每段都会顶着一个「success」—— 12 条边 12 个标签，全是噪声，
 * 还会被相邻节点裁掉半截。设计图里线上本来就是干净的。
 *
 * 只有同一个源节点接出了多条边、且用的端口不止一种时，标签才承载信息
 * （「这条走成功、那条走失败」）。
 */
function forkedSourceNodes(graph: WorkflowGraph): ReadonlySet<string> {
  // 单次遍历建 sourceNodeId → 用过的端口集合，避免每条边都 filter 全部边（O(E²)）
  const portsBySource = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const ports = portsBySource.get(edge.source.nodeId);
    if (ports) ports.add(edge.source.port);
    else portsBySource.set(edge.source.nodeId, new Set([edge.source.port]));
  }
  const forked = new Set<string>();
  for (const [nodeId, ports] of portsBySource) {
    if (ports.size > 1) forked.add(nodeId);
  }
  return forked;
}

export interface ToFlowEdgeOptions {
  /** 正在等待审批的节点。指向它的连线要把视线引过去（§5.3）。 */
  waitingNodeId?: string | null;
  /** AI 提议新增的连线 id。 */
  proposedEdgeIds?: ReadonlySet<string>;
}

export function toFlowEdges(graph: WorkflowGraph, options: ToFlowEdgeOptions = {}): Edge[] {
  const forked = forkedSourceNodes(graph);

  return graph.edges.map((edge) => {
    return {
      id: edge.id,
      source: edge.source.nodeId,
      target: edge.target.nodeId,
      // 路径由 FloatingEdge 按两端节点的矩形实时算（四条边中点里 4×4
      // 取最近的一对），见 edgeGeometry.ts
      type: 'floating',
      /*
       * XYFlow 的**解析锚点**，不是画线用的坐标。
       *
       * 边不指定 handle 时 XYFlow 会去找 `id === null` 的那个，而节点上的
       * 四个 handle 都带 id，于是每条边都报
       * `Couldn't create edge for target handle id: "null"`，一条线都画不出来。
       *
       * FloatingEdge 不读这两个值 —— 端点方向随节点相对位置实时变，
       * 写死在这里的话把节点拖到另一侧，线还从原来那条边出去。
       */
      sourceHandle: 'out-right',
      targetHandle: 'in-left',
      /*
       * 箭头：设计图里 `markerEnd: 'url(#arrow)'` 是**无条件**给每条线的。
       * 没有箭头就看不出方向 —— 而工作流的边是有向的，
       * 「谁在前谁在后」是读这张图的第一件事。
       */
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: 'var(--color-neutral-600)',
      },
      // 逻辑端口留在 data 里：连线选中后可以在右键菜单里切换。
      // fallbackSize 供 measured 尚未算出时兜底，值与 .wf-node 的样式一致。
      data: {
        sourcePort: edge.source.port,
        targetPort: edge.target.port,
        fallbackSize: { width: NODE_WIDTH, height: NODE_HEIGHT },
      },
      ...(forked.has(edge.source.nodeId) ? { label: edge.source.port } : {}),
      labelStyle: { fill: portLabelColor(edge.source.port), fontSize: 11 },
      /*
       * 标签底色必须显式给出。XYFlow 的 `.react-flow__edge-textbg` 取
       * `--xy-edge-label-background-color-default`，那个变量有 #ffffff / #141414
       * 两个值，深色那份只在 dark colorMode 下生效 —— 而 EditorPage 从不传
       * colorMode（默认 light）。不覆盖的话，暗场画布上每条连线中央都压着
       * 一块白色药丸，是整屏最亮的东西。
       */
      labelBgStyle: { fill: 'var(--color-surface)', fillOpacity: 0.92 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      /*
       * §5.3 的四种连线里，「指向等待节点」与「AI 提议」靠 dash 节奏区分，
       * 都走 flow 动画（stroke-dashoffset，只动这一个属性，符合 §4.1）。
       * 目的分别是「视线自然被引到待办」和「让用户看出哪几条是新加的」。
       */
      ...(options.proposedEdgeIds?.has(edge.id)
        ? { className: 'react-flow__edge--proposed' }
        : options.waitingNodeId && edge.target.nodeId === options.waitingNodeId
          ? { className: 'react-flow__edge--waiting' }
          : {}),
    };
  });
}

/**
 * 新建连线时该用哪个输出端口。
 *
 * 图纸的画布只连「节点到节点」（原型里 edges 就是二元组），
 * 而契约的边必须带端口。所以默认取第一个输出端口，
 * 需要接 failed / changes_requested 这类分支时在连线右键菜单里切换。
 * 这是图纸未覆盖但 M1 出口标准必需的扩展。
 */
export function defaultSourcePort(type: NodeType, config: unknown): string | null {
  const outputs = resolveNodeOutputs(type, config);
  return outputs[0]?.id ?? null;
}

export function defaultTargetPort(type: NodeType): string | null {
  return getNodeDefinition(type).ports.inputs[0]?.id ?? null;
}
