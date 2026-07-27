import type { Edge, Node } from '@xyflow/react';
import {
  fanIn,
  fanOut,
  getNodeDefinition,
  resolveNodeOutputs,
  type NodeType,
  type ValidationIssue,
  type WorkflowGraph,
} from '@aiwf/contracts';
import { joinBadge, type NodeTone } from './nodeVisuals.js';
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
      return `触发：${c.trigger ?? 'manual'}`;
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
    };
    return {
      id: node.id,
      type: 'workflow',
      position: node.position,
      data: data as unknown as Record<string, unknown>,
    };
  });
}

export function toFlowEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source.nodeId,
    target: edge.target.nodeId,
    // 不给 type：节点那边有注册的 `workflow` 组件，边这边没有 ——
    // 标一个未注册的类型，React Flow 会静默退回默认样式，
    // 同时每渲染一次就往控制台刷一条警告（一次编辑累计几十条）。
    // 图纸里的连线本来就是默认样式，不需要自定义组件
    // 逻辑端口留在 data 里：连线选中后可以在右键菜单里切换
    data: { sourcePort: edge.source.port, targetPort: edge.target.port },
    label: edge.source.port,
  }));
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
