import { useCallback, useRef, useState } from 'react';

/**
 * 防连点：上一次还没回来时，同一个目标上再点不生效。
 *
 * 为什么要 ref 而不只是 state：`setState` 在同一批事件里**不会立刻生效** ——
 * 用户快速点五下，五个 handler 看到的 `running` 都还是 false。
 * ref 是同步的，写进去下一行就读得到。state 只负责让按钮变灰
 * （那是给人看的那一半：没有它，用户不知道自己那一下算没算数）。
 *
 * 这个模式仓库里本来就有一份对的（`OverviewPage` 的 `creatingRef`，
 * 配着全仓唯一一条「连点五次只建一条」的测试），但没有推广 ——
 * 于是失败页那三个入口、发布按钮全是裸的。而后端 `run.start` 不幂等：
 * 连点两次就是两条运行、两个执行线程、同一个 workdir，
 * 第二条撞上「分支已存在」——一句完全指错方向的提示。
 *
 * **锁按目标分。** 列表 + 详情这种布局里，「取消运行 A」与「取消运行 B」
 * 是两件事。第一版的锁是一个布尔：取消 A 未完成时切到 B，B 的按钮
 * 看着能点，点下去却被静默丢弃 —— 用户点了、界面闪了一下、什么都没发生，
 * 这比按钮灰着更糟。
 *
 * 不传 target 的调用方（页面上只有一个这类操作）落在同一个空字符串键上，
 * 行为与原来完全一致。
 */
export function useAsyncAction(): {
  /** 有任何一个在进行中。只有一个目标的页面直接用它。 */
  running: boolean;
  /**
   * 最近一次请求的目标。
   *
   * 列表页用 `running && target === 当前 id` 判断中间态：不判的话
   * 取消 A、切到 B，B 的按钮显示「取消中…」，而那个请求不属于它。
   */
  target: string | null;
  /** 这个目标上有没有正在飞的请求。 */
  isRunning: (target?: string) => boolean;
  /** 包一层：同一目标进行中时直接丢弃这次点击。 */
  run: (action: () => Promise<unknown>, target?: string) => void;
} {
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<readonly string[]>([]);
  const [target, setTarget] = useState<string | null>(null);

  const run = useCallback((action: () => Promise<unknown>, next?: string) => {
    const key = next ?? '';
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPending((current) => [...current, key]);
    setTarget(next ?? null);
    void action().finally(() => {
      inFlight.current.delete(key);
      setPending((current) => current.filter((item) => item !== key));
      // target 只是「最近一次」的标记，谁最后结束都把它清掉
      setTarget(null);
    });
  }, []);

  const isRunning = useCallback((which?: string) => pending.includes(which ?? ''), [pending]);

  return { running: pending.length > 0, target, isRunning, run };
}
