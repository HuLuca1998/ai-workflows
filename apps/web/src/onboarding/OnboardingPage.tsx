import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { APPROVAL_MODES, APPROVAL_MODE_LABELS } from '@aiwf/contracts';

import { describeError } from '../data/describeError.js';
import { coreClient } from '../data/workspace.js';
import {
  pickDirectory,
  canPickDirectory,
  readNotificationPermission,
  requestNotificationPermission,
  NOTIFICATION_SETTINGS_URL,
  type NotificationPermission,
} from './platform.js';

/**
 * 首次配置。
 *
 * ## 为什么它不叫「首次」
 *
 * 应用是 ad-hoc 签名的（不买 Developer ID），designated requirement
 * 退化成 **cdhash 精确匹配** —— 实测：
 *
 * ```console
 * $ codesign -d -r- "/Applications/AI Workflows.app"
 * # designated => cdhash H"fb9e1363…"
 * ```
 *
 * 改一个字符重新构建，cdhash 就变，**上一版拿到的每一条 TCC 授权都不再适用**：
 * 文稿访问要重新弹窗，通知授权回到「未询问」。所以这一屏是
 * 「版本变化后重新验」，而它的判据必须是**真探测**，不能是
 * 「用户点过授权按钮」——点过而授权已失效的状态每次更新后都会出现。
 * 详见 docs/MACOS-PERMISSIONS.md。
 *
 * ## 为什么没有「先跳过」
 *
 * 带着一个写不进去的工作目录进主界面，第一次运行才发现 ——
 * 那时用户已经配了半条工作流。**必需项没过就不放行**是产品决定，
 * 不是技术限制；可选项（通知、gh 登录）不拦。
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

interface DirectoryCheck {
  resolved: string;
  exists: boolean;
  writable: boolean;
  isGitRepo: boolean;
  tccProtected: boolean;
  message?: string;
}

/**
 * 默认工作目录。
 *
 * 只是**初值**，用户随时能改 —— 上一版把它写死在这里，
 * 界面上连一个输入框都没有。
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
  const [saving, setSaving] = useState(false);

  const [workdir, setWorkdir] = useState(DEFAULT_WORKDIR);
  const [dirCheck, setDirCheck] = useState<DirectoryCheck | null>(null);
  const [mode, setMode] = useState<string>('human_approval');
  const [notify, setNotify] = useState<NotificationPermission>('unsupported');
  const [diagnosticsPath, setDiagnosticsPath] = useState<string | null>(null);

  const probe = async (recheck: boolean) => {
    setChecking(true);
    setError(null);
    try {
      const result = (await coreClient.call('env.health', { recheck })) as { items: HealthItem[] };
      setItems(result.items);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setChecking(false);
    }
  };

  /**
   * 探一下这个目录。
   *
   * **每次改动都探**，不缓存结果：TCC 授权会因为 App 更新而失效，
   * 而「上次探过是好的」在那之后不成立。
   */
  const checkDir = async (path: string) => {
    setError(null);
    try {
      setDirCheck((await coreClient.call('env.checkDirectory', { path })) as DirectoryCheck);
    } catch (err) {
      setError(describeError(err));
      setDirCheck(null);
    }
  };

  const chooseDir = async () => {
    const picked = await pickDirectory(workdir);
    if (!picked) return; // 用户取消了 —— 什么都不做，别把已选的清掉
    setWorkdir(picked);
    await checkDir(picked);
  };

  useEffect(() => {
    void probe(false);
    void readNotificationPermission().then(setNotify);
    // 已经配过一次的用户回到这屏(设置里也嵌着它):读已存的值回填,
    // 别把默认路径当初值 —— 在这屏点保存会把真实配置覆盖掉(第 10 轮实测 A-4)
    void coreClient
      .call('workspace.settings', {})
      .then((raw) => {
        const settings = raw as { workdir?: string; permissionPreset?: string };
        const dir = settings.workdir ?? DEFAULT_WORKDIR;
        setWorkdir(dir);
        if (settings.permissionPreset) setMode(settings.permissionPreset);
        void checkDir(dir);
      })
      .catch(() => {
        // 读不到就按首次进:用默认路径
        void checkDir(DEFAULT_WORKDIR);
      });
  }, []);

  const missingRequired = (items ?? []).filter(
    (item) => item.status === 'missing' || item.status === 'needs_attention',
  );
  const acp = (items ?? []).filter((item) => item.capability.startsWith('acp.'));
  const tools = (items ?? []).filter((item) => !item.capability.startsWith('acp.'));
  const dirUsable = dirCheck?.writable === true;
  const canStart = missingRequired.length === 0 && dirUsable && items !== null;

  /**
   * 落地配置并进入应用。
   *
   * 三件事一起写：工作目录、审批档、检查时间。少写一样，
   * 顶栏或侧栏就会继续显示「尚未…」，而用户刚刚明明点过按钮。
   */
  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      await coreClient.call('workspace.updateSettings', {
        workdir: dirCheck?.resolved ?? workdir,
        permissionPreset: mode,
        envCheckedAt: new Date().toISOString(),
      });
      navigate('/');
    } catch (err) {
      // 写失败就留在这一屏。跳走的话用户看到的还是「尚未授权」，
      // 而他刚刚明明点过按钮 —— 那种不一致会让人怀疑整个应用
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const exportDiagnostics = async () => {
    setError(null);
    try {
      const result = (await coreClient.call('env.diagnostics', {})) as { path: string };
      setDiagnosticsPath(result.path);
    } catch (err) {
      setError(describeError(err));
    }
  };

  /**
   * 步骤条的每一格。
   *
   * 判据就是页面上那一块的真实状态 —— 上一版的第 3、4 步**恒为灰**
   * （条件只写到 index === 1），ACP 探到了、目录也授权了，那两步照旧不亮。
   * 步骤条在说假话比没有步骤条更糟。
   */
  const steps: { label: string; done: boolean }[] = [
    // 应用已经在这台机器上跑起来了，这一步天然成立
    { label: '设备与磁盘', done: true },
    { label: '工作目录', done: dirUsable },
    { label: '工具与运行时', done: items !== null && missingRequired.length === 0 },
    // ACP 是可选的：没有它 AI 节点跑不了，但其余功能照常。
    // 所以这一格亮不亮不影响能不能开始
    { label: 'ACP 探测', done: acp.some((item) => item.status === 'ready') },
  ];

  return (
    <article className="onboarding">
      <ol className="onboarding__steps" aria-label="配置步骤">
        {steps.map((step, index) => (
          <li key={step.label} data-done={step.done}>
            {index + 1} {step.label}
          </li>
        ))}
      </ol>

      <h1>配置这台机器</h1>
      <p className="onboarding__note">
        我们不会静默修改系统。下面列出检测到的内容、版本与位置；缺什么给你一行可复制的命令，
        由你自己执行 —— 不使用 sudo，不改动 shell profile，也不把 App 工具写入全局 PATH。
      </p>
      {/* 说清这一屏为什么可能再来一次。不说的话，用户下次更新后看到它会以为设置丢了 */}
      <p className="onboarding__note">
        这个应用用的是 ad-hoc 签名，macOS 按可执行文件的哈希认它 ——
        <strong>每次更新之后，之前给过的目录访问与通知授权都要重新给一次</strong>。
        所以这一屏在版本变化后还会出现，而它每次都是真探测，不是读一个「配过了」的标记。
      </p>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      {/* ── 工作目录 ─────────────────────────────────────────────── */}
      <section className="onboarding__block" aria-label="工作目录设置">
        <p className="onboarding__block-head">
          <i className="ph ph-folder-open" aria-hidden="true" />
          <span>工作目录</span>
          <span className="runs__grow" />
          <span className="models__note">运行记录、产物与日志会写在这里</span>
        </p>

        <div className="onboarding__dir">
          <label className="onboarding__dir-label" htmlFor="onboarding-workdir">
            工作目录
          </label>
          <input
            id="onboarding-workdir"
            className="onboarding__dir-input"
            value={workdir}
            aria-invalid={dirCheck !== null && !dirCheck.writable ? 'true' : undefined}
            onChange={(event) => setWorkdir(event.target.value)}
            onBlur={(event) => void checkDir(event.target.value)}
          />
          {/* 原生面板走 macOS 的 powerbox —— 用户在面板里选中的路径，
              系统直接授权给 App。手输拿不到这个授权，所以 Web 形态
              只有输入框，而且下面会说清这件事 */}
          {canPickDirectory() ? (
            <button type="button" className="runs__action" onClick={() => void chooseDir()}>
              选择…
            </button>
          ) : null}
        </div>

        {dirCheck ? (
          <p
            className={dirCheck.writable ? 'onboarding__dir-ok' : 'runs__error'}
            role={dirCheck.writable ? 'status' : 'alert'}
          >
            {dirCheck.writable ? (
              <>
                <i className="ph ph-check-circle" aria-hidden="true" /> 可以写入：
                <code>{dirCheck.resolved}</code>
                {dirCheck.isGitRepo ? '（这是一个 git 仓库）' : null}
              </>
            ) : (
              (dirCheck.message ?? '这个目录用不了')
            )}
          </p>
        ) : null}

        {/* 落在 TCC 保护区时提前说清楚。不说的话，用户下次跑工作流时
            撞上 EPERM，而 git 报的错完全不提 TCC */}
        {dirCheck?.tccProtected ? (
          <p className="onboarding__warn">
            这个位置受 macOS 的文件访问保护（文稿 / 桌面 / 下载）。现在能写， 但
            <strong>每次更新应用之后都要重新授权一次</strong> ——
            换一个不在这几个文件夹里的位置能免掉它。
          </p>
        ) : null}

        {!canPickDirectory() ? (
          <p className="models__note">
            当前形态没有原生目录选择器，只能手输。手输的路径拿不到 macOS
            的一次性授权，实际能不能写以上面那次探测为准。
          </p>
        ) : null}
      </section>

      {/* ── 工具与运行时 ──────────────────────────────────────────── */}
      <section className="onboarding__block">
        <p className="onboarding__block-head">
          <i className="ph ph-package" aria-hidden="true" />
          <span>工具与运行时</span>
          <span className="runs__grow" />
          <span className="models__note">
            {missingRequired.length === 0 ? '必需项都在' : `${missingRequired.length} 项待处理`}
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

      {/* ── ACP ──────────────────────────────────────────────────── */}
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

      {/* ── 系统权限 ─────────────────────────────────────────────── */}
      <section className="onboarding__block" aria-label="系统权限">
        <p className="onboarding__block-head">
          <i className="ph ph-shield-check" aria-hidden="true" />
          <span>系统权限</span>
          <span className="runs__grow" />
          <span className="models__note">只申请用得到的那些</span>
        </p>

        <div className="onboarding__row" data-capability="permission.notification">
          <span className="onboarding__row-name">通知</span>
          <span className="onboarding__row-version">可选</span>
          <span className="onboarding__row-path">
            {notify === 'granted'
              ? '已授权 —— 运行完成、失败、等审批时会提醒你'
              : notify === 'denied'
                ? '已拒绝。应用没法再弹那个授权框了，到系统设置里打开'
                : notify === 'default'
                  ? '还没问过。用到「系统通知」节点时才需要'
                  : '当前形态发不了系统通知'}
          </span>
          <span className="onboarding__row-status">
            {notify === 'granted' ? '就绪' : notify === 'denied' ? '已拒绝' : '可选'}
          </span>
          {/* 「没问过」与「拒绝过」必须分开：前者点一下就解决，
              后者系统不会再弹框，给按钮只会让人一直点一个没反应的东西 */}
          {notify === 'default' ? (
            <button
              type="button"
              className="runs__action"
              onClick={() => void requestNotificationPermission().then(setNotify)}
            >
              允许通知
            </button>
          ) : null}
          {notify === 'denied' ? (
            <a className="onboarding__row-hint" href={NOTIFICATION_SETTINGS_URL}>
              到系统设置里打开
            </a>
          ) : null}
        </div>
      </section>

      {/* ── 审批策略 ─────────────────────────────────────────────── */}
      <section className="onboarding__block" aria-label="审批策略选择">
        <p className="onboarding__block-head">
          <i className="ph ph-user-check" aria-hidden="true" />
          <span>谁来审批</span>
          <span className="runs__grow" />
          <span className="models__note">之后随时能在设置里改</span>
        </p>
        <p className="models__note">
          工作流里的关键位置会有「审批」节点 —— 比如探索完成要开始改代码之前、 代码写完要开 PR
          之前。这一档决定那些门由谁批。
        </p>

        <div className="permission__cards" role="radiogroup" aria-label="审批策略">
          {APPROVAL_MODES.map((id) => {
            const card = APPROVAL_MODE_LABELS[id];
            return (
              <label key={id} className="permission__card" data-active={mode === id}>
                <input
                  type="radio"
                  name="onboarding-approval"
                  className="sr-only"
                  checked={mode === id}
                  onChange={() => setMode(id)}
                />
                <span className="permission__card-name">
                  {mode === id ? (
                    <i className="ph-fill ph-radio-button" aria-hidden="true" />
                  ) : null}
                  {card.name}
                </span>
                <span className="permission__card-detail">{card.detail}</span>
              </label>
            );
          })}
        </div>
      </section>

      {/* ── 缺什么怎么装 ─────────────────────────────────────────── */}
      {missingRequired.length > 0 ? (
        <section className="onboarding__block" aria-label="要执行的命令">
          <p className="onboarding__block-head">
            <i className="ph ph-terminal" aria-hidden="true" />
            <span>要执行的命令</span>
          </p>
          <p className="models__note">
            应用不替你下载任何东西。替你执行下载与解压，就要为「从哪下载、怎么校验签名、
            装坏了怎么回滚」全都做决定，而每个决定都是新的攻击面。 这些命令不使用 sudo，也不改你的
            shell profile。
          </p>
          <ul className="onboarding__commands">
            {missingRequired
              .filter((item) => item.installHint)
              .map((item) => (
                <li key={item.capability}>
                  <span className="onboarding__command-name">{item.label}</span>
                  <code>{item.installHint?.command}</code>
                  <span className="models__note">来自 {item.installHint?.source}</span>
                </li>
              ))}
          </ul>
          <p className="onboarding__script">
            或者一次装齐：
            <code>bash scripts/install-deps.sh</code>
            <span className="models__note">
              它会先打印每条要执行的命令，确认后才执行；<code>--dry-run</code> 只看不装
            </span>
          </p>
        </section>
      ) : null}

      <footer className="onboarding__foot">
        {/*
         * **没有「先跳过」。**
         *
         * 这一屏之前有过一个「跳过配置，用默认目录开始」，它只写了个
         * localStorage 就走人，而顶栏仍写着「尚未授权工作目录」——
         * 按钮承诺的事没有发生。现在的做法是：必需项没过就点不动，
         * 并且在按钮旁边说清还差什么。
         */}
        <button
          type="button"
          className="runs__action runs__action--primary"
          disabled={!canStart || saving}
          onClick={() => void finish()}
        >
          {saving ? '正在保存…' : '开始使用'}
        </button>
        <button
          type="button"
          className="runs__action"
          disabled={checking}
          onClick={() => void probe(true)}
        >
          仅检测，不安装
        </button>
        <button type="button" className="runs__action" onClick={() => void exportDiagnostics()}>
          导出脱敏诊断报告
        </button>
        <span className="runs__grow" />
        {/* 点不动的按钮旁边必须说清为什么 —— 否则用户只看到一个灰按钮 */}
        <span className="models__note">
          {canStart
            ? '配置会写入工作区设置，之后随时能在「设置」里改'
            : !dirUsable
              ? '先选一个能写入的工作目录'
              : `还差 ${missingRequired.length} 项必需工具`}
        </span>
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
