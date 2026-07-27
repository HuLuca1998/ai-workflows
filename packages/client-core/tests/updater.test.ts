import { describe, expect, it, vi } from 'vitest';
import { UpdateController, isDevVersion, type UpdaterBackend } from '../src/updater.js';

/**
 * 应用内一键更新的状态机。
 *
 * 状态划分沿用已经跑通的那套（codex-ui/update.go）：
 * idle → checking → up-to-date | available → downloading → ready → 重启。
 *
 * 状态机放在这里而不是 Tauri 插件回调里，是为了能脱离桌面环境测：
 * 下载失败要能重来、并发检查不能重复跑、没确认过的更新不能自己装上去。
 */

function backend(overrides: Partial<UpdaterBackend> = {}): UpdaterBackend {
  return {
    check: async () => ({ available: true, version: '2026.7.28', notes: '修复若干问题' }),
    download: async () => {},
    installAndRestart: async () => {},
    ...overrides,
  };
}

const controller = (b: UpdaterBackend = backend(), currentVersion = '2026.7.27') =>
  new UpdateController(b, { currentVersion });

describe('检查更新', () => {
  it('初始状态是 idle', () => {
    expect(controller().state.status).toBe('idle');
  });

  it('发现新版本进入 available，并带上版本号与说明', async () => {
    const c = controller();
    await c.check();
    expect(c.state).toMatchObject({
      status: 'available',
      latest: '2026.7.28',
      notes: '修复若干问题',
    });
  });

  it('已是最新则进入 up-to-date', async () => {
    const c = controller(backend({ check: async () => ({ available: false }) }));
    await c.check();
    expect(c.state.status).toBe('up-to-date');
  });

  it('检查失败进入 error 并保留原因，可再次检查', async () => {
    const c = controller(
      backend({
        check: async () => {
          throw new Error('network unreachable');
        },
      }),
    );
    await c.check();
    expect(c.state.status).toBe('error');
    expect(c.state.message).toContain('network unreachable');

    // 错误不是终态：网络恢复后还能再查
    const ok = controller();
    await ok.check();
    expect(ok.state.status).toBe('available');
  });

  it('并发调用只真正检查一次', async () => {
    const check = vi.fn(async () => ({ available: false }));
    const c = controller(backend({ check }));
    await Promise.all([c.check(), c.check(), c.check()]);
    expect(check).toHaveBeenCalledOnce();
  });

  it('开发构建不检查更新——本地构建没有对应的 release', async () => {
    const check = vi.fn(async () => ({ available: true, version: 'x' }));
    const c = new UpdateController(backend({ check }), { currentVersion: 'dev' });
    await c.check();
    expect(check).not.toHaveBeenCalled();
    expect(c.state.status).toBe('idle');
  });

  it('识别各种开发版本号', () => {
    expect(isDevVersion('dev')).toBe(true);
    expect(isDevVersion('')).toBe(true);
    expect(isDevVersion('dev-abc123')).toBe(true);
    expect(isDevVersion('2026.7.27-dirty')).toBe(true);
    expect(isDevVersion('2026.7.27')).toBe(false);
  });
});

describe('下载与安装', () => {
  it('下载过程中上报进度，完成后进入 ready', async () => {
    const seen: number[] = [];
    const c = controller(
      backend({
        download: async (onProgress) => {
          onProgress(10);
          onProgress(64);
          onProgress(100);
        },
      }),
    );
    c.subscribe(() => {
      if (c.state.progress !== undefined) seen.push(c.state.progress);
    });

    await c.check();
    await c.download();

    expect(seen).toContain(64);
    expect(c.state.status).toBe('ready');
  });

  it('没检查到可用更新时拒绝下载', async () => {
    const download = vi.fn();
    const c = controller(backend({ download }));
    await expect(c.download()).rejects.toThrow(/没有待安装的更新/u);
    expect(download).not.toHaveBeenCalled();
  });

  it('下载失败退回 available，让用户重试而不是卡在中间态', async () => {
    const c = controller(
      backend({
        download: async () => {
          throw new Error('磁盘空间不足');
        },
      }),
    );
    await c.check();
    await c.download().catch(() => {});

    expect(c.state.status).toBe('available');
    expect(c.state.message).toContain('磁盘空间不足');
  });

  it('并发下载只跑一次', async () => {
    const download = vi.fn(async () => {});
    const c = controller(backend({ download }));
    await c.check();
    await Promise.all([c.download(), c.download()]);
    expect(download).toHaveBeenCalledOnce();
  });

  it('只有 ready 状态才允许安装重启——绝不静默替换正在跑的应用', async () => {
    const installAndRestart = vi.fn(async () => {});
    const c = controller(backend({ installAndRestart }));

    await expect(c.applyAndRestart()).rejects.toThrow(/尚未就绪/u);
    await c.check();
    await expect(c.applyAndRestart()).rejects.toThrow(/尚未就绪/u);
    expect(installAndRestart).not.toHaveBeenCalled();

    await c.download();
    await c.applyAndRestart();
    expect(installAndRestart).toHaveBeenCalledOnce();
  });

  it('有未结束的运行时，安装前要先让调用方确认', async () => {
    const c = controller();
    await c.check();
    await c.download();

    c.setBlockers([{ runId: 'run_1', reason: '等待审批' }]);
    await expect(c.applyAndRestart()).rejects.toThrow(/未结束的运行/u);

    // 用户确认后才放行：重启会中断运行，但检查点能恢复
    await c.applyAndRestart({ force: true });
    expect(c.state.status).toBe('ready');
  });
});

describe('订阅', () => {
  it('每次状态变化都通知，携带完整快照', async () => {
    const c = controller();
    const snapshots: string[] = [];
    c.subscribe(() => snapshots.push(c.state.status));

    await c.check();
    await c.download();

    expect(snapshots[0]).toBe('checking');
    expect(snapshots).toContain('available');
    expect(snapshots.at(-1)).toBe('ready');
  });

  it('取消订阅后不再收到通知', async () => {
    const c = controller();
    let count = 0;
    const off = c.subscribe(() => {
      count += 1;
    });
    off();
    await c.check();
    expect(count).toBe(0);
  });
});
