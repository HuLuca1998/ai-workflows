import { afterEach, describe, expect, it } from 'vitest';
import { cmdKey, isMacLike, shortcut } from '../src/data/platformKeys.js';

/**
 * 界面上写死的 `⌘K` 在 Web 形态的 Windows / Linux 上是错的：
 * 那里按的是 Ctrl，而键盘处理本来就同时认 metaKey 与 ctrlKey ——
 * 不一致的是提示，不是实现。
 */

function setPlatform(value: string) {
  Object.defineProperty(navigator, 'platform', { value, configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
afterEach(() => {
  if (realPlatform) Object.defineProperty(navigator, 'platform', realPlatform);
});

describe('快捷键提示', () => {
  it('macOS 上是 ⌘', () => {
    setPlatform('MacIntel');
    expect(isMacLike()).toBe(true);
    expect(cmdKey()).toBe('⌘');
    expect(shortcut('K')).toBe('⌘K');
  });

  it('Windows 上是 Ctrl+ —— 那里根本没有 ⌘ 这个键', () => {
    setPlatform('Win32');
    expect(isMacLike()).toBe(false);
    expect(shortcut('K')).toBe('Ctrl+K');
  });

  it('Linux 同理', () => {
    setPlatform('Linux x86_64');
    expect(shortcut('A')).toBe('Ctrl+A');
  });
});
