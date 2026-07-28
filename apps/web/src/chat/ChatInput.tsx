import type { KeyboardEvent } from 'react';

/**
 * AI 聊天的输入框。
 *
 * 这里只有一条规则，但它必须在每个聊天框里都一样：
 * **⏎ 发送、⇧⏎ 换行**（⌘⏎ 也发送，有人习惯那个）。
 *
 * 各写各的 onKeyDown 迟早分叉 —— 新加的那个漏掉 ⇧⏎ 的话，用户发现不了
 * 「这里为什么不能换行」，只会以为多行输入不被支持，然后把想说的话
 * 压成一行。所以这条逻辑只有一份实现，`chat-input.test.tsx` 末尾那条
 * 守卫盯着源码里别再冒出第二份。
 */

export interface ChatInputProps {
  /** 可访问名。组件会在后面补上「⇧⏎ 换行」—— 不说的话没人会去试。 */
  label: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
}

export function ChatInput({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows = 2,
  disabled = false,
  className = 'supervisor__input',
}: ChatInputProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    // ⇧⏎ 是换行 —— 交给浏览器默认行为，别拦
    if (event.shiftKey) return;

    event.preventDefault();
    if (disabled || !value.trim()) return;
    onSubmit();
  };

  return (
    <textarea
      className={className}
      aria-label={`${label}（⏎ 发送，⇧⏎ 换行）`}
      {...(placeholder ? { placeholder } : {})}
      rows={rows}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
