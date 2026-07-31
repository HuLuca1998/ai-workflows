import { useEffect, type RefObject } from 'react';

/**
 * 把 Tab 焦点锁在容器内 —— `aria-modal=true` 的弹层必须做到这一点。
 *
 * 第 8 轮实测（P0-3）：节点配置弹层 `aria-modal=true`，Tab 到最后一个
 * 控件再按一次就跑到遮罩后面的侧栏导航去了。屏幕阅读器与纯键盘用户
 * 会以为弹层已经关了，其实还开着。
 *
 * 只处理 Tab 环绕；Esc 关闭仍由各弹层自己管（它们的语义不同）。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      // 每次都重查：弹层内容会随标签页切换增删可聚焦元素。
      // 不按 offsetParent 过滤可见性 —— 弹层开着时里面本就都可见，
      // 而 jsdom 不算布局，那个判据会把一切都滤掉
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        // 没有可聚焦元素也不能让焦点逃出去 —— 停在容器本身
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;

      if (event.shiftKey) {
        if (activeEl === first || activeEl === container) {
          event.preventDefault();
          last?.focus();
        }
      } else if (activeEl === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [ref, active]);
}
