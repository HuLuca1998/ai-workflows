import type { ReactNode } from 'react';
import '../src/styles/index.css';

/** Preview.js 全局外壳：在渲染任意组件或 story 前加载设计系统样式。 */
export function Wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
