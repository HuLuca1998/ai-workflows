import type { NodeType, PatchOperation, WorkflowGraph } from './editorDeps.js';
import { resolveNodeOutputs } from './editorDeps.js';

/**
 * 画布右键菜单。
 *
 * 菜单项来自功能文档 §3.1：
 * - 节点：编辑配置 / 复制 / 断开全部连线 / 用选中节点建分组 / 删除
 * - 连线：删除 / 反转方向 / 在连线上插入节点
 * - 分组：重命名 / 解散
 *
 * 「切换源端口」是图纸未覆盖但必需的一项：图纸的连线是节点到节点二元组，
 * 而契约的边带逻辑端口，搭 Issue 修复模板要用到 failed / changes_requested
 * 这类分支。放进已有的连线菜单里，不新增界面元素。
 *
 * 这里只算「点了之后要做什么」，不碰 DOM——所以能单测。
 */

export type MenuTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'canvas' };

export interface MenuItem {
  id: string;
  label: string;
  /** 需要用户再输入或再选一次（如重命名、切换端口）。 */
  needsInput?: boolean;
  /** 破坏性操作，界面上单独标出来。 */
  danger?: boolean;
  disabled?: boolean;
  /** 禁用原因，直接显示给用户。 */
  disabledReason?: string;
}

export interface MenuContext {
  graph: WorkflowGraph;
  /** 当前选中的节点（决定「建分组」是否可用）。 */
  selection: readonly string[];
}

export function menuItemsFor(target: MenuTarget, ctx: MenuContext): MenuItem[] {
  switch (target.kind) {
    case 'node': {
      const node = ctx.graph.nodes.find((n) => n.id === target.nodeId);
      const connected = ctx.graph.edges.some(
        (e) => e.source.nodeId === target.nodeId || e.target.nodeId === target.nodeId,
      );
      const groupable = ctx.selection.length >= 2;
      return [
        { id: 'edit', label: '编辑配置' },
        { id: 'duplicate', label: '复制' },
        {
          id: 'disconnect',
          label: '断开全部连线',
          disabled: !connected,
          ...(connected ? {} : { disabledReason: '这个节点还没有连线' }),
        },
        {
          id: 'group',
          label: '用选中节点建分组',
          disabled: !groupable,
          ...(groupable ? {} : { disabledReason: '先选中两个以上节点' }),
        },
        {
          id: 'delete',
          label: '删除',
          danger: true,
          // 入口节点删掉后工作流无从启动，但仍允许删——用户可能要换一个
          ...(node?.type === 'entry' ? { disabledReason: '' } : {}),
        },
      ];
    }

    case 'edge': {
      const edge = ctx.graph.edges.find((e) => e.id === target.edgeId);
      const source = ctx.graph.nodes.find((n) => n.id === edge?.source.nodeId);
      const ports = source ? resolveNodeOutputs(source.type, source.config) : [];
      return [
        {
          id: 'switch-port',
          label: '切换源端口…',
          needsInput: true,
          disabled: ports.length < 2,
          ...(ports.length < 2 ? { disabledReason: '这个节点只有一个输出端口' } : {}),
        },
        { id: 'reverse', label: '反转方向' },
        { id: 'insert-node', label: '在连线上插入节点…', needsInput: true },
        { id: 'delete-edge', label: '删除连线', danger: true },
      ];
    }

    case 'group':
      return [
        { id: 'rename-group', label: '重命名…', needsInput: true },
        { id: 'dissolve-group', label: '解散分组', danger: true },
      ];

    case 'canvas':
      return [
        {
          id: 'group',
          label: '用选中节点建分组',
          disabled: ctx.selection.length < 2,
          ...(ctx.selection.length < 2 ? { disabledReason: '先选中两个以上节点' } : {}),
        },
      ];
  }
}

export interface MenuActionInput {
  /** 重命名的新标题、切换到的端口 id 等。 */
  value?: string;
  /** 插入节点时选的类型。 */
  nodeType?: NodeType;
  /** 插入节点用的初始配置与标题（由调用方按类型给）。 */
  nodeTitle?: string;
  nodeConfig?: unknown;
}

/**
 * 把菜单动作翻译成结构化 Patch。
 * 返回空数组表示这个动作不改图（如「编辑配置」只是打开弹层）。
 */
export function operationsFor(
  itemId: string,
  target: MenuTarget,
  ctx: MenuContext,
  input: MenuActionInput = {},
): PatchOperation[] {
  const { graph } = ctx;

  switch (itemId) {
    case 'duplicate': {
      if (target.kind !== 'node') return [];
      const node = graph.nodes.find((n) => n.id === target.nodeId);
      if (!node) return [];
      // 复制品偏移一点，否则叠在原节点上看不出来
      return [
        {
          op: 'addNode',
          type: node.type,
          title: `${node.title} 副本`,
          position: { x: node.position.x + 40, y: node.position.y + 40 },
          config: node.config,
        },
      ];
    }

    case 'disconnect': {
      if (target.kind !== 'node') return [];
      return graph.edges
        .filter((e) => e.source.nodeId === target.nodeId || e.target.nodeId === target.nodeId)
        .map((e) => ({ op: 'disconnect' as const, edgeId: e.id }));
    }

    case 'delete': {
      if (target.kind !== 'node') return [];
      // removeNode 会连带断开相关连线（contracts 的 applyPatch 保证）
      return [{ op: 'removeNode', nodeId: target.nodeId }];
    }

    case 'group': {
      if (ctx.selection.length < 2) return [];
      return [
        {
          op: 'createGroup',
          title: input.value?.trim() || '新分组',
          nodeIds: [...ctx.selection],
        },
      ];
    }

    case 'delete-edge': {
      if (target.kind !== 'edge') return [];
      return [{ op: 'disconnect', edgeId: target.edgeId }];
    }

    case 'reverse': {
      if (target.kind !== 'edge') return [];
      const edge = graph.edges.find((e) => e.id === target.edgeId);
      if (!edge) return [];
      const newSource = graph.nodes.find((n) => n.id === edge.target.nodeId);
      const newTarget = graph.nodes.find((n) => n.id === edge.source.nodeId);
      if (!newSource || !newTarget) return [];

      const sourcePort = resolveNodeOutputs(newSource.type, newSource.config)[0]?.id;
      // 反转后的方向可能根本不合法（如反转后从 end 出发），此时什么都不做
      if (!sourcePort) return [];

      return [
        { op: 'disconnect', edgeId: target.edgeId },
        {
          op: 'connect',
          source: { nodeId: newSource.id, port: sourcePort },
          target: { nodeId: newTarget.id, port: 'input' },
        },
      ];
    }

    case 'switch-port': {
      if (target.kind !== 'edge' || !input.value) return [];
      const edge = graph.edges.find((e) => e.id === target.edgeId);
      if (!edge) return [];
      // 换端口 = 断开重连：结构化操作里没有「改边端口」这一项，
      // 保持操作原语最小，Diff 上也能看清是哪条边变了
      return [
        { op: 'disconnect', edgeId: target.edgeId },
        {
          op: 'connect',
          source: { nodeId: edge.source.nodeId, port: input.value },
          target: { nodeId: edge.target.nodeId, port: edge.target.port },
        },
      ];
    }

    case 'insert-node': {
      if (target.kind !== 'edge' || !input.nodeType) return [];
      const edge = graph.edges.find((e) => e.id === target.edgeId);
      if (!edge) return [];
      const from = graph.nodes.find((n) => n.id === edge.source.nodeId);
      const to = graph.nodes.find((n) => n.id === edge.target.nodeId);
      if (!from || !to) return [];

      const newId = `${input.nodeType.replace(/\./gu, '_')}_${graph.nodes.length + 1}`;
      const inserted = {
        x: (from.position.x + to.position.x) / 2,
        y: (from.position.y + to.position.y) / 2 + 90,
      };
      const outPort = resolveNodeOutputs(input.nodeType, input.nodeConfig)[0]?.id;
      if (!outPort) return [];

      return [
        {
          op: 'addNode',
          nodeId: newId,
          type: input.nodeType,
          title: input.nodeTitle ?? '新节点',
          position: inserted,
          config: input.nodeConfig,
        },
        { op: 'disconnect', edgeId: target.edgeId },
        {
          op: 'connect',
          source: { nodeId: from.id, port: edge.source.port },
          target: { nodeId: newId, port: 'input' },
        },
        {
          op: 'connect',
          source: { nodeId: newId, port: outPort },
          target: { nodeId: to.id, port: edge.target.port },
        },
      ];
    }

    case 'rename-group': {
      if (target.kind !== 'group' || !input.value?.trim()) return [];
      const group = graph.groups.find((g) => g.id === target.groupId);
      if (!group) return [];
      // 没有「改分组标题」的原语，用删除 + 重建表达
      return [
        { op: 'deleteGroup', groupId: target.groupId },
        {
          op: 'createGroup',
          groupId: target.groupId,
          title: input.value.trim(),
          nodeIds: group.nodeIds,
        },
      ];
    }

    case 'dissolve-group': {
      if (target.kind !== 'group') return [];
      return [{ op: 'deleteGroup', groupId: target.groupId }];
    }

    default:
      // edit 之类只影响界面状态，不产生 Patch
      return [];
  }
}
