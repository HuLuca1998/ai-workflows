import type { WorkflowGraph } from './editorDeps.js';
import { NODE_HEIGHT, NODE_WIDTH } from './nodeVisuals.js';

/** 分组框相对成员节点外扩的距离；标题标签压在上边框上。 */
const PADDING = 18;

export interface GroupBox {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 算出每个分组的包围盒。
 *
 * 图纸里分组是「带标题的虚线框」，跟着成员节点走——所以它不是独立实体，
 * 而是每次渲染由成员位置算出来的。成员被删光的分组不出框（但仍在数据里，
 * 用户可以再往里拖节点）。
 */
export function groupBoxes(graph: WorkflowGraph): GroupBox[] {
  return graph.groups
    .map((group) => {
      const members = graph.nodes.filter((node) => group.nodeIds.includes(node.id));
      if (members.length === 0) return null;

      const xs = members.map((n) => n.position.x);
      const ys = members.map((n) => n.position.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs) + NODE_WIDTH;
      const maxY = Math.max(...ys) + NODE_HEIGHT;

      return {
        id: group.id,
        title: group.title,
        x: minX - PADDING,
        y: minY - PADDING,
        width: maxX - minX + PADDING * 2,
        height: maxY - minY + PADDING * 2,
      };
    })
    .filter((box): box is GroupBox => box !== null);
}

export interface GroupLayerProps {
  boxes: readonly GroupBox[];
  onContextMenu: (groupId: string, at: { x: number; y: number }) => void;
}

/**
 * 分组层。渲染在节点下方（z-index 0），只负责画框与标题——
 * 拖动分组整体移动要等 M1 之后，图纸也没给这个交互。
 */
export function GroupLayer({ boxes, onContextMenu }: GroupLayerProps) {
  return (
    <>
      {boxes.map((box) => (
        <div
          key={box.id}
          className="wf-group"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onContextMenu(box.id, { x: event.clientX, y: event.clientY });
          }}
        >
          <span className="wf-group__title">{box.title}</span>
        </div>
      ))}
    </>
  );
}
