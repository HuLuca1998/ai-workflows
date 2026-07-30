import {
  BaseEdge,
  EdgeText,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
  type Node,
} from '@xyflow/react';
import { bestPorts, bezPath, type NodeRect } from './edgeGeometry.js';

/**
 * 连线：端点按两端节点的矩形实时选，不绑定 Handle。
 *
 * 换掉 XYFlow 默认边的理由：默认边的 sourceX/sourceY 来自 Handle 的 DOM 位置，
 * 而「该从哪条边出去」是随两个节点的相对位置变的。给四个方位各注册一对 Handle
 * 之后，同 Position 的多个 Handle 会被并排摆开（它们是同级的绝对定位兄弟），
 * 于是端口点散落在卡片外、所有边都挂到第一个 Handle 上 ——
 * 横向排列的节点之间，线从底部绕出来再绕回去。
 *
 * 这里改成算：`bestPorts` 取两端 4×4 组合里最近的一对，`bezPath` 用端口的
 * 外法向量放控制点。节点一动，两个矩形就变，路径每帧重算 ——
 * 「拖到另一侧连线自动换边」不需要保存任何方向状态。
 *
 * 与设计图 `curve(a, b)` / `bez(p, q, d)` 逐字对应，见 edgeGeometry.ts。
 */

/**
 * 节点矩形。
 *
 * 用 `internals.positionAbsolute` 而不是 `node.position` —— 后者在分组里是
 * 相对父节点的，直接拿会让子节点的连线整体偏移。
 * 尺寸优先取 `measured`（DOM 实测），拿不到时才退回样式里的标称值：
 * 硬编码的尺寸一旦与实际不符，端点就会浮在卡片外或陷进卡片里。
 */
function rectOf(node: InternalNode<Node>, fallback: { width: number; height: number }): NodeRect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured?.width ?? fallback.width,
    height: node.measured?.height ?? fallback.height,
  };
}

const DEFAULT_SIZE = { width: 210, height: 66 };

export function FloatingEdge({
  id,
  source,
  target,
  markerEnd,
  style,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  data,
}: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  // 节点还没进 store（首帧、或刚被删）时不画 —— 画了也是错的坐标
  if (!sourceNode || !targetNode) return null;

  const fallback =
    (data as { fallbackSize?: { width: number; height: number } } | undefined)?.fallbackSize ??
    DEFAULT_SIZE;

  const { p, q, d } = bestPorts(rectOf(sourceNode, fallback), rectOf(targetNode, fallback));
  const path = bezPath(p, q, d);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        {...(style === undefined ? {} : { style })}
        // §5.3：「另有 14px 透明命中区，便于点选删除」。
        // 线本身只有 1.5px，没有热区的话要对着一根发丝点。
        interactionWidth={14}
      />
      {label === undefined ? null : (
        <EdgeText
          // 标签放两端口的中点。用端口中点而不是采样路径：够准，也不用解析 path。
          x={(p.x + q.x) / 2}
          y={(p.y + q.y) / 2}
          label={label}
          {...(labelStyle === undefined ? {} : { labelStyle })}
          {...(labelBgStyle === undefined ? {} : { labelBgStyle, labelShowBg: true })}
          {...(labelBgPadding === undefined ? {} : { labelBgPadding })}
          {...(labelBgBorderRadius === undefined ? {} : { labelBgBorderRadius })}
        />
      )}
    </>
  );
}
