import { getNodeDefinition, type NodeType } from '@aiwf/contracts';

/**
 * 节点在画布上的视觉规格。
 *
 * 全部取自图纸「02 画布编辑器」：节点 210×66、圆角 10、padding 10/12，
 * 三种 tone 各自的底色与边框，join 徽标与状态徽标的样式。
 * 数值不要改——图纸是已确认的最终形态。
 */

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 66;

/** 节点的运行态外观。M1 只会出现 idle 与 ghost（还没有运行数据）。 */
export type NodeTone = 'done' | 'wait' | 'idle' | 'ghost';

export interface ToneVisual {
  badge: string;
  /** 等待与新增用实心徽标，其余只有文字色。 */
  badgeFilled: boolean;
}

export const TONE_VISUALS: Record<NodeTone, ToneVisual> = {
  done: { badge: '完成', badgeFilled: false },
  wait: { badge: '等待', badgeFilled: true },
  idle: { badge: '待运行', badgeFilled: false },
  ghost: { badge: '新增', badgeFilled: true },
};

export function iconFor(type: NodeType): string {
  return getNodeDefinition(type).icon;
}

/** AI 节点的图标用强调色（图纸：n.ai ? accent-400 : neutral-300）。 */
export function isAiNode(type: NodeType): boolean {
  return getNodeDefinition(type).group === 'ai';
}

/**
 * 扇出 / 汇聚徽标（图纸 §3.1：⋔3 分发到 3 路，⋀3 等 3 路汇聚）。
 * 既扇出又汇聚时显示 ⋀⋔。
 */
export function joinBadge(inCount: number, outCount: number, strategy?: string): string {
  if (inCount > 1 && outCount > 1) return '⋀⋔';
  if (inCount > 1) return `${joinSymbol(strategy)}${inCount}`;
  if (outCount > 1) return `⋔${outCount}`;
  return '';
}

function joinSymbol(strategy?: string): string {
  switch (strategy) {
    case 'any':
    case 'quorum':
      return '⋁';
    case 'sequential':
      return '↧';
    default:
      return '⋀';
  }
}
