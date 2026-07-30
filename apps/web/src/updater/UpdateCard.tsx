import { useEffect, useMemo, useState } from 'react';
import { coreClient } from '../data/workspace.js';
import { UpdateController, isDevVersion, type UpdaterBackend } from '@aiwf/client-core';
import { Button, Tag } from '@aiwf/ui';
import type { VersionInfo } from './useAppVersion.js';

export interface UpdateCardProps {
  versionInfo: VersionInfo;
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
export function UpdateCard({ versionInfo, backend, autoCheck = true }: UpdateCardProps) {
  const { version: currentVersion, source, error: versionError } = versionInfo;
  const controller = useMemo(
    () => (backend ? new UpdateController(backend, { currentVersion }) : null),
    [backend, currentVersion],
  );
  const [, forceRender] = useState(0);
  /**
   * applyAndRestart 的失败此前被 `.catch(() => {})` 整个吞掉。
   * 它的两条抛错路径（「更新尚未就绪」「还有未结束的运行」）在 throw 之前
   * 都不 patch state，所以错误既不进 state.message 也不进任何 UI ——
   * 用户点「重启并安装」，应用不重启、不报错、按钮也不变，只能反复点。
   */
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (!controller) return;
    const off = controller.subscribe(() => forceRender((n) => n + 1));
    if (autoCheck) void controller.check();
    return off;
  }, [controller, autoCheck]);

  /*
   * 把「还有未结束的运行」这道护栏接上。
   *
   * `setBlockers` 在 client-core 里定义了、也被 applyAndRestart 读了，
   * 但整个 apps/web 一次都没调过 —— 唯一的调用点在它自己的单测里。
   * 于是用户在有运行正等审批时点「重启并安装」，应用直接重启，
   * 那句「确认后再重启，检查点可恢复」永远不会出现。
   */
  useEffect(() => {
    if (!controller) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const result = (await coreClient.call('run.list', {
          status: ['running', 'waiting_approval', 'paused', 'resuming'],
          limit: 20,
        })) as { items: { id: string; status: string }[] };
        if (cancelled) return;
        controller.setBlockers(result.items.map((run) => ({ runId: run.id, reason: run.status })));
      } catch {
        // 查不到就当没有拦截项：更新卡片不该因为一次查询失败多出一条报错
      }
    };
    void sync();
    return () => {
      cancelled = true;
    };
  }, [controller]);

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

  // 版本读不到就没法比较，检查更新一定不会工作——必须说清原因而不是显示「尚未检查更新」
  if (source === 'unavailable') {
    return (
      <section className="update-card" data-status="error">
        <header className="update-card__head">
          <h2>版本</h2>
          <Tag tone="danger">未知</Tag>
        </header>
        <p className="update-card__error">{versionError ?? '无法读取应用版本'}</p>
        <p className="update-card__meta">版本未知时不会检查更新，避免拿错版本号做比较。</p>
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

      <p className="update-card__meta">
        {isDevVersion(currentVersion)
          ? '开发构建不检查更新（没有对应的发布版本）'
          : describeUpdateStatus(state.status, state.latest)}
      </p>
      {state.notes ? <p className="update-card__notes">{state.notes}</p> : null}
      {state.message ? <p className="update-card__error">{state.message}</p> : null}
      {applyError ? (
        <p className="update-card__error" role="alert">
          {applyError}
        </p>
      ) : null}

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
            onClick={() => {
              setApplyError(null);
              void controller.applyAndRestart().catch((err: unknown) => {
                setApplyError(err instanceof Error ? err.message : String(err));
              });
            }}
          >
            重启并安装
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** 更新状态的一句话说明。**不叫 describe** —— 那个名字与 vitest 注入的
    全局撞，忘了定义时 TypeScript 不会拦，运行时才炸。 */
function describeUpdateStatus(status: string, latest?: string): string {
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
