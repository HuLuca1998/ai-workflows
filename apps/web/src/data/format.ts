/**
 * 字节数的显示。**只有这一份实现。**
 *
 * 曾经有两份：概览页把 412MB 显示成「412 MB」，执行记录显示「412.0 MB」——
 * 同一个数字两种写法，用户会以为是两个不同的值。而执行记录那份
 * 没有 GB 档，2 GB 显示成「2048.0 MB」。
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  // 停在 TB：再往上产物目录不该到，而 PB 的显示会让人以为是 bug
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
