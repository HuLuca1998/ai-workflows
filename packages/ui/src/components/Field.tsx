import { useId, type InputHTMLAttributes } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** 字段说明；与错误信息一起通过 aria-describedby 关联。 */
  hint?: string;
  error?: string;
}

/**
 * 表单字段。label 与控件必须真关联（htmlFor），错误必须能被读屏播报——
 * 节点配置弹层是 Schema 驱动渲染的，字段一多，靠视觉对齐会立刻失效。
 */
export function Field({ label, hint, error, required, className, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={['aiwf-field', className].filter(Boolean).join(' ')} data-invalid={error ? 'true' : undefined}>
      <label className="aiwf-field__label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        className="aiwf-field__input"
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy || undefined}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="aiwf-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="aiwf-field__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
