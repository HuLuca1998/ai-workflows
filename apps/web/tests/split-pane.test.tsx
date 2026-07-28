import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * 可拖动的分栏。
 *
 * 图纸给的是固定宽度（Agent 250px、提示词 266px、模型 262px），
 * 那是**初始值**——真实使用里名字有长有短，用户需要自己调。
 *
 * 三条：
 * 1. 默认宽度照图纸，不改它
 * 2. 拖完记住，下次打开还是那个宽度
 * 3. 有上下限 —— 拖到 0 会让那一栏彻底消失，用户找不回来
 */

const { SplitPane } = await import('../src/layout/SplitPane.js');

/**
 * 自己造一个 localStorage。
 *
 * jsdom 自带的那个在某些环境下缺 clear，而且测试之间会互相串 ——
 * 这里要验的正是「存了什么、读到什么」，共用一份状态没法验。
 */
let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    },
  });
});

const view = (props: Partial<React.ComponentProps<typeof SplitPane>> = {}) =>
  render(
    <SplitPane storageKey="test.pane" defaultWidth={250} {...props}>
      <div data-testid="left">左栏</div>
      <div data-testid="right">右栏</div>
    </SplitPane>,
  );

describe('默认与持久化', () => {
  it('默认宽度用传进来的值 —— 图纸的尺寸从这里进来', () => {
    view();
    const left = screen.getByTestId('left').parentElement!;
    expect(left.style.width).toBe('250px');
  });

  it('读上次拖到的宽度', () => {
    store['test.pane'] = '320';
    view();
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('320px');
  });

  it('存的值不合法时退回默认 —— localStorage 是用户能手改的', () => {
    store['test.pane'] = '不是数字';
    view();
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('250px');
  });
});

describe('拖动', () => {
  const drag = (to: number) => {
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
  };

  it('拖动改变宽度', () => {
    view();
    drag(400);
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('400px');
  });

  it('拖完存下来', () => {
    view();
    drag(400);
    expect(store['test.pane']).toBe('400');
  });

  it('有下限 —— 拖到 0 会让那一栏彻底消失，用户找不回来', () => {
    view({ minWidth: 180 });
    drag(20);
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('180px');
  });

  it('有上限 —— 左栏占满整屏时右边就没了', () => {
    view({ maxWidth: 480 });
    drag(900);
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('480px');
  });
});

describe('无障碍', () => {
  it('分隔条是 separator，并说明自己能拖', () => {
    view();
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle.getAttribute('aria-label')).toMatch(/拖动|调整/u);
  });

  it('键盘也能调 —— 只能拖的话键盘用户完全用不了', () => {
    view();
    const handle = screen.getByRole('separator');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('266px');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('250px');
  });

  it('双击回到默认宽度 —— 拖乱了要能一键复位', () => {
    view();
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('420px');

    fireEvent.doubleClick(handle);
    expect(screen.getByTestId('left').parentElement!.style.width).toBe('250px');
  });
});
