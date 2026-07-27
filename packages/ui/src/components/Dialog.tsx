import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区。 */
  actions?: ReactNode;
  /** 画布保持完整可视，所以配置弹层是居中浮层而不是侧栏。 */
  width?: number;
}

/**
 * 模态弹层。Esc 关闭是全局约定（快捷键表 §12），所以放在组件里而不是每处各写一遍。
 */
export function Dialog({ open, title, onClose, children, actions, width = 720 }: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="aiwf-dialog__backdrop" data-testid="dialog-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="aiwf-dialog"
        style={{ maxWidth: width }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id={titleId} className="aiwf-dialog__title">
          {title}
        </h2>
        <div className="aiwf-dialog__body">{children}</div>
        {actions ? <div className="aiwf-dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
