import { useEffect, useMemo, useState } from 'react';
import { UpdateController, type UpdaterBackend } from '@aiwf/client-core';
import { Button, Tag } from '@aiwf/ui';

export interface UpdateCardProps {
  currentVersion: string;
  /** 桌面形态注入 Tauri 后端；Web 形态传 null。 */
  backend: UpdaterBackend | null;
  /** 自动检查：进入设置页时查一次。 */
  autoCheck?: boolean;
}

/**
 * 设置页里的更新卡片。
 *
 * 刻意不做「发现新版本就弹窗」：这是一个会长时间挂着运行的工具，
 * 打断正在等审批的用户比晚一天更新代价更大。用户来到这一屏才提示。
 */
export function UpdateCard({ currentVersion, backend, autoCheck = true }: UpdateCardProps) {
  const controller = useMemo(
    () => (backend ? new UpdateController(backend, { currentVersion }) : null),
    [backend, currentVersion],
  );
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!controller) return;
    const off = controller.subscribe(() => forceRender((n) => n + 1));
    if (autoCheck) void controller.check();
    return off;
  }, [controller, autoCheck]);

  if (!controller) {
    return (
      <section className="update-card">
        <h2>版本</h2>
        <p className="update-card__meta">
          当前 {currentVersion} · Web 形态由服务端更新，刷新页面即为最新
        </p>
      </section>
    );
  }

  const state = controller.state;

  return (
    <section className="update-card" data-status={state.status}>
      <header className="update-card__head">
        <h2>版本</h2>
        <Tag tone={state.status === 'available' || state.status === 'ready' ? 'accent' : 'neutral'}>
          {state.current}
        </Tag>
      </header>

      <p className="update-card__meta">{describe(state.status, state.latest)}</p>
      {state.notes ? <p className="update-card__notes">{state.notes}</p> : null}
      {state.message ? <p className="update-card__error">{state.message}</p> : null}

      {state.status === 'downloading' ? (
        <progress max={100} value={state.progress ?? 0}>
          {state.progress ?? 0}%
        </progress>
      ) : null}

      <div className="update-card__actions">
        <Button
          onClick={() => void controller.check()}
          loading={state.status === 'checking'}
          disabled={state.status === 'downloading'}
        >
          检查更新
        </Button>
        {state.status === 'available' ? (
          <Button variant="primary" onClick={() => void controller.download().catch(() => {})}>
            下载更新
          </Button>
        ) : null}
        {state.status === 'ready' ? (
          <Button
            variant="primary"
            onClick={() => void controller.applyAndRestart().catch(() => {})}
          >
            重启并安装
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function describe(status: string, latest?: string): string {
  switch (status) {
    case 'checking':
      return '正在检查更新…';
    case 'available':
      return `发现新版本 ${latest ?? ''}，下载后可一键重启安装`;
    case 'downloading':
      return '正在下载更新包，完成前可以继续使用';
    case 'ready':
      return '更新已就绪，重启后生效';
    case 'up-to-date':
      return '已是最新版本';
    case 'error':
      return '检查更新失败';
    default:
      return '尚未检查更新';
  }
}
