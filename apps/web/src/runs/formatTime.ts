/**
 * 运行页的时间显示。
 *
 * 此前只有绝对时刻（`toLocaleString('zh-CN')`，locale 还写死），
 * 于是列表里看不出「这条跑了多久」，也看不出「刚才那条是几分钟前的」——
 * 用户在 20 条运行里找刚起的那条只能逐条读年月日时分秒。
 */

/** 相对时间的分档。超过一天就不再相对，绝对日期更有用。 */
export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  // 时钟漂移或后端时间稍快时 diff 会是负的，别显示「-3 秒前」
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return '';
}

/** 一段时长，最粗到小时。用于「跑了多久」。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const restSec = sec % 60;
  if (min < 60) return restSec ? `${min} 分 ${restSec} 秒` : `${min} 分`;
  const hour = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin ? `${hour} 小时 ${restMin} 分` : `${hour} 小时`;
}

/**
 * 一条运行跑了多久。终态用 finishedAt，还在跑的用「现在」。
 *
 * 缺 startedAt 时返回空串而不是 0 秒 —— 编一个数比不显示更糟。
 */
export function runDuration(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  now: number,
): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '';
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  if (Number.isNaN(end)) return '';
  return formatDuration(end - start);
}
