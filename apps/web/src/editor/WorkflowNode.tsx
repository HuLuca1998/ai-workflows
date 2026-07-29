import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeType } from '@aiwf/contracts';
import { TONE_VISUALS, iconFor, isAiNode, type NodeTone } from './nodeVisuals.js';

/**
 * 画布上的节点，严格照图纸「02 画布编辑器」。
 *
 * 四个连接点也来自图纸：左 / 上是输入（neutral-800），右 / 下是输出
 * （neutral-600，cursor:crosshair）。它们是物理连接点，逻辑端口
 * （success / failed / approved…）由连线自己记录。
 */

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

      {/* 输入：左与上 */}
      <Handle type="target" position={Position.Left} id="in-left" className="wf-port wf-port--in" />
      <Handle type="target" position={Position.Top} id="in-top" className="wf-port wf-port--in" />
      {/* 输出：右与下 */}
      <Handle
        type="source"
        position={Position.Right}
        id="out-right"
        className="wf-port wf-port--out"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="out-bottom"
        className="wf-port wf-port--out"
      />
    </div>
  );
});
