import { useEffect, useState } from 'react';
import { coreClient } from '../data/workspace.js';
import { describeError } from '../data/describeError.js';
import { formatBytes } from '../data/format.js';

/**
 * 一键初始化 —— 设置「高级」档。
 *
 * 图纸没画这一档的内容，所以视觉上沿用 Nocturne 令牌与设置页既有的
 * 卡片结构，不自创样式。行为照这个应用一贯的做法：**先说清楚要删什么，
 * 再让点确认** —— 图纸「06 首次安装与检测」把「将写入的位置」逐条
 * 列出来才让你点安装，删东西没有理由更随意。
 *
 * 清单是**问引擎要的**，不是这里编的。写死一份「将删除 runs / logs /
 * artifacts」的文案看起来一样，但它在用户没有产物目录时照样那么说，
 * 而在他有第二个工作目录时又漏掉 —— 那种清单让人没法据以判断。
 */

interface ResetDirectory {
  path: string;
  kind: 'runs' | 'logs' | 'artifacts';
  bytes: number;
  insideWorkdir: boolean;
}

interface ResetPreview {
  counts: {
    workflows: number;
    runs: number;
    memories: number;
    agents: number;
    prompts: number;
    models: number;
  };
  directories: ResetDirectory[];
}

/** 计数的中文名。顺序就是确认框里念的顺序 —— 用户最在意的排前面。 */
const COUNT_LABELS: { key: keyof ResetPreview['counts']; label: string }[] = [
  { key: 'workflows', label: '工作流' },
  { key: 'runs', label: '运行记录' },
  { key: 'memories', label: '记忆' },
  { key: 'agents', label: 'Agent 角色' },
  { key: 'prompts', label: '提示词' },
  { key: 'models', label: '模型' },
];

const DIR_LABELS: Record<ResetDirectory['kind'], string> = {
  runs: '默认运行目录',
  logs: '日志',
  artifacts: '运行产物',
};

export function WorkspaceReset() {
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [withArtifacts, setWithArtifacts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[] | null>(null);

  const artifactDir = preview?.directories.find((d) => d.kind === 'artifacts');

  /** 对话框一挂上就聚焦。回调 ref 而不是 useEffect：挂载那一刻就跑到。 */
  const focusDialog = (node: HTMLDivElement | null) => node?.focus();

  // Esc 关框。挂在 window 上而不是对话框上 —— 焦点可能已经被用户
  // 移到框外（点了一下背景），那时挂在框上的监听就收不到了
  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 正在删的时候不许关：关掉只是让用户看不见，删除照样在跑
      if (event.key === 'Escape' && !busy) setPreview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview, busy]);

  const openDialog = async () => {
    setError(null);
    setRemoved(null);
    try {
      const result = (await coreClient.call('workspace.resetPreview', {})) as ResetPreview;
      setPreview(result);
      // 每次重新打开都回到「不删产物」：上一次勾过不代表这一次也想删
      setWithArtifacts(false);
    } catch (err) {
      // 拿不到清单就不开框：拿一份编的清单让人点确认，
      // 等于让他在不知道要删什么的情况下同意
      setError(describeError(err));
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = (await coreClient.call('workspace.reset', {
        confirm: true,
        includeArtifacts: withArtifacts,
      })) as { removedDirectories: string[] };
      setPreview(null);
      // 回显引擎说的，不是我们请求的：目录本来就不存在时它不在这份清单里，
      // 照着请求参数说「已清除产物」就是在说假话
      setRemoved(result.removedDirectories);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="reset" aria-label="一键初始化">
      <h5 className="reset__title">一键初始化</h5>
      <p className="reset__detail">
        把这台机器上的数据清空重来：工作流、运行记录、记忆、提示词与你改过的 Agent
        角色全部删除，然后重新种上内置的模型、角色、提示词与一条示例工作流。
        <strong className="reset__warn">这一步不可逆，没有撤销。</strong>
      </p>
      {/* 「设置也会没」必须写在这里而不是确认框里：用户是照着这段话
          决定要不要点开的，等点开才说等于让他先吓一跳 */}
      <p className="reset__keep">
        工作目录授权与权限档也存在数据库里，一并清除 —— 重置之后要重走一遍首次配置。 Keychain
        里的凭据不受影响，MCP 的接入配置也保留（那两样不在数据库里）。
      </p>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      {removed ? (
        <p className="reset__done" role="status">
          {removed.length > 0
            ? `已清空数据库并重种内置数据，同时清除了：${removed.join('、')}`
            : '已清空数据库并重种内置数据。没有需要清除的目录。'}
        </p>
      ) : null}

      <button type="button" className="runs__action reset__go" onClick={() => void openDialog()}>
        一键初始化…
      </button>

      {preview ? (
        <div className="reset__backdrop">
          <div
            className="reset__dialog"
            role="dialog"
            aria-modal="true"
            aria-label="一键初始化"
            // 打开就把焦点收进来：读屏用户否则听不到这个框存在，
            // 而 Esc 也要有焦点在框内才收得到
            tabIndex={-1}
            ref={focusDialog}
          >
            <h4 className="reset__dialog-title">确认一键初始化</h4>

            <p className="reset__dialog-lead">下面这些会被删掉，删完不能恢复：</p>
            <p className="reset__dialog-note">
              工作目录授权与权限档一并清除，重置后要重走首次配置。
            </p>
            <ul className="reset__counts">
              {COUNT_LABELS.map(({ key, label }) => (
                <li key={key}>
                  <span className="reset__count-num">{preview.counts[key]}</span>
                  <span className="reset__count-label">{label}</span>
                </li>
              ))}
            </ul>

            {preview.directories.length > 0 ? (
              <ul className="reset__dirs">
                {preview.directories.map((dir) => (
                  <li key={dir.path} data-inside-workdir={dir.insideWorkdir}>
                    <span className="reset__dir-kind">
                      {DIR_LABELS[dir.kind]}
                      {/* 在用户仓库里的那条单独说明白 —— 它不是 App 的地盘 */}
                      {dir.insideWorkdir ? (
                        <em className="reset__dir-warn">在你授权的工作目录里</em>
                      ) : null}
                    </span>
                    <code className="reset__dir-path">{dir.path}</code>
                    <span className="reset__dir-size">{formatBytes(dir.bytes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {artifactDir ? (
              <label className="reset__opt">
                <input
                  type="checkbox"
                  checked={withArtifacts}
                  onChange={(event) => setWithArtifacts(event.target.checked)}
                />
                {/* 路径不在这里重复第二遍 —— 上面那份清单里已经列了全路径，
                    同一个路径写两处，改动时必然只改一处 */}
                <span>
                  同时删除上面那条运行产物。不勾的话它留在原地， 工作目录里的其他文件一概不动。
                </span>
              </label>
            ) : null}

            <div className="reset__actions">
              <button
                type="button"
                className="runs__action"
                onClick={() => setPreview(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                type="button"
                className="runs__action reset__confirm"
                onClick={() => void run()}
                disabled={busy}
              >
                {busy ? '清除中…' : '确认，清空并重来'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
