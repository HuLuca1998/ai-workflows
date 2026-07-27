import type { ReactNode } from 'react';
import '../styles/index.css';

/**
 * 预览用例的外框。
 *
 * 每条 story 都用它包一层，解决两件事：
 * 1. 引入设计系统 CSS——Preview.js 只加载被渲染的模块，样式必须由用例自己带；
 * 2. 铺一层深色底——组件的令牌是为暗底设计的，落在白底上等于看不见。
 */
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'var(--font-body)',
        fontSize: 13,
        padding: 'var(--space-8)',
        minHeight: '100%',
      }}
    >
      {children}
    </div>
  );
}
