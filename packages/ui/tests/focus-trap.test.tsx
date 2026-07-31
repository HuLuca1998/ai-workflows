import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dialog } from '../src/index.js';

/**
 * 第 8 轮实测 P0-3:aria-modal=true 的弹层 Tab 到最后一个控件再按一次
 * 就跑到遮罩后面去了 —— 用户以为弹层关了,其实还开着。
 */
describe('Dialog 锁焦点', () => {
  it('在最后一个控件上 Tab 环绕回第一个,不逃出弹层', () => {
    render(
      <Dialog open title="测试" onClose={() => {}} actions={<button>确定</button>}>
        <input aria-label="第一个" />
        <input aria-label="第二个" />
      </Dialog>,
    );
    const confirm = screen.getByRole('button', { name: '确定' });
    const first = screen.getByLabelText('第一个');
    confirm.focus();
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab 从第一个环绕到最后一个', () => {
    render(
      <Dialog open title="测试" onClose={() => {}} actions={<button>确定</button>}>
        <input aria-label="第一个" />
      </Dialog>,
    );
    const first = screen.getByLabelText('第一个');
    const confirm = screen.getByRole('button', { name: '确定' });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });
});
