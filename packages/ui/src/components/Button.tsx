import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  /** 加载中：禁用并播报忙碌状态，不能只转个圈。 */
  loading?: boolean;
  children?: ReactNode;
}

/**
 * 按钮。主操作是强调色描边而非填充——这套系统里强调色只作为线与光，不铺面。
 */
export function Button({
  variant = 'secondary',
  loading = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={['aiwf-btn', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
