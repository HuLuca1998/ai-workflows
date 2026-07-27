// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NODE_TYPES } from '@aiwf/contracts';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  TONE_VISUALS,
  iconFor,
  isAiNode,
  joinBadge,
} from '../src/editor/nodeVisuals.js';

/**
 * 节点视觉规格。数值与图标都取自图纸「02 画布编辑器」，
 * 这些测试的作用是防止后续重构时被「顺手调整」——图纸是已确认的最终形态。
 */

describe('尺寸与徽标', () => {
  it('节点尺寸与图纸一致：210 × 66', () => {
    expect(NODE_WIDTH).toBe(210);
    expect(NODE_HEIGHT).toBe(66);
  });

  it('四种 tone 的徽标文案与图纸一致', () => {
    expect(TONE_VISUALS.done.badge).toBe('完成');
    expect(TONE_VISUALS.wait.badge).toBe('等待');
    expect(TONE_VISUALS.idle.badge).toBe('待运行');
    expect(TONE_VISUALS.ghost.badge).toBe('新增');
  });

  it('等待与新增用实心徽标，完成与待运行只有文字色', () => {
    expect(TONE_VISUALS.wait.badgeFilled).toBe(true);
    expect(TONE_VISUALS.ghost.badgeFilled).toBe(true);
    expect(TONE_VISUALS.done.badgeFilled).toBe(false);
    expect(TONE_VISUALS.idle.badgeFilled).toBe(false);
  });
});

describe('图标', () => {
  it('16 种节点类型每种都有图标，没有落到兜底值', () => {
    for (const type of NODE_TYPES) {
      expect(iconFor(type)).not.toBe('ph-circle');
      expect(iconFor(type).startsWith('ph-')).toBe(true);
    }
  });

  it('关键类型的图标与图纸示例一致', () => {
    expect(iconFor('entry')).toBe('ph-sign-in');
    expect(iconFor('ai.analyze')).toBe('ph-magnifying-glass');
    expect(iconFor('ai.review')).toBe('ph-eyes');
    expect(iconFor('ai.decide')).toBe('ph-scales');
    expect(iconFor('ai.execute')).toBe('ph-hammer');
    expect(iconFor('approval')).toBe('ph-user-check');
    expect(iconFor('git.worktree')).toBe('ph-git-branch');
    expect(iconFor('script.shell')).toBe('ph-terminal-window');
    expect(iconFor('notify')).toBe('ph-bell-ringing');
    expect(iconFor('subworkflow')).toBe('ph-tree-structure');
  });

  it('只有 AI 组的节点算 AI 节点（图标用强调色）', () => {
    expect(isAiNode('ai.analyze')).toBe(true);
    expect(isAiNode('ai.execute')).toBe(true);
    expect(isAiNode('script.shell')).toBe(false);
    expect(isAiNode('approval')).toBe(false);
  });
});

describe('扇出与汇聚徽标', () => {
  it('单进单出不显示徽标', () => {
    expect(joinBadge(1, 1)).toBe('');
    expect(joinBadge(0, 1)).toBe('');
  });

  it('一对多显示 ⋔ 加路数', () => {
    expect(joinBadge(1, 3)).toBe('⋔3');
  });

  it('多对一按汇聚策略显示不同符号', () => {
    expect(joinBadge(3, 1, 'all')).toBe('⋀3');
    expect(joinBadge(3, 1, 'any')).toBe('⋁3');
    expect(joinBadge(3, 1, 'quorum')).toBe('⋁3');
    expect(joinBadge(3, 1, 'sequential')).toBe('↧3');
    // 没给策略时按默认的「等待全部」
    expect(joinBadge(2, 1)).toBe('⋀2');
  });

  it('既汇聚又扇出显示 ⋀⋔', () => {
    expect(joinBadge(3, 2)).toBe('⋀⋔');
  });
});
