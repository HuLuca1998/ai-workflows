/**
 * 快捷键提示里的修饰键符号。
 *
 * 界面上写死的 `⌘K` 在 Web 形态的 Windows / Linux 上是错的 ——
 * 那里按的是 Ctrl，而 AppShell 的键盘处理本来就同时认 metaKey 与 ctrlKey。
 * 提示与实现不一致的地方，错的是提示。
 *
 * 桌面版也不一定是 macOS：Tauri 同样出 Windows 包。
 */
export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return true;
  // navigator.platform 已废弃但仍是最可靠的判据；userAgent 兜底
  const hint = (navigator.platform || navigator.userAgent || '').toLowerCase();
  return hint.includes('mac') || hint.includes('iphone') || hint.includes('ipad');
}

/** 「命令/控制」键的符号。 */
export function cmdKey(): string {
  return isMacLike() ? '⌘' : 'Ctrl+';
}

/** 完整的快捷键提示，比如 `⌘K` / `Ctrl+K`。 */
export function shortcut(letter: string): string {
  return `${cmdKey()}${letter}`;
}
