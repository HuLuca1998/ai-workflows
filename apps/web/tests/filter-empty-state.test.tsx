import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ListEmpty } from '../src/layout/ListEmpty.js';

/**
 * 「筛选后没有」不能说成「一条都没有」。
 *
 * 第三方巡检 C-18 实测：记忆页有 4 条在列，点「全局」筛选后表格显示
 * 「还没有记忆。AI 在运行结束时会提议值得长期记住的事实…」——
 * 用户刚看见 4 条，界面却说一条都没有。
 *
 * 同一页的**搜索**空态做得很好（「没有匹配「keychainzzz」的记忆。清空搜索」），
 * 只有筛选空态漏了。这两种「空」说的是完全不同的两件事，
 * 而第三种（真的一条都没有）才该讲「这一页是干什么的」。
 */

describe('三种「空」要分清', () => {
  it('库是空的：讲这一页是干什么的', () => {
    render(
      <ListEmpty query="" noun="记忆" onClear={vi.fn()}>
        还没有记忆。AI 在运行结束时会提议值得长期记住的事实。
      </ListEmpty>,
    );
    expect(screen.getByText(/AI 在运行结束时会提议/u)).toBeTruthy();
  });

  it('搜不到：说搜的是什么，并给清空的出口', async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <ListEmpty query="zzz" noun="记忆" onClear={onClear}>
        还没有记忆。
      </ListEmpty>,
    );

    expect(screen.getByText(/没有匹配「zzz」的记忆/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('筛选后为空：说清是哪个筛选，不能说成「一条都没有」', () => {
    render(
      <ListEmpty query="" noun="记忆" filterLabel="全局" onClear={vi.fn()}>
        还没有记忆。AI 在运行结束时会提议值得长期记住的事实。
      </ListEmpty>,
    );

    expect(
      screen.queryByText(/AI 在运行结束时会提议/u),
      '用户刚看见 4 条，不该告诉他一条都没有',
    ).toBeNull();
    expect(screen.getByText(/「全局」/u)).toBeTruthy();
  });

  it('筛选后为空时给一个回到全部的出口', async () => {
    const onClearFilter = vi.fn();
    const user = userEvent.setup();
    render(
      <ListEmpty
        query=""
        noun="记忆"
        filterLabel="全局"
        onClear={vi.fn()}
        onClearFilter={onClearFilter}
      >
        还没有记忆。
      </ListEmpty>,
    );

    await user.click(screen.getByRole('button', { name: /清空筛选|看全部/u }));
    expect(onClearFilter).toHaveBeenCalled();
  });

  it('同时有搜索词和筛选时，搜索优先 —— 那是用户刚打的字', () => {
    render(
      <ListEmpty query="zzz" noun="记忆" filterLabel="全局" onClear={vi.fn()}>
        还没有记忆。
      </ListEmpty>,
    );
    expect(screen.getByText(/没有匹配「zzz」/u)).toBeTruthy();
  });
});
