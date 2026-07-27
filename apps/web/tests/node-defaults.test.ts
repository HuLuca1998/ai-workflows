// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NODE_TYPES, getNodeDefinition } from '@aiwf/contracts';
import { minimalConfigFor, titleFor } from '../src/editor/nodeDefaults.js';

/**
 * 从节点库拖进画布的初始状态。
 *
 * 关键约束：**结构合法但内容明显待填**。
 * 结构不合法节点加不进来；内容假装填好会让人以为不用配。
 */

describe('初始配置', () => {
  it('16 种节点拖进来都能通过各自的 Schema 校验', () => {
    for (const type of NODE_TYPES) {
      const config = minimalConfigFor(type);
      const parsed = getNodeDefinition(type).configSchema.safeParse(config);
      expect(
        parsed.success,
        `${type} 的初始配置不合法：${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    }
  });

  it('Schema 默认值被填进去，运行时行为不依赖读取方', () => {
    const shell = minimalConfigFor('script.shell') as {
      outputLimitBytes?: number;
      timeoutMs?: number;
    };
    expect(shell.outputLimitBytes).toBeGreaterThan(0);
    expect(shell.timeoutMs).toBeGreaterThan(0);
  });

  it('必填内容用「待填写」这类明显的占位，不假装已经配好', () => {
    const analyze = minimalConfigFor('ai.analyze') as {
      instruction: string;
      agentProfileId: string;
    };
    expect(analyze.instruction).toMatch(/待填写/u);
    expect(analyze.agentProfileId).toMatch(/待选择/u);

    const approval = minimalConfigFor('approval') as { title: string };
    expect(approval.title).toMatch(/待填写/u);
  });

  it('每种节点都有中文标题，不落到英文兜底', () => {
    for (const type of NODE_TYPES) {
      expect(titleFor(type).length).toBeGreaterThan(0);
    }
    expect(titleFor('entry')).toBe('入口设置');
    expect(titleFor('script.python')).toBe('Python 脚本');
  });
});
