import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router';

import { SideNav } from './layout/SideNav.js';
import { useTrayNavigation } from './layout/useTrayNavigation.js';
import { SupervisorDrawer } from './supervisor/SupervisorDrawer.js';
import { useEditor } from './editor/editorStore.js';
import { useLocation, useNavigate } from 'react-router';
import { useRuns } from './runs/runsStore.js';
import { TitleBar } from './layout/TitleBar.js';
import { McpConfirmCard } from './mcp/McpConfirmCard.js';
import {
  environmentDisplay,
  permissionDisplay,
  useWorkspaceSettings,
} from './data/useWorkspaceSettings.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PAGES } from './pages/index.js';

/**
 * 应用外壳。
 *
 * 基准窗口 1440×900（最小 1280×800）：标题栏 44px、主导航 216px、
 * 主管 AI 抽屉 468px（屏幕清单 §11）。
 */
export function AppShell() {
  const { settings, health, loaded } = useWorkspaceSettings();
  const permission = permissionDisplay(settings);
  const environment = environmentDisplay(settings, health);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const editor = useEditor();
  /*
   * 只订阅 selectedId 这一个标量：订整个 store 的话，运行页 1.2s 一次的
   * 轮询会把整个外壳跟着重渲染。
   *
   * 选择器必须返回**原始值**——返回 `{ selectedId }` 这种新对象时
   * zustand 每次比较都不相等，React 判定快照没缓存，直接 Maximum update depth。
   */
  const selectedRunId = useRuns((state) => state.selectedId);
  // 托盘「检查更新…」把用户带到「系统版本」屏
  useTrayNavigation();

  /*
   * 没配过就哪儿都去不了。
   *
   * **这一版把拦截改硬了。** 之前有两个口子：
   *
   * 1. `location.pathname !== '/'` 时不拦 —— 于是从托盘、通知、
   *    深链进来的任何一条路径都绕过了它
   * 2. `isOnboardingSkipped()` —— 一个 localStorage 标记就能永久跳过
   *
   * 现在只放行 `/onboarding` 本身，其余一律重定向。带着一个写不进去的
   * 工作目录进主界面，第一次运行才发现，那时用户已经配了半条工作流。
   *
   * 「配没配过」看后端的 envCheckedAt（权威、换台机器也认）。
   * settings 还没读回来时它与「真的没配过」长得一样，
   * 所以要等第一次读取有结果（loaded）再决定拦不拦 ——
   * 否则每次冷启动都会闪一下配置屏。
   */
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!loaded) return;
    if (settings.envCheckedAt) return;
    if (location.pathname === '/onboarding') return;
    navigate('/onboarding', { replace: true });
  }, [loaded, settings.envCheckedAt, location.pathname, navigate]);

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
      <TitleBar
        onAskAi={() => setDrawerOpen((open) => !open)}
        {...(settings.workdir ? { workdir: settings.workdir } : {})}
      />
      <div className="app-shell__body">
        {/* 计数还等引擎；权限档与环境读的是工作区设置 —— 没配过时传 undefined，
            界面显示「尚未…」而不是一个假的正常状态 */}
        <SideNav
          counts={{}}
          {...(permission ? { permission } : {})}
          {...(environment ? { environment } : {})}
        />
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
            /*
             * 正在看的那条运行。chip 与契约字段一直都在，就是没人传 ——
             * 于是在运行页问「上次为什么失败」，AI 拿不到任何运行 id，
             * 只能泛泛地讲一遍失败的可能原因。
             */
            ...(selectedRunId ? { runId: selectedRunId } : {}),
          }}
          {...(editor.workflowId ? { graph: editor.graph, onApply: editor.apply } : {})}
          onClose={() => setDrawerOpen(false)}
        />
      </div>

      {/* MCP 客户端要写东西时弹出来。放在最外层是有意的：
          它是一条打断性的确认，用户在哪一屏都得看见 */}
      <McpConfirmCard />
    </div>
  );
}
