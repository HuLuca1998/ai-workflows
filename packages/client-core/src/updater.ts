/**
 * 应用内一键更新。
 *
 * 桌面形态接 tauri-plugin-updater（签名由内嵌公钥校验，私钥只在 GitHub Secret 里）；
 * Web 形态没有自更新，退化为「有新版本，请刷新」的提示。
 *
 * 状态机与 UI 解耦，也与 Tauri 解耦：后端行为通过 UpdaterBackend 注入，
 * 所以下载失败重试、并发保护、未确认不安装这些规则都能在普通测试里验证。
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

/**
 * 可选字段显式带 `| undefined`：状态推进时要能把上一轮的错误信息、进度清掉，
 * 在 exactOptionalPropertyTypes 下「设为 undefined」和「不设」是两回事。
 */
export interface UpdateState {
  status: UpdateStatus;
  current: string;
  latest?: string | undefined;
  notes?: string | undefined;
  /** 0–100，仅下载期间有值。 */
  progress?: number | undefined;
  /** 错误原因；进入 error 或从下载失败退回时保留，供界面展示。 */
  message?: string | undefined;
  checkedAt?: number | undefined;
}

export interface UpdaterBackend {
  check(): Promise<{ available: boolean; version?: string; notes?: string }>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /** 安装并重启。调用后当前进程即将退出。 */
  installAndRestart(): Promise<void>;
}

export interface UpdateBlocker {
  runId: string;
  reason: string;
}

export interface UpdateControllerOptions {
  currentVersion: string;
  /** 注入时钟，便于测试。 */
  now?: () => number;
}

/** 本地构建没有对应的 release tag，不该去查更新。 */
export function isDevVersion(version: string): boolean {
  const v = version.trim().toLowerCase();
  return v === '' || v === 'dev' || v.startsWith('dev-') || v.endsWith('-dirty');
}

export class UpdateController {
  private readonly backend: UpdaterBackend;
  private readonly now: () => number;
  private current: UpdateState;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private downloading: Promise<void> | null = null;
  private blockers: UpdateBlocker[] = [];

  constructor(backend: UpdaterBackend, options: UpdateControllerOptions) {
    this.backend = backend;
    this.now = options.now ?? (() => Date.now());
    this.current = { status: 'idle', current: options.currentVersion };
  }

  get state(): UpdateState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 未结束的运行：重启会打断它们，安装前要让用户知道。 */
  setBlockers(blockers: UpdateBlocker[]): void {
    this.blockers = blockers;
  }

  async check(): Promise<void> {
    if (isDevVersion(this.current.current)) return;
    // 定时轮询与手动点击可能撞上，只跑一次
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      this.patch({ status: 'checking', message: undefined });
      try {
        const result = await this.backend.check();
        if (result.available) {
          this.patch({
            status: 'available',
            checkedAt: this.now(),
            ...(result.version === undefined ? {} : { latest: result.version }),
            ...(result.notes === undefined ? {} : { notes: result.notes }),
          });
        } else {
          this.patch({ status: 'up-to-date', checkedAt: this.now() });
        }
      } catch (error) {
        this.patch({ status: 'error', message: describe(error), checkedAt: this.now() });
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  async download(): Promise<void> {
    if (this.current.status !== 'available' && this.current.status !== 'downloading') {
      throw new Error('没有待安装的更新：请先检查更新');
    }
    if (this.downloading) return this.downloading;

    this.downloading = (async () => {
      this.patch({ status: 'downloading', progress: 0, message: undefined });
      try {
        await this.backend.download((percent) => {
          this.patch({ progress: Math.max(0, Math.min(100, Math.round(percent))) });
        });
        this.patch({ status: 'ready', progress: 100 });
      } catch (error) {
        // 退回 available 而不是停在 downloading：用户能直接重试
        this.patch({ status: 'available', progress: undefined, message: describe(error) });
        throw error;
      } finally {
        this.downloading = null;
      }
    })();

    return this.downloading;
  }

  /**
   * 安装并重启。
   * 只有 ready 才允许——绝不在用户没确认的情况下替换正在运行的应用。
   */
  async applyAndRestart(options: { force?: boolean } = {}): Promise<void> {
    if (this.current.status !== 'ready') {
      throw new Error('更新尚未就绪：请先下载');
    }
    if (this.blockers.length > 0 && !options.force) {
      const detail = this.blockers.map((b) => `${b.runId}（${b.reason}）`).join('、');
      throw new Error(`还有未结束的运行：${detail}。确认后再重启，检查点可恢复`);
    }
    await this.backend.installAndRestart();
  }

  private patch(next: Partial<UpdateState>): void {
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
