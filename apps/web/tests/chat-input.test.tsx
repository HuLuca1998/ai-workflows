import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChatInput } from '../src/chat/ChatInput.js';

/**
 * AI 聊天输入框的共同约定：**⏎ 发送、⇧⏎ 换行**。
 *
 * 每个聊天框各写一遍 onKeyDown 的话，新加的那个迟早会漏掉 ⇧⏎ ——
 * 而用户发现不了「这里为什么不能换行」，只会以为多行输入不被支持。
 * 所以这条逻辑只有一份实现，末尾那条守卫盯着别再冒出第二份。
 */

const view = (props: Partial<React.ComponentProps<typeof ChatInput>> = {}) => {
  const onSubmit = props.onSubmit ?? vi.fn();
  render(
    <ChatInput label="问主管 AI" value="" onChange={vi.fn()} {...props} onSubmit={onSubmit} />,
  );
  return { onSubmit, input: screen.getByLabelText(/问主管 AI/u) };
};

describe('⏎ 发送、⇧⏎ 换行', () => {
  it('⏎ 发送', async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = view({ value: '你好' });

    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('⇧⏎ 不发送 —— 那是换行', async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = view({ value: '第一行' });

    await user.click(input);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('⇧⏎ 之后真的换了行 —— 不能只是「没发送」', async () => {
    const user = userEvent.setup();
    let text = '第一行';
    render(
      <ChatInput
        label="问主管 AI"
        value={text}
        onChange={(next) => {
          text = next;
        }}
        onSubmit={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText(/问主管 AI/u));
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(text).toContain('\n');
  });

  it('⌘⏎ 也发送 —— 有人习惯这个', async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = view({ value: '你好' });

    await user.click(input);
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('空输入不发送 —— 免得留一串空气泡', async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = view({ value: '   ' });

    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('禁用时怎么按都不发', async () => {
    const user = userEvent.setup();
    const { onSubmit, input } = view({ value: '你好', disabled: true });

    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('可访问名里写明 ⇧⏎ 换行 —— 不说的话没人会去试', () => {
    const { input } = view();
    expect(input.getAttribute('aria-label')).toMatch(/⇧⏎/u);
  });
});

describe('这条逻辑只有一份实现', () => {
  /**
   * 主管抽屉、（将来的）运行对话、节点里的 AI 面板都是聊天框。
   * 各写各的 onKeyDown 迟早分叉 —— 这条守卫盯着源码里别再出现第二份。
   */
  it('没有别的地方自己判 Enter 与 shiftKey', () => {
    const 违规: string[] = [];
    const 扫 = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          扫(path);
          continue;
        }
        if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;
        if (path.includes('chat/ChatInput')) continue;

        const 源 = readFileSync(path, 'utf8');
        // 「同时出现 Enter 判断与 shiftKey 判断」= 又抄了一份聊天键盘逻辑
        if (/['"]Enter['"]/.test(源) && /shiftKey/.test(源)) {
          违规.push(path);
        }
      }
    };
    扫(join(import.meta.dirname, '../src'));

    expect(违规, `这些文件自己实现了聊天键盘逻辑，改用 ChatInput：${违规.join('、')}`).toEqual([]);
  });
});
