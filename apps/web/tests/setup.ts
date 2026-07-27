import '@testing-library/jest-dom/vitest';

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
