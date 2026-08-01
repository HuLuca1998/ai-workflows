import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IMPLEMENTED_NODE_TYPES, NODE_TYPES, getNodeDefinition } from '@aiwf/contracts';

import { NodeLibrary } from '../src/editor/NodeLibrary.js';

/**
 * 节点库不能替跑不了的节点背书。
 *
 * 第三方巡检 B-06 实测：16 种类型里 6 种引擎没实现，而节点库把它们
 * 与能跑的**摆得一模一样** —— 拖得进画布、配置表单字段齐全可填可存，
 * 只字不提。用户搭完整条流程点了「运行」，Dry Run 才说
 * 「branch 尚未实现，运行会在这个节点停下」。
 *
 * 这是纪律二的第三种形态：界面文案承诺了一件事，实现里没有对应代码。
 * 判据取自契约（`implemented`），不是这个文件里抄的一份清单 ——
 * 抄的那份会在某个类型接上之后继续说它没实现。
 */

const noop = vi.fn();
const view = () => render(<NodeLibrary onDragStart={noop} onAdd={noop} />);

/** 节点库把 script.shell / script.python 合成一条展示，其余一类一条。 */
const 条目名 = (type: (typeof NODE_TYPES)[number]) => getNodeDefinition(type).title;

describe('节点库要说清哪些跑不了', () => {
  it('未实现的类型带明确标记', () => {
    view();
    const 未实现 = NODE_TYPES.filter((type) => !IMPLEMENTED_NODE_TYPES.includes(type));
    expect(未实现.length, '契约说全都实现了？那这条测试该删了').toBeGreaterThan(0);

    for (const type of 未实现) {
      const item = document.querySelector(`[data-node-type="${type}"]`);
      expect(item, `${type}（${条目名(type)}）在节点库里找不到`).toBeTruthy();
      expect(
        item!.getAttribute('data-implemented'),
        `${条目名(type)} 引擎跑不了，节点库却没标 —— 用户搭完整条流程才会知道`,
      ).toBe('false');
    }
  });

  it('已实现的不带那个标记 —— 满屏都是「未实现」等于没标', () => {
    view();
    for (const type of IMPLEMENTED_NODE_TYPES) {
      const item = document.querySelector(`[data-node-type="${type}"]`);
      expect(item?.getAttribute('data-implemented'), `${条目名(type)} 被误标成未实现`).toBe('true');
    }
  });

  it('标记要读得出来 —— 不能只有一个 CSS 类', () => {
    view();
    const 一个未实现的 = NODE_TYPES.find((type) => !IMPLEMENTED_NODE_TYPES.includes(type))!;
    const item = document.querySelector(`[data-node-type="${一个未实现的}"]`)!;
    // 纯颜色标注对读屏与色觉障碍用户等于不存在
    expect(item.textContent, '标记只有颜色，读屏用户拿不到').toMatch(/未实现|尚未/u);
  });

  it('悬停提示说清后果，而不只是「未实现」三个字', () => {
    view();
    const 一个未实现的 = NODE_TYPES.find((type) => !IMPLEMENTED_NODE_TYPES.includes(type))!;
    const item = document.querySelector(`[data-node-type="${一个未实现的}"]`)!;
    expect(item.getAttribute('title')).toMatch(/停下|跑不|不会执行/u);
  });

  it('未实现的仍然拖得进去 —— 搭草稿是合法用法，只是要知情', () => {
    // 禁掉的话，用户没法先把流程搭出来等实现落地。
    // 这一屏的职责是「说清楚」，不是「拦住」
    view();
    const 一个未实现的 = NODE_TYPES.find((type) => !IMPLEMENTED_NODE_TYPES.includes(type))!;
    const item = document.querySelector(`[data-node-type="${一个未实现的}"]`)!;
    expect(item.getAttribute('draggable')).toBe('true');
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe('搜索时标记不丢', () => {
  it('搜出来的未实现节点照样带标记', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    view();
    // 「分支」对应 branch —— 契约里未实现
    await user.type(screen.getByLabelText('搜索节点'), '分支');

    const item = document.querySelector('[data-node-type="branch"]');
    expect(item?.getAttribute('data-implemented')).toBe('false');
  });
});

/**
 * 画布上的节点同样要标。
 *
 * 复核实测 F：节点库标了「未实现」，而拖进画布之后卡片上无徽章、
 * 无 title，顶栏校验也不提 —— 只有点了「运行」，Dry Run 才说
 * 「节点类型 branch 尚未实现，运行会在这个节点停下」。
 *
 * 用户搭图时看的是画布，不是节点库。
 */
describe('画布上的节点也标未实现', () => {
  it('未实现的类型在卡片上带标记', async () => {
    const { toFlowNodes } = await import('../src/editor/graphAdapter.js');
    const 未实现 = NODE_TYPES.find((type) => !IMPLEMENTED_NODE_TYPES.includes(type))!;
    const [flowNode] = toFlowNodes({
      nodes: [
        {
          id: 'n1',
          type: 未实现,
          title: '试试',
          position: { x: 0, y: 0 },
          config: getNodeDefinition(未实现).seed ?? {},
        },
      ],
      edges: [],
      groups: [],
    });

    expect(
      (flowNode!.data as { unimplemented?: boolean }).unimplemented,
      `${未实现} 在画布上没有任何「跑不了」的标记`,
    ).toBe(true);
  });

  it('已实现的不带 —— 满屏都是标记等于没标', async () => {
    const { toFlowNodes } = await import('../src/editor/graphAdapter.js');
    const [flowNode] = toFlowNodes({
      nodes: [
        {
          id: 'n1',
          type: 'approval',
          title: '审批',
          position: { x: 0, y: 0 },
          config: getNodeDefinition('approval').seed ?? {},
        },
      ],
      edges: [],
      groups: [],
    });

    expect((flowNode!.data as { unimplemented?: boolean }).unimplemented).toBeUndefined();
  });
});
