import type { ReactNode } from 'react';
import '../src/styles/index.css';

/**
 * Preview.js 包装器：给每个被预览的组件套上设计系统的底色与令牌。
 *
 * 没有它，组件会渲染在浏览器默认的白底上——深色令牌下等于看不见，
 * 而且 --color-* 变量全部缺失，样式会整体失效。
 */
export function Wrapper({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'var(--font-body)',
        padding: 'var(--space-8)',
        minHeight: '100vh',
      }}
    >
      {children}
    </div>
  );
}
