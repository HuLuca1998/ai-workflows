import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router';

import { SideNav } from './layout/SideNav.js';
import { SupervisorDrawer } from './supervisor/SupervisorDrawer.js';
import { useEditor } from './editor/editorStore.js';
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
  const editor = useEditor();

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
        {/* 上下文从编辑器状态直接读。
            不接的话「上下文是显式的」就是空话：头部一个 chip 都没有，
            AI 也不知道你在看哪条工作流，提出来的操作引用的 nodeId 全是编的 */}
        <SupervisorDrawer
          open={drawerOpen}
          context={{
            ...(editor.workflowId ? { workflowId: editor.workflowId, draftRev: editor.rev } : {}),
            ...(editor.selection.length > 0 ? { selectedNodes: editor.selection.length } : {}),
          }}
          {...(editor.workflowId ? { graph: editor.graph, onApply: editor.apply } : {})}
          onClose={() => setDrawerOpen(false)}
        />
      </div>
    </div>
  );
}
