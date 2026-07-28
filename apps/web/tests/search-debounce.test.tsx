import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedSearch } from '../src/hooks/useDebouncedSearch.js';

/**
 * 搜索框的共同行为：**输入即搜，300ms 防抖；回车立刻搜，不等防抖**。
 *
 * codex 的原话：「输入后等待 1.5 秒仍是 50 条，按 Enter 才变 1 条；
 * placeholder 仍未提示回车……相比之下首页搜索框已经明确写了『（回车搜索）』，
 * 两处交互不一致」。
 *
 * 修的方向是统一成即时搜索，而不是到处补「回车搜索」的文案 ——
 * 图纸的搜索框上没有那半句，那是我自己加的。要在文案里解释交互，
 * 通常说明交互本身不对。
 */

beforeEach(() => {
  vi.useFakeTimers();
});

describe('输入即搜', () => {
  it('停手 300ms 之后才发请求 —— 每个字符发一次会把后端打爆', async () => {
    const search = vi.fn();
    const { result } = renderHook(() => useDebouncedSearch(search));

    act(() => result.current.onChange('a'));
    act(() => result.current.onChange('ab'));
    act(() => result.current.onChange('abc'));
    expect(search).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith('abc');
  });

  it('输入框里的值立刻跟手 —— 防抖的是请求，不是显示', () => {
    const { result } = renderHook(() => useDebouncedSearch(vi.fn()));

    act(() => result.current.onChange('worktree'));
    expect(result.current.value).toBe('worktree');
  });

  it('回车立刻搜，不等那 300ms', () => {
    const search = vi.fn();
    const { result } = renderHook(() => useDebouncedSearch(search));

    act(() => result.current.onChange('worktree'));
    act(() => result.current.onEnter());

    expect(search).toHaveBeenCalledWith('worktree');
  });

  it('回车之后防抖那次不再重复发', async () => {
    const search = vi.fn();
    const { result } = renderHook(() => useDebouncedSearch(search));

    act(() => result.current.onChange('worktree'));
    act(() => result.current.onEnter());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(search).toHaveBeenCalledOnce();
  });

  it('清空也要搜 —— 那是「取消筛选」，不能让列表停在筛过的状态', async () => {
    const search = vi.fn();
    const { result } = renderHook(() => useDebouncedSearch(search));

    act(() => result.current.onChange('worktree'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    search.mockClear();

    act(() => result.current.onChange(''));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(search).toHaveBeenCalledWith('');
  });

  it('组件卸载后不再发 —— 那时候没人接得住结果了', async () => {
    const search = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedSearch(search));

    act(() => result.current.onChange('worktree'));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(search).not.toHaveBeenCalled();
  });

  it('值没变就不重复发 —— 回车按两次不该打两次请求', () => {
    const search = vi.fn();
    const { result } = renderHook(() => useDebouncedSearch(search));

    act(() => result.current.onChange('worktree'));
    act(() => result.current.onEnter());
    act(() => result.current.onEnter());

    expect(search).toHaveBeenCalledOnce();
  });
});
