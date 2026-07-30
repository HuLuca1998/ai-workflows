import { useEffect, useRef, useState } from 'react';

/**
 * 「复制」这个动作必须看得见结果。
 *
 * 此前两处复制按钮（环境检查的安装命令、MCP 接入地址）都是裸的
 * `void navigator.clipboard?.writeText(...)`：成功没反馈、失败被 Promise
 * 吞掉、剪贴板在不安全上下文里压根不存在时那个可选链让按钮变成一个
 * 点了什么都不会发生的装饰。
 */
export function CopyButton({
  value,
  label = '复制',
  className = 'btn btn--ghost',
  ariaLabel,
}: {
  value: string;
  label?: string;
  className?: string;
  /** 同屏多个「复制」时用它区分 —— 读屏否则只听到一串同名按钮 */
  ariaLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 组件在反馈还挂着时被卸载（切页、列表刷新）会让 setState 落到已卸载的树上
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  /**
   * 剪贴板 API 只在安全上下文（https / localhost / Tauri）里有。
   * 桌面形态一定有，Web 形态部署到 http 上就没有 —— 那时要明说，
   * 而不是给一个点了没反应的按钮。
   */
  const available = typeof navigator !== 'undefined' && !!navigator.clipboard;

  const copy = async () => {
    if (!available) return;
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  return (
    <button
      type="button"
      className={className}
      disabled={!available}
      title={available ? value : '当前环境没有剪贴板权限（需要 https 或桌面版）'}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      onClick={() => void copy()}
    >
      <i className={`ph ${state === 'copied' ? 'ph-check' : 'ph-copy'}`} aria-hidden="true" />
      {label}
      {/* role=status 让读屏也听得到结果，不只是看得到 */}
      {state !== 'idle' ? (
        <span className="copy-feedback" role="status" data-state={state}>
          {state === 'copied' ? '已复制' : '复制失败'}
        </span>
      ) : null}
    </button>
  );
}
