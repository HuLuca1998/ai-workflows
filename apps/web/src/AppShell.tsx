import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router';

import { SideNav } from './layout/SideNav.js';
import { SupervisorDrawer } from './supervisor/SupervisorDrawer.js';
import { TitleBar } from './layout/TitleBar.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PAGES } from './pages/index.js';

/**
 * 应用外壳。
 *
 * 基准窗口 1440×900（最小 1280×800）：标题栏 44px、主导航 216px、
 * 主管 AI 抽屉 468px（屏幕清单 §11）。
 */
export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌘K 呼出 / 收起主管 AI；Esc 关闭浮层——全局快捷键约定（§12）
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setDrawerOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <TitleBar onAskAi={() => setDrawerOpen((open) => !open)} />
      <div className="app-shell__body">
        {/* 计数与权限档等引擎接上后才有真实值；现在传空，界面会显示「尚未…」而不是假状态 */}
        <SideNav counts={{}} />
        <main className="app-shell__content">
          <Routes>
            {PAGES.map(({ path, element }) => (
              <Route key={path} path={path} element={element} />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        {/* 上下文由各屏提供；现在只有全局的部分，编辑器与执行记录的
            草稿 rev、选中节点、当前运行随后接上 */}
        <SupervisorDrawer open={drawerOpen} context={{}} onClose={() => setDrawerOpen(false)} />
      </div>
    </div>
  );
}
