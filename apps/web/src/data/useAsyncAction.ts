import { useCallback, useRef, useState } from 'react';

/**
 * 防连点：上一次还没回来时，再点不生效。
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
 */
export function useAsyncAction(): {
  /** 进行中。绑到按钮的 disabled 上。 */
  running: boolean;
  /** 包一层：进行中时直接丢弃这次点击。 */
  run: (action: () => Promise<unknown>) => void;
} {
  const inFlight = useRef(false);
  const [running, setRunning] = useState(false);

  const run = useCallback((action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    void action().finally(() => {
      inFlight.current = false;
      setRunning(false);
    });
  }, []);

  return { running, run };
}
