/**
 * 「这次先不配」的记号。
 *
 * 它原来是 OnboardingPage 里的一个私有常量，只写不读 —— 写完之后
 * 全应用没有任何地方查过它，也就没有任何地方会因为它而少拦一次人。
 * 拿出来单独一个模块，是为了让写它的和读它的都指向同一个名字。
 *
 * 为什么用 localStorage 而不是后端：「我暂时不想配」是这台机器上这个人的
 * 一次性偏好，不是工作区数据。真正的「配没配过」看的是后端的
 * `envCheckedAt` —— 那才是权威来源，换台机器也认。
 */
export const ONBOARDING_SKIP_KEY = 'aiwf.onboarding.skipped';

/**
 * 本次会话内的备份。
 *
 * localStorage 在隐私模式下读写都抛，而首次引导会**按「没跳过」处理**——
 * 两件事凑在一起是个死循环：用户点「先跳过」→ 存不住 → 回到 / →
 * 立刻又被弹回引导页 → 再点跳过……他永远出不去。
 *
 * 存不住至少要在这一次会话里记住。关掉应用后再拦一次是可以接受的，
 * 把人锁死不行。
 */
let skippedThisSession = false;

export function isOnboardingSkipped(): boolean {
  if (skippedThisSession) return true;
  try {
    return window.localStorage.getItem(ONBOARDING_SKIP_KEY) === '1';
  } catch {
    // 读不到就看会话内的那份，上面已经查过了
    return false;
  }
}

export function markOnboardingSkipped(): void {
  skippedThisSession = true;
  try {
    window.localStorage.setItem(ONBOARDING_SKIP_KEY, '1');
  } catch {
    // 存不住也不该挡住用户往下走 —— 会话内的那份已经置位了
  }
}
