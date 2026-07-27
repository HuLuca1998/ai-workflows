import type { WorkflowDiff, DiffEntry } from './patch.js';
import type { GraphNode, WorkflowGraph } from './graph.js';

/**
 * 两份图之间的差异。
 *
 * 用途：版本抽屉里「草稿 vs 某个已发布版本」的对比，以及 workflow.diff。
 * 与 applyPatch 产出的 Diff 是同一种结构，界面用同一套渲染。
 *
 * 位置变化**不算改动**：布局不影响执行语义，把挪动节点也标成变更
 * 会让版本对比被噪音淹没。
 */
export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): WorkflowDiff {
  const diff: WorkflowDiff = { added: [], removed: [], changed: [] };

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  for (const node of after.nodes) {
    if (!beforeNodes.has(node.id)) {
      diff.added.push({
        kind: 'node',
        id: node.id,
        label: `node ${node.type}「${node.title}」`,
        after: node.config,
      });
    }
  }

  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) {
      diff.removed.push({
        kind: 'node',
        id: node.id,
        label: `node ${node.type}「${node.title}」`,
        before: node.config,
      });
    }
  }

  for (const node of after.nodes) {
    const old = beforeNodes.get(node.id);
    if (!old) continue;
    const entry = describeNodeChange(old, node);
    if (entry) diff.changed.push(entry);
  }

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) {
      diff.added.push({ kind: 'edge', id: edge.id, label: edgeLabel(edge), after: edge });
    }
  }
  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) {
      diff.removed.push({ kind: 'edge', id: edge.id, label: edgeLabel(edge), before: edge });
    }
  }

  const beforeGroups = new Map(before.groups.map((g) => [g.id, g]));
  const afterGroups = new Map(after.groups.map((g) => [g.id, g]));

  for (const group of after.groups) {
    if (!beforeGroups.has(group.id)) {
      diff.added.push({
        kind: 'group',
        id: group.id,
        label: `group「${group.title}」`,
        after: group,
      });
    }
  }
  for (const group of before.groups) {
    if (!afterGroups.has(group.id)) {
      diff.removed.push({
        kind: 'group',
        id: group.id,
        label: `group「${group.title}」`,
        before: group,
      });
    }
  }

  return diff;
}

function edgeLabel(edge: WorkflowGraph['edges'][number]): string {
  return `edge ${edge.source.nodeId}.${edge.source.port} → ${edge.target.nodeId}`;
}

function describeNodeChange(before: GraphNode, after: GraphNode): DiffEntry | null {
  const parts: string[] = [];

  if (before.title !== after.title) {
    parts.push(`标题 ${before.title} → ${after.title}`);
  }

  const beforeConfig = (before.config ?? {}) as Record<string, unknown>;
  const afterConfig = (after.config ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeConfig), ...Object.keys(afterConfig)])) {
    const a = beforeConfig[key];
    const b = afterConfig[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    parts.push(`${key} ${format(a)} → ${format(b)}`);
  }

  if (JSON.stringify(before.join) !== JSON.stringify(after.join)) {
    parts.push(`汇聚策略 ${before.join?.strategy ?? '默认'} → ${after.join?.strategy ?? '默认'}`);
  }

  // 位置刻意不比较：布局变化不影响执行语义
  if (parts.length === 0) return null;

  return {
    kind: 'node',
    id: after.id,
    label: `node ${after.id}：${parts.join('，')}`,
    before: before.config,
    after: after.config,
  };
}

/** 值太长时截断，Diff 行要能一眼看完。 */
function format(value: unknown): string {
  if (value === undefined) return '未设置';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}
