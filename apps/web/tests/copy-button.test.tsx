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

  it('不把要复制的内容塞进 title —— 那会让打了码的东西一悬停就全露', async () => {
    // 第三方巡检 A-03：MCP 接入地址在界面上打了码（`/mcp/••••••••`）
    // 并写着「别贴进截图或工单」，而「复制」按钮的 title 里是完整明文，
    // 悬停约一秒系统气泡就把整条令牌显示出来 —— 防护与漏洞隔了不到十行
    userEvent.setup();
    stubClipboard(() => Promise.resolve());
    const 令牌 = 'http://127.0.0.1:5178/mcp/269d163593c6d0fcf1aeba81c0bc6f6';
    render(<CopyButton value={令牌} label="复制" />);

    const button = screen.getByRole('button', { name: /复制/u });
    expect(button.title, '完整值出现在悬停气泡里').not.toContain('269d163593c6d0fcf1aeba81c0bc6f6');
  });

  it('可用时仍给一句说明 —— 空 title 会让人不确定按钮做什么', async () => {
    userEvent.setup();
    stubClipboard(() => Promise.resolve());
    render(<CopyButton value="secret-value" label="复制" />);
    expect(screen.getByRole('button', { name: /复制/u }).title).toBeTruthy();
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
