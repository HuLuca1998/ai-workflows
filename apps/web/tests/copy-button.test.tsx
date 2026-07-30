import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from '../src/layout/CopyButton.js';

/**
 * 复制按钮此前在两处是「点了什么都不发生」：写进剪贴板是静默的，
 * 界面上没有任何变化，用户不知道成没成，于是再点几下。
 *
 * 而剪贴板在不安全上下文（http 的 Web 形态）里根本不存在 ——
 * `navigator.clipboard?.writeText` 的可选链会把这件事悄悄吞掉。
 */

/**
 * 注意顺序：`userEvent.setup()` 自己会往 navigator 上装一个剪贴板桩，
 * 所以必须在它之后再覆盖，否则测的是 user-event 的桩不是我们的。
 */
function stubClipboard(impl: null | (() => Promise<void>)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: impl ? { writeText: vi.fn(impl) } : undefined,
    configurable: true,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('复制成功后给出可见反馈，并在 2 秒后复原', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubClipboard(() => Promise.resolve());
    render(<CopyButton value="/tmp/run-1" label="复制路径" />);

    await user.click(screen.getByRole('button', { name: /复制路径/u }));
    await screen.findByText('已复制');

    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => {
      expect(screen.queryByText('已复制')).toBeNull();
    });
  });

  it('剪贴板不可用时按钮明说不可用，而不是假装点了', async () => {
    userEvent.setup();
    stubClipboard(null);
    render(<CopyButton value="/tmp/run-1" label="复制路径" />);
    const button = screen.getByRole('button', { name: /复制路径/u });
    expect(button).toBeDisabled();
    expect(button.title).toContain('剪贴板');
  });

  it('写入失败要说失败，不能显示「已复制」', async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error('拒绝访问')));
    render(<CopyButton value="/tmp/run-1" label="复制路径" />);

    await user.click(screen.getByRole('button', { name: /复制路径/u }));
    await screen.findByText('复制失败');
    expect(screen.queryByText('已复制')).toBeNull();
  });
});
