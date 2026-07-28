import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { coreClient } from '../data/workspace.js';

/**
 * 首次配置 —— 严格照图纸「06 首次安装与检测」。
 *
 * 在此之前这一屏只有一段占位文案，而顶部三个提醒（尚未授权工作目录 /
 * 未设置权限档 / 环境尚未检查）一直悬着。用户点进来找不到任何控件，
 * 却又能绕过它们把工作流跑起来 —— 页面表达出的阻塞程度与实际能力不符。
 *
 * 图纸底部的按钮里**本来就有「仅检测，不安装」**，与「应用不自己下载
 * 任何东西」的决定一致：缺什么给一行可复制的命令，用户自己跑。
 */

interface InstallHint {
  command: string;
  source: string;
}

interface HealthItem {
  capability: string;
  label: string;
  version?: string;
  path?: string;
  source: string;
  status: 'ready' | 'needs_attention' | 'optional' | 'missing';
  detail?: string;
  installHint?: InstallHint;
}

/** 图纸顶部那四步。 */
const STEPS = ['设备与磁盘', '工具与运行时', 'ACP 探测', '目录授权与示例'];

/** 配置过的记号。记下来才不会每次进来都拦人。 */
const SKIP_KEY = 'aiwf.onboarding.skipped';

/**
 * 默认工作目录。图纸「将写入的位置」写的就是它。
 *
 * 展开成绝对路径要走 Tauri 的 path API，Web 形态没有 —— 存这个
 * 可读的形式，引擎侧 resolve_workdir 会把 ~ 展开。
 */
const DEFAULT_WORKDIR = '~/Library/Application Support/AI Workflows';

const STATUS_LABELS: Record<HealthItem['status'], string> = {
  ready: '就绪',
  needs_attention: '需处理',
  optional: '可选',
  missing: '缺失',
};

export function OnboardingPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<HealthItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [diagnosticsPath, setDiagnosticsPath] = useState<string | null>(null);

  /**
   * 授权工作目录并落地配置。
   *
   * 之前这里只写了个 localStorage 就 navigate('/')，于是顶栏仍写
   *「尚未授权工作目录」、侧栏仍写「未设置权限档」「环境尚未检查」——
   * codex 复测的原话：「按钮承诺『用默认目录开始』，实际状态没有落地」。
   *
   * 权限档给最保守的一档：用户还没表达过对任何工作流的信任程度，
   * 默认放宽等于替他做了一个他不知道自己做过的决定。
   */
  const authorize = async () => {
    setAuthorizing(true);
    setError(null);
    try {
      await coreClient.call('workspace.updateSettings', {
        workdir: DEFAULT_WORKDIR,
        permissionPreset: 'review_every_change',
        envCheckedAt: new Date().toISOString(),
      });
      try {
        window.localStorage.setItem(SKIP_KEY, '1');
      } catch {
        // 隐私模式下会抛 —— 记不住也不该挡住用户往下走
      }
      navigate('/');
    } catch (err) {
      // 写失败就留在这一屏。跳走的话用户看到的还是「尚未授权」，
      // 而他刚刚明明点过按钮 —— 那种不一致会让人怀疑整个应用
      setError(describe(err));
    } finally {
      setAuthorizing(false);
    }
  };

  const exportDiagnostics = async () => {
    setError(null);
    try {
      const result = (await coreClient.call('env.diagnostics', {})) as { path: string };
      setDiagnosticsPath(result.path);
    } catch (err) {
      setError(describe(err));
    }
  };

  const probe = async (recheck: boolean) => {
    setChecking(true);
    setError(null);
    try {
      const result = (await coreClient.call('env.health', { recheck })) as {
        items: HealthItem[];
      };
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void probe(false);
  }, []);

  // ACP adapter 单独一段：图纸给了它一整块，因为 AI 节点全靠它
  const acp = (items ?? []).filter((item) => item.capability.startsWith('acp.'));
  const tools = (items ?? []).filter((item) => !item.capability.startsWith('acp.'));
  const missing = (items ?? []).filter(
    (item) => item.status === 'missing' || item.status === 'needs_attention',
  ).length;

  return (
    <article className="onboarding">
      <ol className="onboarding__steps" aria-label="配置步骤">
        {STEPS.map((label, index) => (
          <li key={label} data-done={index === 0 || (index === 1 && missing === 0)}>
            {index + 1} {label}
          </li>
        ))}
      </ol>

      <h1>环境检测与依赖补齐</h1>
      <p className="onboarding__note">
        我们不会静默修改系统。下面列出检测到的内容、版本与位置；缺什么给你一行可复制的命令，
        由你自己执行 —— 不使用 sudo，不改动 shell profile，也不把 App 工具写入全局 PATH。
      </p>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="onboarding__block">
        <p className="onboarding__block-head">
          <i className="ph ph-package" aria-hidden="true" />
          <span>工具与运行时</span>
          <span className="runs__grow" />
          <span className="models__note">
            {missing === 0 ? '必需项都在' : `${missing} 项待处理`}
          </span>
          <button
            type="button"
            className="runs__action"
            disabled={checking}
            onClick={() => void probe(true)}
          >
            {checking ? '检查中' : '重新检查'}
          </button>
        </p>

        {tools.map((item) => (
          <Row key={item.capability} item={item} />
        ))}
      </section>

      <section className="onboarding__block">
        <p className="onboarding__block-head">
          <i className="ph ph-plugs-connected" aria-hidden="true" />
          <span>ACP Runtime 检测</span>
          <span className="runs__grow" />
          <span className="models__note">AI 节点与主管 AI 靠它；没有它其余功能照常</span>
        </p>
        {acp.map((item) => (
          <Row key={item.capability} item={item} />
        ))}
      </section>

      <section className="onboarding__block" aria-label="将写入的位置">
        <p className="onboarding__block-head">
          <i className="ph ph-folder-open" aria-hidden="true" />
          <span>将写入的位置</span>
        </p>
        <pre className="onboarding__paths">
          {'~/Library/Application Support/AI Workflows/{workflows,runs,artifacts,logs}/\n'}
          {'# Secret 只保存在 Keychain，不写入以上目录'}
        </pre>
      </section>

      <footer className="onboarding__foot">
        {/* 图纸底部的三个按钮。第一个的文案跟着「还差几项」走：
            全都就绪时再劝人安装就是噪音，那时该做的是往下走 */}
        <button
          type="button"
          className="runs__action runs__action--primary"
          disabled={authorizing}
          onClick={() => void authorize()}
        >
          {missing > 0 ? `确认并安装（${missing} 项）` : '授权工作目录并开始'}
        </button>
        <button type="button" className="runs__action" onClick={() => void probe(true)}>
          仅检测，不安装
        </button>
        <button type="button" className="runs__action" onClick={() => void exportDiagnostics()}>
          导出脱敏诊断报告
        </button>
        <span className="runs__grow" />
        <span className="models__note">下一步：授权工作目录并运行内置示例</span>
      </footer>

      {diagnosticsPath ? (
        <p className="onboarding__diagnostics" role="status">
          <i className="ph ph-file-text" aria-hidden="true" />
          诊断报告已导出到 <code>{diagnosticsPath}</code>
        </p>
      ) : null}
    </article>
  );
}

function Row({ item }: { item: HealthItem }) {
  return (
    <div className="onboarding__row" data-capability={item.capability} data-status={item.status}>
      <span className="onboarding__row-name">{item.label}</span>
      <span className="onboarding__row-version">{item.version ?? '—'}</span>
      <span className="onboarding__row-path">{item.path ?? item.detail ?? '未安装'}</span>
      <span className="onboarding__row-status">{STATUS_LABELS[item.status]}</span>
      {item.installHint ? (
        <span className="onboarding__row-hint">
          <code>{item.installHint.command}</code>
          <span className="models__note">来自 {item.installHint.source}</span>
        </span>
      ) : null}
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
