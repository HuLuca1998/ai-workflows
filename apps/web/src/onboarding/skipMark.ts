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

export function isOnboardingSkipped(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_SKIP_KEY) === '1';
  } catch {
    // 隐私模式下 localStorage 会抛 —— 记不住就当没跳过，宁可多拦一次
    return false;
  }
}

export function markOnboardingSkipped(): void {
  try {
    window.localStorage.setItem(ONBOARDING_SKIP_KEY, '1');
  } catch {
    // 同上：记不住也不该挡住用户往下走
  }
}
