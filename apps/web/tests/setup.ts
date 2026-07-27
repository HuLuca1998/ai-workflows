import '@testing-library/jest-dom/vitest';
import { afterEach, expect } from 'vitest';
import { VIOLATIONS } from './_contractClient.js';

// 界面发了一个不合契约的入参，就判这条用例失败 —— 哪怕组件把错误 catch 了。
// 真实运行时这种调用会被 Core API 挡在门口，症状是「点了没反应」，
// 而组件测试因为只断言「call 被调用过」照样绿
afterEach(() => {
  const found = VIOLATIONS.splice(0, VIOLATIONS.length);
  expect(found, '本轮有不合契约的 Core API 调用').toEqual([]);
});

// XYFlow 依赖 ResizeObserver 量画布尺寸，jsdom 没有实现
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// DOMMatrixReadOnly / offset* 也是 XYFlow 的量算依赖
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
  constructor(_transform?: string) {}
} as unknown as typeof DOMMatrixReadOnly;
