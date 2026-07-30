import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../data/format.js';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { useNavigate } from 'react-router';
import { Button, type RunStatusName, StatusBadge, Tag } from '@aiwf/ui';
import { WORKFLOW_TEMPLATES, type Workflow, LIST_PAGE_SIZE } from '@aiwf/contracts';
import { Pager } from '../layout/Pager.js';
import { parseGraphFile } from '../editor/importGraph.js';
import { coreClient, useWorkspace } from '../data/workspace.js';

/**
 * 概览与工作流 —— 严格照图纸「01 工作流首页」。
 *
 * 统计条的四张卡、标签、字号、颜色、筛选 chips 的药丸形状与位置都取自图纸。
 *
 * 数值一律来自真实数据。唯一空着的是 Token 用量 ——
 * 事件流里目前不记 token，显示 0 会被读成「这周没花钱」，
 * 那比空着更糟；缺席时显示「—」。
 *
 * 状态列显示的是**最近一次运行**的状态，不是工作流自身的。
 * 只看工作流的话每一行都是「已创建 · 未运行 · 草稿」——
 * 发布并跑过三次也照样，跟执行记录完全对不上。
 */

interface Stats {
  pendingApprovals: number;
  pendingApprovalHint?: string;
  runsToday: number;
  runsTodaySucceeded: number;
  tokensThisWeek?: number;
  activeWorktrees: number;
  worktreeBytes: number;
}

/** 运行状态 → 图纸上的状态列文案与徽章。 */
const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_approval: '等待审批',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const FILTERS = ['全部', '运行中', '草稿', '失败'] as const;
type Filter = (typeof FILTERS)[number];

/** chip → 后端认的状态。「全部」不带这个参数。 */
const FILTER_STATUS: Record<Filter, string | null> = {
  全部: null,
  运行中: 'running',
  草稿: 'draft',
  失败: 'failed',
};

export function OverviewPage() {
  const navigate = useNavigate();
  const {
    workflows,
    total,
    offset,
    loading,
    error,
    load,
    setFilter: setServerFilter,
    createWorkflow,
    importWorkflow,
  } = useWorkspace();
  const [filter, setFilter] = useState<Filter>('全部');
  // 输入即搜（300ms 防抖），回车立刻搜。声明必须在 setServerFilter 之后 ——
  // 提前的话闭包读到的是 TDZ 里的绑定
  const search = useDebouncedSearch((q) => void setServerFilter(FILTER_STATUS[filter], q));
  const query = search.value;
  const [creating, setCreating] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * 新建的重入保护。
   *
   * 用 ref 而不是 `creating` state：setState 在同一批事件里不会立刻生效，
   * 快速连点五次时五个 handler 读到的 creating 都还是 false ——
   * 于是建出五条空工作流。ref 的写入是同步的。
   */
  const creatingRef = useRef(false);

  useEffect(() => {
    void load();
    // 统计卡失败不该拖垮首页 —— 列表才是这一屏的主体
    void coreClient
      .call('workspace.stats', {})
      .then((result) => setStats(result as Stats))
      .catch(() => setStats(null));
  }, [load]);

  // 筛选与搜索都在后端做了，这里直接用返回的那一页 ——
  // 前端再过滤一次的话，翻到第 29 页点「失败」只会过滤那 50 条
  const visible = workflows;
  /** 有没有加着条件。空列表的两种含义靠它区分。 */
  const filtered = filter !== '全部' || query.trim() !== '';

  const onCreate = async (templateId?: string) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const template = templateId ? WORKFLOW_TEMPLATES.find((t) => t.id === templateId) : undefined;
      const id = await createWorkflow(
        // 不给名字时由引擎编号：界面只看得到当前页，
        // 用页内条数 +1 的话每次新建都叫「未命名工作流 51」
        template ? template.name : null,
        template?.operations,
      );
      // 建完直接进编辑器：新建的意图就是要去搭流程
      if (id) navigate(`/editor/${id}`);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <article className="overview">
      <header className="overview__head">
        <div>
          {/* 用总数而不是当前页的行数 —— 这句话看起来就是全量统计 */}
          <p className="kicker">本地优先 · {total.toLocaleString('en-US')} 个工作流</p>
          <h1>工作流</h1>
        </div>
        <span className="overview__grow" />
        <label className="search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          {/* 占位文案里写明要回车 —— 不写的话「输入后等几秒列表没变」
              很像搜索失效，而搜索是在后端做的（前端过滤只能过滤当前页） */}
          {/* 输入即搜（300ms 防抖），回车立刻搜。
              搜索发给后端 —— 前端过滤只能过滤当前页 */}
          <input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search.onEnter();
            }}
            placeholder="搜索工作流、运行或产物"
            aria-label="搜索工作流"
          />
        </label>
        <Button onClick={() => fileInput.current?.click()}>导入</Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="导入工作流文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setImportError(null);
            void file.text().then(async (text) => {
              const result = parseGraphFile(text);
              if (!result.ok || !result.graph) {
                // 导入失败必须说清原因：坏图一旦进来会先覆盖草稿再乱来
                setImportError(result.error ?? '导入失败');
                return;
              }
              setCreating(true);
              try {
                const id = await importWorkflow(file.name.replace(/\.json$/iu, ''), result.graph);
                if (id) navigate(`/editor/${id}`);
              } finally {
                setCreating(false);
              }
            });
          }}
        />
        <Button variant="primary" onClick={() => void onCreate()} loading={creating}>
          <i className="ph ph-plus" aria-hidden="true" />
          新建工作流
        </Button>
      </header>

      <section className="stats" role="region" aria-label="概览统计">
        <Stat
          label="等待审批"
          accent
          {...(stats ? { value: String(stats.pendingApprovals) } : {})}
          {...(stats?.pendingApprovalHint ? { note: stats.pendingApprovalHint } : {})}
        />
        <Stat
          label="今日运行"
          noteTone="success"
          {...(stats ? { value: String(stats.runsToday) } : {})}
          {...(stats ? { note: `${stats.runsTodaySucceeded} 成功` } : {})}
        />
        <Stat
          label="Token 用量"
          {...(stats ? { value: formatTokens(stats.tokensThisWeek), note: '本周' } : {})}
        />
        <Stat
          label="活跃 worktree"
          {...(stats ? { value: String(stats.activeWorktrees) } : {})}
          {...(stats ? { note: `占用 ${formatBytes(stats.worktreeBytes)}` } : {})}
        />
      </section>

      <section className="list" role="region" aria-label="全部工作流">
        <header className="list__head">
          <h2>全部工作流</h2>
          {/*
            这一组切的是**后端查询条件**，不是视图 —— 底下是一张表，没有
            对应的 tabpanel 可指。用 role=tab 的话读屏用户被告知「4 个标签页」，
            按方向键期望切换面板，实际什么都不发生。toggle 组才是它的真语义。
          */}
          <div className="chips" role="group" aria-label="状态筛选">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                className="chip"
                onClick={() => {
                  setFilter(f);
                  void setServerFilter(FILTER_STATUS[f], search.value);
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <p className="list__error" role="alert">
            读取失败：{error}
          </p>
        ) : null}

        {importError ? (
          <p className="list__error" role="alert">
            导入失败：{importError}
          </p>
        ) : null}

        {loading && workflows.length === 0 ? <p className="list__hint">正在读取…</p> : null}

        {/* 「一条都没有」与「筛选后没有」是两回事：
            前者该给模板引导，后者该给一个清掉条件的出口。
            混成一个的话，用户筛完看到「还没有工作流」会以为数据丢了 */}
        {!loading && workflows.length === 0 && !error && !filtered ? (
          <div className="empty">
            <i className="ph ph-flow-arrow" aria-hidden="true" />
            <p className="empty__title">还没有工作流</p>
            <p className="empty__detail">从模板开始，或新建一个空工作流再从左侧拖入入口节点。</p>

            <div className="templates">
              {WORKFLOW_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="template"
                  onClick={() => void onCreate(template.id)}
                  disabled={creating}
                >
                  <span className="template__name">{template.name}</span>
                  <span className="template__summary">{template.summary}</span>
                </button>
              ))}
            </div>

            <Button variant="primary" onClick={() => void onCreate()} loading={creating}>
              新建空白工作流
            </Button>
          </div>
        ) : null}

        {workflows.length > 0 || filtered ? (
          <table className="wf-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">状态</th>
                <th scope="col">最近一次运行</th>
                <th scope="col">版本 · 触发</th>
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((w) => (
                <tr
                  key={w.id}
                  onClick={() => navigate(`/editor/${w.id}`)}
                  data-clickable="true"
                  data-workflow-id={w.id}
                  title="打开编辑器"
                >
                  <td>
                    <p className="wf-table__name">{w.name}</p>
                    <p className="wf-table__desc">
                      {w.folder ? `${w.folder} · ` : ''}
                      更新于 {formatTime(w.updatedAt)}
                    </p>
                  </td>
                  <td>
                    <StatusBadge status={badgeStatus(w)} />
                    {w.lastRun ? (
                      <span className="wf-table__status">
                        {RUN_STATUS_LABELS[w.lastRun.status] ?? w.lastRun.status}
                        {w.lastRun.failedNodeLabel ? ` · ${w.lastRun.failedNodeLabel}` : ''}
                      </span>
                    ) : null}
                  </td>
                  <td className="wf-table__muted">
                    {w.lastRun
                      ? `${formatTime(w.lastRun.startedAt)}${
                          w.lastRun.durationMs === undefined
                            ? ''
                            : ` · ${formatDuration(w.lastRun.durationMs)}`
                        }`
                      : '未运行'}
                  </td>
                  <td>
                    {w.latestVersion === undefined ? (
                      <Tag tone="outline">草稿</Tag>
                    ) : (
                      <Tag tone="outline">v{w.lastRun?.version ?? w.latestVersion}</Tag>
                    )}
                    <span className="wf-table__muted"> · 手动</span>
                  </td>
                  <td className="wf-table__actions">
                    {/* 图纸里失败那行的行尾图标就是重试，其余是运行 */}
                    {w.lastRun?.status === 'failed' ? (
                      <button
                        type="button"
                        aria-label={`重试 ${w.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/runs?run=${w.lastRun?.id ?? ''}`);
                        }}
                      >
                        <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`运行 ${w.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/editor/${w.id}`);
                        }}
                      >
                        <i className="ph ph-play" aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && filtered ? (
                <tr>
                  <td colSpan={5} className="wf-table__empty">
                    当前筛选下没有工作流
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        setFilter('全部');
                        search.onChange('');
                        // 条件也要清到后端 —— 只改前端 state 的话
                        // 列表还是筛过的那一页
                        void setServerFilter(null, '');
                      }}
                    >
                      清除筛选
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {/* 1292 条一次铺满的话，用户关心的那几条淹在里面 */}
        <Pager
          total={total}
          pageSize={LIST_PAGE_SIZE}
          offset={offset}
          onChange={(next) => void load(next)}
          sticky
        />
      </section>
    </article>
  );
}

/** 图纸写的是「1.24M」。缺席表示还没有数据源，显示「—」而不是 0。 */
function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

/** 图纸写的是「4m18s」「48s」「12m05s」。 */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * 状态徽章的取值。没跑过的是「已创建」，跑过的跟着运行走。
 *
 * 返回类型写成 RunStatusName 而不是 string：契约的 RUN_STATUSES 与
 * StatusBadge 认识的集合必须是同一个，写 string 的话新增一个状态时
 * 徽章会在运行时读 undefined.shape 崩掉整页 —— 已经这么栽过一次
 * （引擎写 waiting_approval，我在统计里手打成 awaiting_approval）。
 */
function badgeStatus(workflow: Workflow): RunStatusName {
  return workflow.lastRun?.status ?? 'created';
}

/**
 * 统计卡。图纸里第一张的数字用强调色、第二张的副文本用成功色。
 * value / note 缺省时数值位保持图纸的高度，不塌陷、不填占位符。
 */
function Stat({
  label,
  value,
  note,
  accent,
  noteTone,
}: {
  label: string;
  value?: string;
  note?: string;
  accent?: boolean;
  noteTone?: 'success';
}) {
  return (
    <div className="stat" role="group" aria-label={label}>
      <p className="stat__label">{label}</p>
      <p className="stat__value" data-accent={accent ? 'true' : undefined}>
        <span className="stat__number">{value ?? ''}</span>
        <span className="stat__note" data-tone={noteTone}>
          {note ?? ''}
        </span>
      </p>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}
