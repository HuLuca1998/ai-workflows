import { useEffect, useState } from 'react';

/** 订阅窗口宽度。导航收起、三栏收合都依赖它。 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    // 挂载时同步一次：测试与真实场景都可能在挂载前改过宽度
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return width;
}
