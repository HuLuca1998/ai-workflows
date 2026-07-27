// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@aiwf/contracts';
import { groupBoxes } from '../src/editor/GroupFrame.js';

/**
 * 分组框跟着成员节点走：它不是独立实体，每次渲染由成员位置算出来。
 */

const graph = (groups: WorkflowGraph['groups']): WorkflowGraph => ({
  nodes: [
    {
      id: 'a',
      type: 'script.shell',
      title: 'A',
      position: { x: 100, y: 100 },
      config: { interpreter: 'zsh', script: 'a' },
    },
    {
      id: 'b',
      type: 'script.shell',
      title: 'B',
      position: { x: 400, y: 250 },
      config: { interpreter: 'zsh', script: 'b' },
    },
  ],
  edges: [],
  groups,
});

describe('包围盒', () => {
  it('框住全部成员并外扩一圈', () => {
    const [box] = groupBoxes(graph([{ id: 'g1', title: '阶段一', nodeIds: ['a', 'b'] }]));
    // 节点 210×66：成员横跨 x 100→610、y 100→316，四周各外扩 18
    expect(box).toMatchObject({ id: 'g1', title: '阶段一', x: 82, y: 82 });
    expect(box?.width).toBe(546);
    expect(box?.height).toBe(252);
  });

  it('只框住属于这个分组的节点', () => {
    const [box] = groupBoxes(graph([{ id: 'g1', title: '只有 A', nodeIds: ['a'] }]));
    expect(box?.width).toBe(NODE_W + 36);
  });

  it('成员被删光的分组不出框，但数据还在', () => {
    const boxes = groupBoxes(graph([{ id: 'g1', title: '空分组', nodeIds: ['已删除的节点'] }]));
    expect(boxes).toEqual([]);
  });

  it('多个分组各算各的', () => {
    const boxes = groupBoxes(
      graph([
        { id: 'g1', title: '一', nodeIds: ['a'] },
        { id: 'g2', title: '二', nodeIds: ['b'] },
      ]),
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.x).toBeLessThan(boxes[1]?.x ?? 0);
  });
});

const NODE_W = 210;
