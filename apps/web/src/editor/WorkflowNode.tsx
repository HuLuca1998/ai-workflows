import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeType } from '@aiwf/contracts';
import { TONE_VISUALS, iconFor, isAiNode, type NodeTone } from './nodeVisuals.js';

/**
 * 画布上的节点，严格照图纸「02 画布编辑器」。
 *
 * 四个连接点：左 / 上是输入，右 / 下是输出（照图纸）。
 *
 * 它们是**物理**连接点，只管交互；逻辑端口（success / failed / approved…）
 * 由连线自己记录，在有分叉时显示成线上的标签。
 */

/**
 * 四个连接点，与设计图一致：左 / 上是输入，右 / 下是输出。
 *
 * 端口的**方向**是固定的（这是交互约定），但连线的**端点**不固定 ——
 * 路径由 FloatingEdge 在两端各四条边中点里取最近的一对（见 edgeGeometry）。
 * 两件事分开：Handle 管「从哪能拖出、能落在哪」，几何管「线怎么画」。
 */
const SIDES = [
  { side: 'left', position: Position.Left, type: 'target' },
  { side: 'top', position: Position.Top, type: 'target' },
  { side: 'right', position: Position.Right, type: 'source' },
  { side: 'bottom', position: Position.Bottom, type: 'source' },
] as const;

export interface WorkflowNodeData extends Record<string, unknown> {
  type: NodeType;
  title: string;
  /** 副文本：图纸里放的是节点的关键配置摘要。 */
  sub: string;
  tone: NodeTone;
  /** 扇出 / 汇聚徽标，空串表示不显示。 */
  joinBadge: string;
  /** 校验有问题时画布上要能定位到（图纸：工具栏转为问题计数并可定位）。 */
  hasIssue?: boolean;
}

export const WorkflowNode = memo(function WorkflowNode({ data, selected }: NodeProps) {
  const node = data as WorkflowNodeData;
  const visual = TONE_VISUALS[node.tone];

  return (
    <div
      className="wf-node"
      data-tone={node.tone}
      data-selected={selected ? 'true' : undefined}
      data-issue={node.hasIssue ? 'true' : undefined}
    >
      <div className="wf-node__head">
        <i
          className={`ph ${iconFor(node.type)}`}
          data-ai={isAiNode(node.type) ? 'true' : undefined}
          aria-hidden="true"
        />
        <span className="wf-node__title">{node.title}</span>
        {node.joinBadge ? <span className="wf-node__join">{node.joinBadge}</span> : null}
        <span className="wf-node__badge" data-filled={visual.badgeFilled ? 'true' : undefined}>
          {visual.badge}
        </span>
      </div>
      <div className="wf-node__sub">{node.sub}</div>

      {SIDES.map(({ side, position, type }) => (
        <Handle
          key={side}
          type={type}
          position={position}
          id={`${type === 'target' ? 'in' : 'out'}-${side}`}
          className="wf-port"
        />
      ))}
    </div>
  );
});
