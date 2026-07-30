import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NodeLibrary } from '../src/editor/NodeLibrary.js';

/**
 * 节点库要能**点**，不能只能拖。
 *
 * 条目原本是 `<div draggable role="button" tabIndex={0}>`，
 * 却没有 onClick、也没有 onKeyDown —— `role="button"` 把它宣告成
 * 可激活控件，实现里只有一条 HTML5 drag 通道。
 *
 * 两个后果，第一个更常见：
 *
 * - 新建工作流后空画布写着「从左侧拖入入口节点」，用户点了左侧那一条，
 *   **没有任何反应** —— 节点没出现，也没有报错
 * - **键盘用户无法向画布添加任何节点，一个都不行**。备用入口也没有：
 *   空画布右键只有一项「用选中节点建分组」，而且是禁用的
 */
describe('节点库', () => {
  it('点一下就往画布加一个 —— 不是只能拖', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<NodeLibrary onDragStart={vi.fn()} onAdd={onAdd} />);

    await user.click(screen.getByRole('button', { name: /入口设置/u }));

    expect(onAdd).toHaveBeenCalledWith('entry');
  });

  it('键盘也能加 —— Enter 与空格都算', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<NodeLibrary onDragStart={vi.fn()} onAdd={onAdd} />);

    const 条目 = screen.getByRole('button', { name: /入口设置/u });
    条目.focus();
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('entry');

    onAdd.mockClear();
    await user.keyboard(' ');
    expect(onAdd).toHaveBeenCalledWith('entry');
  });

  it('空格不把页面滚下去', () => {
    // 空格在按钮上的默认行为是滚动。不 preventDefault 的话，
    // 用户按一下空格，节点加上了，同时整页往下跳一屏。
    //
    // 用 fireEvent 的返回值判断（false = 默认行为被阻止）：
    // 在元素上挂原生 listener 是测不出来的 —— 它在冒泡阶段
    // 先于 React 的合成事件触发，那时还没 preventDefault
    render(<NodeLibrary onDragStart={vi.fn()} onAdd={vi.fn()} />);

    const 未被阻止 = fireEvent.keyDown(screen.getByRole('button', { name: /入口设置/u }), {
      key: ' ',
    });

    expect(未被阻止).toBe(false);
  });

  it('搜索之后点的是筛出来的那一条', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<NodeLibrary onDragStart={vi.fn()} onAdd={onAdd} />);

    await user.type(screen.getByLabelText('搜索节点'), '审批');
    await user.click(screen.getByRole('button', { name: /审批/u }));

    expect(onAdd).toHaveBeenCalledWith('approval');
  });

  it('每一条都进得了 Tab 序列', () => {
    // 宣告成 role="button" 就要真的能用键盘到达
    render(<NodeLibrary onDragStart={vi.fn()} onAdd={vi.fn()} />);

    const 条目 = screen.getAllByRole('button');
    expect(条目.length).toBeGreaterThan(0);
    for (const 一条 of 条目) {
      expect(一条.getAttribute('tabindex')).toBe('0');
    }
  });
});
