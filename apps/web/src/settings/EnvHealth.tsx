import { useEffect, useState } from 'react';
import { coreClient } from '../data/workspace.js';
import { describeError } from '../data/describeError.js';
import { pushWorkspaceSettings } from '../data/useWorkspaceSettings.js';
import { CopyButton } from '../layout/CopyButton.js';

/**
 * 运行环境健康 —— 严格照图纸「05 设置与环境」：五列表格。
 *
 * 图纸头一句就是产品原则：「所有依赖由 App 管理，安装在 Application Support 下，
 * 不写入全局 PATH，也不修改 shell profile。」
 *
 * 「路径 / 来源」那一列不是装饰 —— 用户要能自己确认应用用的是哪一个 git，
 * 而不是只被告知「已就绪」。装错版本的排查全靠它。
 */

/**
 * 缺工具时给的一条可复制命令。
 *
 * **应用自己不装任何东西**：不下载、不解压、不写 PATH。
 * 替用户执行下载意味着要为「从哪下载、怎么校验签名、装坏了怎么回滚」
 * 全都做决定，而每个决定都是新的攻击面。
 */
interface InstallHint {
  command: string;
  /** 这条命令的出处，让用户能自己判断要不要跑。 */
  source: string;
  url?: string;
}

interface HealthItem {
  capability: string;
  label: string;
  version?: string;
  path?: string;
  source: 'system' | 'app_managed' | 'missing';
  status: 'ready' | 'needs_attention' | 'optional' | 'missing';
  detail?: string;
  installHint?: InstallHint;
}

interface Report {
  ready: boolean;
  items: HealthItem[];
}

const STATUS_LABELS: Record<HealthItem['status'], string> = {
  ready: '就绪',
  needs_attention: '需处理',
  optional: '可选',
  missing: '缺失',
};

const STATUS_ICONS: Record<HealthItem['status'], string> = {
  ready: 'ph-fill ph-check-circle',
  needs_attention: 'ph-fill ph-warning-circle',
  optional: 'ph ph-minus-circle',
  missing: 'ph-fill ph-x-circle',
};

export function EnvHealth() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const probe = async (recheck: boolean) => {
    setChecking(true);
    setError(null);
    try {
      setReport((await coreClient.call('env.health', { recheck })) as Report);
      if (recheck) {
        // 记下「查过了」。不记的话侧栏那一行永远停在首次配置那一刻 ——
        // 用户装好缺的东西、回这里点了重新检查、看到全绿，
        // 而侧栏还挂着几天前的时间
        try {
          const next = { envCheckedAt: new Date().toISOString() };
          await coreClient.call('workspace.updateSettings', next);
          // 侧栏那行「上次检查」跟着更新，不用重启应用
          pushWorkspaceSettings(next);
        } catch {
          // 记不下不影响这一屏已经查出来的结果 —— 那才是用户点这个按钮想要的
        }
      }
    } catch (err) {
      // describeError 而不是 err.message：CoreApiError 带着「接下来怎么办」，
      // 用 message 会把那半句丢掉
      setError(describeError(err));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void probe(false);
  }, []);

  const items = report?.items ?? [];
  // 「需要处理」的只数必需项 —— 可选项缺失不该让人以为环境坏了
  const pending = items.filter(
    (item) => item.status === 'missing' || item.status === 'needs_attention',
  ).length;

  return (
    <section className="env">
      <h4>运行环境健康</h4>
      <p className="env__note">
        所有依赖由 App 管理，安装在 Application Support 下，不写入全局 PATH，也不修改 shell
        profile。
      </p>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      {report ? (
        <div className="env__summary" data-ready={report.ready}>
          <i
            className={STATUS_ICONS[report.ready ? 'ready' : 'needs_attention']}
            aria-hidden="true"
          />
          <div>
            <p className="env__summary-title">
              {report.ready
                ? `Ready · 全部 ${items.length} 项检查通过`
                : `需要处理 · ${pending} 项`}
            </p>
            <p className="env__summary-sub">
              缺的东西装好之前，用到它的节点会在 Dry Run 就被拦下，而不是跑到一半失败。
            </p>
          </div>
          <span className="runs__grow" />
          <button
            type="button"
            className="runs__action runs__action--primary"
            disabled={checking}
            onClick={() => void probe(true)}
          >
            {checking ? '检查中' : '重新检查'}
          </button>
        </div>
      ) : null}

      {report && !report.ready ? (
        <p className="env__script">
          <i className="ph ph-terminal" aria-hidden="true" />
          <span>
            一项项复制太啰嗦的话，跑一次 <code>bash scripts/install-deps.sh</code>{' '}
            ——它会逐项问过再装，不使用 sudo，也不改 shell profile。脚本在仓库里，可以先看再跑。
          </span>
        </p>
      ) : null}

      <table className="env__table" aria-label="运行环境健康">
        <thead>
          <tr>
            <th scope="col">能力</th>
            <th scope="col">版本</th>
            <th scope="col">路径 / 来源</th>
            <th scope="col">状态</th>
            <th scope="col">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.capability} data-capability={item.capability} data-status={item.status}>
              <td>{item.label}</td>
              <td className="env__mono">{item.version ?? '—'}</td>
              <td className="env__mono">
                {item.source === 'app_managed' ? 'App Managed · ' : ''}
                {item.path ?? item.detail ?? '未安装'}
                {item.source === 'system' && item.path ? ' · 系统' : ''}
              </td>
              <td>
                <span className="env__status">
                  <i className={STATUS_ICONS[item.status]} aria-hidden="true" />
                  {STATUS_LABELS[item.status]}
                </span>
                {item.status !== 'ready' && item.detail ? (
                  <span className="env__detail">{item.detail}</span>
                ) : null}
                {item.installHint ? (
                  <span className="env__hint">
                    <code>{item.installHint.command}</code>
                    <span className="env__hint-source">来自 {item.installHint.source}</span>
                  </span>
                ) : null}
              </td>
              <td>
                {item.installHint ? (
                  // 此前是裸 clipboard 调用：成功没反馈、失败被吞、
                  // 不安全上下文里那个可选链让按钮变成点了没反应的装饰
                  <CopyButton
                    value={item.installHint.command}
                    label="复制"
                    className="env__copy"
                    ariaLabel={`复制 ${item.label} 的安装命令`}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
