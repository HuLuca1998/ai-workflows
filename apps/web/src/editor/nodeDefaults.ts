import { getNodeDefinition, type NodeType } from '@aiwf/contracts';

/**
 * 从节点库拖入画布时的初始标题与配置。
 *
 * 配置只填**能填的**：必填字段给一个明显是占位的值（如 `待填写`），
 * 可选字段一律交给 Schema 的默认值。刚拖进来的节点校验不通过是对的——
 * 工具栏会显示问题计数，用户点开配置补齐。给一个「看起来能跑」的假配置
 * 反而会让人以为不用配。
 */

/**
 * 节点的显示名。
 *
 * 直接读契约 —— 之前这里还有一张 `Record<NodeType, string>` 的副本，
 * 而它的每一项都与 definition.title 一字不差：完全冗余，却让
 * 「新增节点类型不改 UI 代码」这条承诺不成立（Record 要求每个键都在）。
 */
export function titleFor(type: NodeType): string {
  return getNodeDefinition(type).title;
}

export function minimalConfigFor(type: NodeType): unknown {
  const seed = getNodeDefinition(type).seed ?? {};
  // 过一遍 Schema：填上默认值，同时保证拖进来的节点结构一定合法
  const parsed = getNodeDefinition(type).configSchema.safeParse(seed);
  return parsed.success ? parsed.data : seed;
}

/**
 * 从节点库**点**出来的节点落在哪：基准点没被占就用基准点，
 * 被占就阶梯错开（+28,+28）直到空位。
 *
 * 没有它时连点几次全叠在同一坐标 —— 画布只看得见最后一个，
 * 用户以为前几次点击没生效（第 2 轮实测 P6）。
 */
export function cascadeFrom(
  nodes: readonly { position: { x: number; y: number } }[],
  base: { x: number; y: number },
): { x: number; y: number } {
  const occupied = (p: { x: number; y: number }) =>
    nodes.some((node) => Math.abs(node.position.x - p.x) < 8 && Math.abs(node.position.y - p.y) < 8);
  let position = base;
  while (occupied(position)) {
    position = { x: position.x + 28, y: position.y + 28 };
  }
  return position;
}
