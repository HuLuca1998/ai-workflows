import { useCallback, useRef } from 'react';

/**
 * 「元素刚出现时聚焦一次」的 ref。
 *
 * 直接写 `ref={(el) => el?.focus()}` 是错的：内联箭头函数每次渲染都是新的，
 * React 会先用 null 调一次再用元素调一次 —— 于是**每次重渲染都会 focus()**。
 * 用户进入确认态之后去改输入框，一次重渲染就把焦点抢回按钮上，
 * 他打的字进不去。
 *
 * 这里的 ref 回调本身是稳定的（useCallback 空依赖），并且只在
 * 「从没有元素变成有元素」时聚焦一次。
 */
export function useFocusOnce(): (element: HTMLElement | null) => void {
  const focused = useRef(false);

  return useCallback((element: HTMLElement | null) => {
    if (!element) {
      // 元素被卸载：下次它再出现时应该重新聚焦一次
      focused.current = false;
      return;
    }
    if (focused.current) return;
    focused.current = true;
    element.focus();
  }, []);
}
