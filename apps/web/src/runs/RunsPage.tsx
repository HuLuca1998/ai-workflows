import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type RunStatusName, StatusBadge } from '@aiwf/ui';
import { coreClient } from '../data/workspace.js';
import { type RunEvent, type RunFilter, type RunSummary, useRuns } from './runsStore.js';

/**
 * 执行记录 —— 严格照图纸「03 执行记录」。
 *
 * 三栏：308px 运行列表 · 232px 节点进度 · 详情。栏宽、小标题字距、
 * 底部常驻说明都取自图纸。
 *
 * 数据没到位的地方**留空并说明**：产物与对话两个 tab 的内容分别依赖
 * 产物存储与 ACP（M3），现在放空态文案，不放演示内容。
 */

const FILTERS: { key: RunFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'waiting_approval', label: '待审批' },
  { key: 'failed', label: '失败' },
];

type DetailTab = 'events' | 'artifacts' | 'conversation';

const TABS: { key: DetailTab; label: string }[] = [
  { key: 'events', label: '事件流' },
  { key: 'artifacts', label: '产物' },
  { key: 'conversation', label: '对话' },
];

/** 运行中的记录要跟着刷新，停下的不必轮询。 */
const POLL_MS = 1200;

export function RunsPage() {
  const runs = useRuns();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<DetailTab>('events');
  const { active, past } = runs.grouped();
  const selected = runs.selected();
  const progress = runs.progress();

  // 从编辑器点「运行」过来时带着 ?run=，直接展开那一次运行
  const requested = params.get('run');
  useEffect(() => {
    void useRuns
      .getState()
      .load()
      .then(() => {
        if (requested) void useRuns.getState().select(requested);
      });
  }, [requested]);

  const live = selected !== null && isActive(selected.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void useRuns.getState().pollEvents();
      void useRuns.getState().load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, selected?.id]);

  return (
    <div className="runs">
      <aside className="runs__list">
        <div className="runs__list-head">
          <div className="runs__list-title">
            <span className="runs__label">运行记录</span>
            <span className="runs__grow" />
            <button
              type="button"
              className="runs__icon"
              aria-label="刷新"
              onClick={() => void runs.load()}
            >
              <i className="ph ph-arrows-clockwise" aria-hidden="true" />
            </button>
          </div>

          <label className="runs__search">
            <i className="ph ph-magnifying-glass" aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索工作流、参数或 Run ID"
              value={runs.query}
              onChange={(event) => runs.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runs.load();
              }}
            />
          </label>

          <div className="runs__filters" role="group" aria-label="筛选运行">
            {FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className="runs__chip"
                data-active={runs.filter === filter.key ? 'true' : undefined}
                onClick={() => void runs.setFilter(filter.key)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <div className="runs__list-body">
          {runs.error ? (
            <p className="runs__error" role="status">
              {runs.error}
            </p>
          ) : null}

          {runs.items.length === 0 ? (
            <p className="runs__empty">
              还没有运行记录。在工作流编辑器里点「运行」后，每一次执行都会出现在这里。
            </p>
          ) : null}

          {active.length > 0 ? (
            <p className="runs__group runs__group--live">
              <span className="runs__dot" aria-hidden="true" />
              并行进行中 · {active.length}
            </p>
          ) : null}
          {active.map((run) => (
            <RunItem
              key={run.id}
              run={run}
              selected={run.id === runs.selectedId}
              onSelect={() => void runs.select(run.id)}
            />
          ))}

          {past.length > 0 ? <p className="runs__group">历史 · {past.length}</p> : null}
          {past.map((run) => (
            <RunItem
              key={run.id}
              run={run}
              selected={run.id === runs.selectedId}
              onSelect={() => void runs.select(run.id)}
            />
          ))}
        </div>

        <p className="runs__foot">
          <i className="ph ph-stack" aria-hidden="true" />
          同一工作流可用不同参数并行运行，环境快照互不影响
        </p>
      </aside>

      <section className="runs__nodes" aria-label="节点进度">
        <div className="runs__nodes-head">
          <span className="runs__label">节点进度</span>
          {selected ? (
            <>
              <div className="runs__bar">
                <div className="runs__bar-fill" style={{ width: barWidth(progress.done) }} />
              </div>
              <p className="runs__nodes-meta">
                <span>{progress.done} 个节点已完成</span>
              </p>
              {progress.current ? <p className="runs__nodes-cur">{progress.current}</p> : null}
            </>
          ) : null}
        </div>

        <div className="runs__nodes-body">
          {selected ? (
            nodeRows(runs.events).map((row) => (
              <div key={row.nodeId} className="runs__node" data-state={row.state}>
                <i className={`ph ${nodeIcon(row.state)}`} aria-hidden="true" />
                <div className="runs__node-main">
                  <span className="runs__node-title">{row.nodeId}</span>
                  <span className="runs__node-sub">{row.summary}</span>
                </div>
                <span className="runs__node-state">{stateLabel(row.state)}</span>
              </div>
            ))
          ) : (
            <p className="runs__empty">运行的节点会在这里逐个亮起。</p>
          )}
        </div>
      </section>

      <section className="runs__detail" aria-label="运行详情">
        {selected ? (
          <>
            <header className="runs__detail-head">
              <div className="runs__detail-title">
                <h4>{selected.workflowName}</h4>
                <StatusBadge status={runStatus(selected.status)} />
                <span className="runs__grow" />
                {isActive(selected.status) ? (
                  <button
                    type="button"
                    className="runs__action"
                    onClick={() => void runs.cancel(selected.id)}
                  >
                    取消运行
                  </button>
                ) : null}
              </div>

              <div className="runs__params">
                <span className="runs__params-label">启动参数</span>
                {Object.entries(selected.inputs).map(([key, value]) => (
                  <span key={key} className="runs__param">
                    {key}={String(value)}
                  </span>
                ))}
              </div>

              <div className="runs__meta">
                <span>
                  <i className="ph ph-clock" aria-hidden="true" />
                  {formatTime(selected.startedAt)}
                </span>
                <span>
                  <i className="ph ph-hash" aria-hidden="true" />
                  {selected.id}
                </span>
                {selected.workdir ? (
                  <span>
                    <i className="ph ph-folder-open" aria-hidden="true" />
                    {selected.workdir}
                  </span>
                ) : null}
              </div>
            </header>

            {progress.failed ? (
              <div className="runs__failed" role="alert">
                <p className="runs__failed-title">
                  <i className="ph-fill ph-x-circle" aria-hidden="true" />
                  <span>节点「{failedNodeLabel(runs.events, progress.failed)}」失败</span>
                  <span className="runs__grow" />
                  <span className="runs__failed-meta">
                    {attemptOf(runs.events, progress.failed)}
                    {/* 两头都得有：排队中被取消的运行没有 startedAt，
                        那时算出来的「时长」会是从 1970 年起 */}
                    {selected.startedAt && selected.endedAt
                      ? ` · ${formatDuration(selected.startedAt, selected.endedAt)}`
                      : ''}
                  </span>
                </p>
                <p className="runs__failed-body">{failureDetail(runs.events, progress.failed)}</p>
                <div className="runs__failed-actions">
                  {/* 「从失败节点重试」就是 run.resume：引擎从事件流算出
                      哪些节点已完成，只从没完成的往下推 —— 成功的不会重跑 */}
                  <button
                    type="button"
                    className="runs__action runs__action--primary"
                    onClick={() => void runs.resume(selected.id)}
                  >
                    <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />
                    从失败节点重试
                  </button>
                  {/* 重跑是一次**全新的运行**：原来那条留在记录里，
                      两次的事件流可以对照着看，这正是可解释性要的 */}
                  <button
                    type="button"
                    className="runs__action"
                    onClick={() => void runs.rerun(selected.id)}
                  >
                    用相同参数重跑
                  </button>
                </div>
              </div>
            ) : null}

            {selected.status === 'waiting_approval' ? (
              <ApprovalPanel
                nodeId={pendingApprovalNode(runs.events) ?? ''}
                summary={pendingApprovalSummary(runs.events)}
                onDecide={(decision) =>
                  void runs.decide(pendingApprovalNode(runs.events) ?? '', decision)
                }
              />
            ) : null}

            <div className="runs__tabs" role="tablist" aria-label="运行详情视图">
              {TABS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.key}
                  className="runs__tab"
                  onClick={() => setTab(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
              <span className="runs__grow" />
              <span className="runs__evcount">{runs.events.length} 条事件</span>
            </div>

            <div className="runs__detail-body">
              {tab === 'events' ? <EventList events={runs.events} /> : null}
              {tab === 'artifacts' ? <ArtifactList runId={selected.id} /> : null}
              {tab === 'conversation' ? (
                <p className="runs__empty">
                  对话视图要等 AI 节点接上 ACP（M3）。现在这次运行还没有 AI 消息。
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <p className="runs__empty runs__empty--center">选一次运行，这里会显示它的完整记录。</p>
        )}
      </section>
    </div>
  );
}

function RunItem({
  run,
  selected,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const params = Object.entries(run.inputs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');

  return (
    <button
      type="button"
      className="runs__item"
      data-selected={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="runs__item-row">
        <span className="runs__item-name">{run.workflowName}</span>
        <StatusBadge status={runStatus(run.status)} />
      </span>
      {params ? <span className="runs__item-params">{params}</span> : null}
      <span className="runs__item-foot">
        <span className="runs__item-node">{run.currentNode ?? ''}</span>
        <span>{formatTime(run.startedAt)}</span>
      </span>
    </button>
  );
}

function EventList({ events }: { events: readonly RunEvent[] }) {
  return (
    <>
      {events.length === 0 ? <p className="runs__empty">这次运行还没有事件。</p> : null}
      <ul className="runs__events">
        {events.map((event) => (
          <li key={event.id} className="runs__event" data-kind={category(event.type)}>
            <span className="runs__event-rail" aria-hidden="true" />
            <span className="runs__event-head">
              <span className="runs__event-time">{formatClock(event.ts)}</span>
              <span className="runs__event-cat">{category(event.type)}</span>
              <span className="runs__event-type">{event.type}</span>
              {event.nodeId ? <span className="runs__event-node">{event.nodeId}</span> : null}
            </span>
            <span className="runs__event-title">{event.summary}</span>
          </li>
        ))}
      </ul>
      <p className="runs__redact">
        <i className="ph ph-shield-check" aria-hidden="true" />
        Secret 值在写入事件存储前已脱敏，界面不提供绕过查看
      </p>
    </>
  );
}

interface Artifact {
  nodeId: string;
  kind: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

function ArtifactList({ runId }: { runId: string }) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void coreClient
      .call('run.artifacts', { runId })
      .then((result) => {
        if (cancelled) return;
        const page = result as { items: Artifact[]; root: string };
        setItems(page.items);
        setRoot(page.root);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return (
      <p className="runs__empty" role="alert">
        {error}
      </p>
    );
  }
  if (items === null) return <p className="runs__empty">正在读取产物…</p>;

  return (
    <>
      {items.length === 0 ? (
        <p className="runs__empty">这次运行还没有产物。脚本的输出与生成的文件会出现在这里。</p>
      ) : (
        <ul className="runs__artifacts">
          {items.map((item) => (
            <li key={item.path} className="runs__artifact">
              <i className={`ph ${artifactIcon(item.kind)}`} aria-hidden="true" />
              <span className="runs__artifact-main">
                <span className="runs__artifact-name">{item.name}</span>
                <span className="runs__artifact-meta">
                  {formatBytes(item.bytes)} · {item.nodeId}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {root ? (
        <p className="runs__redact">
          <i className="ph ph-folder-open" aria-hidden="true" />
          {root}
        </p>
      ) : null}
    </>
  );
}

function artifactIcon(kind: string): string {
  switch (kind) {
    case 'diff':
      return 'ph-file-diff';
    case 'report':
      return 'ph-file-text';
    case 'log':
      return 'ph-terminal-window';
    default:
      return 'ph-file';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ApprovalPanel({
  nodeId,
  summary,
  onDecide,
}: {
  nodeId: string;
  summary: string;
  onDecide: (decision: string) => void;
}) {
  return (
    <div className="runs__approval">
      <p className="runs__approval-title">
        <i className="ph ph-hand-palm" aria-hidden="true" />
        审批 · {summary || nodeId}
      </p>
      <div className="runs__approval-actions">
        <button
          type="button"
          className="runs__action runs__action--primary"
          onClick={() => onDecide('approved')}
        >
          批准
        </button>
        <button type="button" className="runs__action" onClick={() => onDecide('rejected')}>
          拒绝
        </button>
      </div>
    </div>
  );
}

// ── 从事件推出界面需要的东西 ───────────────────────────────────────────────

type NodeState = 'succeeded' | 'failed' | 'running' | 'waiting';

interface NodeRow {
  nodeId: string;
  state: NodeState;
  summary: string;
}

/** 节点列表按事件里第一次出现的顺序排，与实际执行顺序一致。 */
function nodeRows(events: readonly RunEvent[]): NodeRow[] {
  const rows = new Map<string, NodeRow>();
  for (const event of events) {
    if (!event.nodeId) continue;
    const state = stateOf(event.type);
    if (!state) continue;
    rows.set(event.nodeId, { nodeId: event.nodeId, state, summary: event.summary });
  }
  return [...rows.values()];
}

function stateOf(kind: string): NodeState | null {
  switch (kind) {
    case 'node.started':
      return 'running';
    case 'node.succeeded':
      return 'succeeded';
    case 'node.failed':
      return 'failed';
    case 'node.waiting':
    case 'approval.requested':
      return 'waiting';
    default:
      return null;
  }
}

function pendingApprovalNode(events: readonly RunEvent[]): string | null {
  // 从后往前找：最近一次请求还没被决定的那个
  const decided = new Set(
    events.filter((e) => e.type === 'approval.decided').map((e) => e.nodeId ?? ''),
  );
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'approval.requested' && event.nodeId && !decided.has(event.nodeId)) {
      return event.nodeId;
    }
  }
  return null;
}

function pendingApprovalSummary(events: readonly RunEvent[]): string {
  const node = pendingApprovalNode(events);
  if (!node) return '';
  const request = [...events]
    .reverse()
    .find((e) => e.type === 'approval.requested' && e.nodeId === node);
  return request?.summary ?? node;
}

/**
 * 失败节点的标题。
 *
 * 事件里记着节点**当时**的名字，草稿改名不影响历史。
 * 老事件没有 nodeLabel（那个字段是后加的），退回 id ——
 * 显示一个 id 也好过什么都不显示。
 */
function failedNodeLabel(events: readonly RunEvent[], nodeId: string): string {
  const labeled = [...events].reverse().find((e) => e.nodeId === nodeId && e.nodeLabel);
  return labeled?.nodeLabel ?? nodeId;
}

/** 图纸写的是「attempt 2 / 2」。只有一次尝试时也照样写出来。 */
function attemptOf(events: readonly RunEvent[], nodeId: string): string {
  const failure = [...events]
    .reverse()
    .find((e) => e.type === 'node.failed' && e.nodeId === nodeId);
  return failure?.attempt === undefined ? '' : `attempt ${failure.attempt}`;
}

/** 图纸写的是「48s」「4m18s」。 */
function formatDuration(started: string, ended: string): string {
  const ms = new Date(ended).getTime() - new Date(started).getTime();
  if (Number.isNaN(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function failureDetail(events: readonly RunEvent[], nodeId: string): string {
  const failure = [...events]
    .reverse()
    .find((e) => e.type === 'node.failed' && e.nodeId === nodeId);
  return failure?.summary ?? '';
}

const ACTIVE = new Set(['created', 'queued', 'running', 'waiting_approval']);
function isActive(status: string): boolean {
  return ACTIVE.has(status);
}

/** 图纸里进度条按完成节点数填充；总数要等图加载后才知道，先按 10 段刻度。 */
function barWidth(done: number): string {
  return `${Math.min(100, done * 10)}%`;
}

function nodeIcon(state: NodeState): string {
  switch (state) {
    case 'succeeded':
      return 'ph-check-circle';
    case 'failed':
      return 'ph-x-circle';
    case 'waiting':
      return 'ph-hand-palm';
    default:
      return 'ph-circle-dashed';
  }
}

function stateLabel(state: NodeState): string {
  switch (state) {
    case 'succeeded':
      return '完成';
    case 'failed':
      return '失败';
    case 'waiting':
      return '待审批';
    default:
      return '执行中';
  }
}

/** 状态文案只在 StatusBadge 里定义一处；这里只做安全窄化。 */
const KNOWN_STATUSES = new Set<string>([
  'created',
  'preflight',
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'interrupted',
  'resuming',
  'succeeded',
  'failed',
  'cancelled',
]);

function runStatus(status: string): RunStatusName {
  return KNOWN_STATUSES.has(status) ? (status as RunStatusName) : 'created';
}

/** 事件类别：图纸的事件卡左侧色条按类别着色。 */
function category(kind: string): string {
  if (kind.startsWith('approval')) return '审批';
  if (kind.startsWith('node')) return '节点';
  if (kind.startsWith('ai')) return 'AI';
  return '运行';
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', { hour12: false });
}
