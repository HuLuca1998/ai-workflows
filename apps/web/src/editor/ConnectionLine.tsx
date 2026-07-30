import type { ConnectionLineComponentProps } from '@xyflow/react';
import { nearestPortTo, previewPath, type NodeRect } from './edgeGeometry.js';

/**
 * 拖新连线时的预览线。
 *
 * 源端口跟着鼠标方位换：鼠标移到节点右侧就从 right 出发，移到下方就切到
 * bottom —— 与设计图一致。XYFlow 默认从「被按下的那个 Handle」出发，
 * 于是从下方拖出去的线会先向右甩一段再折回来。
 *
 * 路径几何全部委托给 edgeGeometry.previewPath（纯函数，可单测）；
 * 这里只负责取节点矩形和描边样式。
 *
 * 描边取值照设计图那一行：
 * `stroke: 'var(--color-accent-400)', strokeWidth: 1.8, strokeDasharray: '4 4'`
 * —— 虚线是「还没连上」的信号，实线会让人以为已经建立了连接。
 */
export function ConnectionLine({
  toX,
  toY,
  fromNode,
  connectionStatus,
}: ConnectionLineComponentProps) {
  if (!fromNode) return null;

  const rect: NodeRect = {
    x: fromNode.internals.positionAbsolute.x,
    y: fromNode.internals.positionAbsolute.y,
    width: fromNode.measured?.width ?? 210,
    height: fromNode.measured?.height ?? 66,
  };
  const cursor = { x: toX, y: toY };
  const from = nearestPortTo(rect, cursor);

  return (
    <g>
      <path
        d={previewPath(rect, cursor)}
        fill="none"
        strokeWidth={1.8}
        strokeDasharray="4 4"
        // 落点不合法时转成失败色，用户立刻知道这儿放不下
        stroke={
          connectionStatus === 'invalid' ? 'var(--color-status-failed)' : 'var(--color-accent-400)'
        }
      />
      {/* 起点上画一个实心点，明确「线是从这条边出去的」 */}
      <circle cx={from.x} cy={from.y} r={3.5} fill="var(--color-accent-400)" />
    </g>
  );
}
