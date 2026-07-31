import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { LIST_PAGE_SIZE, isRunResumable, isRunTerminal, type RunStatus } from '@aiwf/contracts';
import { formatBytes } from '../data/format.js';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { useSearchParams } from 'react-router';
import { useAsyncAction } from '../data/useAsyncAction.js';
import { type RunStatusName, StatusBadge } from '@aiwf/ui';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';
import { ConversationView } from './ConversationView.js';
import { NodeDetail } from './NodeDetail.js';
import { type RunEvent, type RunFilter, type RunSummary, useRuns } from './runsStore.js';
import { toneOfEvent } from './eventTone.js';
import { relativeTime, runDuration } from './formatTime.js';
import { CopyButton } from '../layout/CopyButton.js';

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

/** 事件流一次铺多少条。见 EventList 里的说明。 */
const EVENT_WINDOW = 200;

export function RunsPage() {
  const runs = useRuns();
  const search = useDebouncedSearch((query) => {
    runs.setQuery(query);
    void runs.load();
  });
  const [params] = useSearchParams();
  // 失败页那三个入口都会真的起一条运行 —— 后端 run.start 不幂等，
  // 连点两次就是两条运行、两个执行线程、同一个 workdir
  const resuming = useAsyncAction();
  const rewinding = useAsyncAction();
  const rerunning = useAsyncAction();
  /* 取消运行不可撤销，且后端不幂等（连点两次就是两条命令）—— 要中间态 + 确认 */
  const cancelling = useAsyncAction();
  /*
   * 存的是「正在确认哪一条运行」而不是布尔：布尔会跨运行残留 ——
   * 在 A 上点出确认态、切到 B，按钮还停在「确认取消运行」，
   * 用户在 B 上点的第一下就直接把 B 杀了。
   */
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  // tab 从 URL 读一次初值：审批横幅的「查看 Diff」带着 &tab=artifacts 过来，
  // 而在此之前这里是个纯 useState —— 那个参数一路没人读，
  // 用户点「查看 Diff」落到的是事件流
  const [tab, setTab] = useState<DetailTab>(() => {
    const wanted = params.get('tab');
    return TABS.some((entry) => entry.key === wanted) ? (wanted as DetailTab) : 'events';
  });
  /**
   * 从对话里点「全文」要跳到产物 tab 并展开那一条。
   *
   * 只传路径不传「打开过了没有」：展开状态归 ArtifactList 自己管，
   * 这里只说「进来的时候先展开这条」。
   */
  const [jumpToArtifact, setJumpToArtifact] = useState<string | null>(null);
  /** 刚导出的诊断包路径。不告诉用户在哪的话他找不到。 */
  /*
   * 诊断包结果带着**是哪条运行**的 id。
   *
   * 两个毛病一起治：此前它是页面级的匿名值，导出 A 之后切到 B，那行路径
   * 挂在 B 的详情下；而反馈整块又长在失败横幅内部 —— 成功的运行导出成功
   * 也什么都不显示。
   */
  const [diagnostics, setDiagnostics] = useState<{ runId: string; path: string } | null>(null);
  /** 选中的节点；null 表示看整条运行。图纸的节点进度栏每行都可点。 */
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [exportError, setExportError] = useState<{ runId: string; message: string } | null>(null);
  /* 每点一次后端真出一个包 —— 无中间态时用户等不到反馈就会再点 */
  const exporting = useAsyncAction();

  const exportDiagnostics = async (runId: string) => {
    setDiagnostics(null);
    setExportError(null);
    try {
      const result = (await coreClient.call('run.diagnostics', { runId })) as { path: string };
      setDiagnostics({ runId, path: result.path });
    } catch (err) {
      setExportError({ runId, message: err instanceof Error ? err.message : String(err) });
    }
  };
  /*
   * 相对时间要自己走。活跃运行靠 1.2s 轮询顺带重渲染，历史运行不轮询 ——
   * 不给一个时钟的话，「3 分钟前」会一直停在打开页面那一刻。
   * 30s 一跳：显示精度到分钟，再密就是白烧渲染。
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /*
   * 事件派生值算一次就够。
   *
   * `pendingApprovalNode(runs.events)` 在同一次渲染里被调用四次，每次都
   * 完整遍历事件数组并建一个 Set；`nodeRows` 也是每次渲染遍历一遍。
   * 事件上限是 5000 条，而这一屏还挂着 1.2 秒一次的轮询 ——
   * 每次轮询都要把这几遍重跑。
   */
  const events = runs.events;
  const approvalNode = useMemo(() => pendingApprovalNode(events), [events]);
  const approvalSummary = useMemo(() => pendingApprovalSummary(events), [events]);
  const rows = useMemo(() => nodeRows(events), [events]);

  const { active, past } = runs.grouped();
  const selected = runs.selected();
  const progress = runs.progress();
  // 进度的分母用版本图里真实的节点数。之前写死「10 段刻度」，
  // 于是 3 个节点跑完只填 30%、20 个节点跑到第 10 个就满格 —— 报的是错的完成度。
  const nodeTotal = Object.keys(runs.nodeTypes).length;

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
            {/* 输入即搜（300ms 防抖），回车立刻搜。
                与首页同一套交互 —— 不一致的话用户每换一屏都要重新试一次 */}
            <input
              type="search"
              placeholder="搜索工作流、参数或 Run ID"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') search.onEnter();
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
              now={now}
            />
          ))}

          {past.length > 0 ? <p className="runs__group">历史 · {past.length}</p> : null}
          {past.map((run) => (
            <RunItem
              key={run.id}
              run={run}
              selected={run.id === runs.selectedId}
              onSelect={() => void runs.select(run.id)}
              now={now}
            />
          ))}
        </div>

        {/* 508 条运行一次铺满的话，用户要找的那次淹在里面 */}
        <Pager
          total={runs.total}
          pageSize={LIST_PAGE_SIZE}
          offset={runs.offset}
          onChange={(next) => void runs.setOffset(next)}
        />

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
              {nodeTotal > 0 ? (
                <div
                  className="runs__bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={nodeTotal}
                  aria-valuenow={progress.done}
                  aria-label="节点完成进度"
                >
                  <div
                    className="runs__bar-fill"
                    style={
                      { '--progress': progressRatio(progress.done, nodeTotal) } as CSSProperties
                    }
                  />
                </div>
              ) : null}
              <p className="runs__nodes-meta">
                <span>
                  {nodeTotal > 0
                    ? `${progress.done} / ${nodeTotal} 个节点已完成`
                    : `${progress.done} 个节点已完成`}
                </span>
              </p>
              {progress.current ? (
                <p className="runs__nodes-cur">{nodeLabelOf(runs.events, progress.current)}</p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="runs__nodes-body">
          {selected ? (
            rows.map((row) => (
              // 图纸每一行都带 onClick：选中之后详情区只看这个节点。
              // 一条 20 个节点的运行，不能点的话只能在事件流里自己数
              <button
                type="button"
                key={row.nodeId}
                className="runs__node"
                data-state={row.state}
                data-selected={selectedNode === row.nodeId ? 'true' : undefined}
                aria-pressed={selectedNode === row.nodeId}
                onClick={() =>
                  // 再点一次取消 —— 回到整条运行的视图
                  setSelectedNode((current) => (current === row.nodeId ? null : row.nodeId))
                }
              >
                <i className={`ph ${nodeIcon(row.state)}`} aria-hidden="true" />
                <div className="runs__node-main">
                  <span className="runs__node-title">{row.label}</span>
                  <span className="runs__node-sub">{row.summary}</span>
                </div>
                <span className="runs__node-state">{stateLabel(row.state)}</span>
              </button>
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
                {/*
                 * 可恢复的运行（interrupted / paused）此前一个可点的按钮都没有：
                 * 「取消运行」只对活跃态显示、「从失败节点重试」只长在失败横幅上，
                 * 而契约导出的 isRunResumable 在整个前端零引用 ——
                 * 用户杀掉 App 之后只能重新填一遍参数跑。
                 */}
                {isRunResumable(selected.status as RunStatus) ? (
                  <button
                    type="button"
                    className="runs__action runs__action--primary"
                    disabled={resuming.isRunning(selected.id)}
                    onClick={() => resuming.run(() => runs.resume(selected.id), selected.id)}
                  >
                    {resuming.isRunning(selected.id) ? '恢复中…' : '恢复运行'}
                  </button>
                ) : null}
                {/*
                 * 重跑与导出诊断包此前只长在失败横幅里 —— 一次「成功但结果不对」
                 * 的运行想换参数再跑或把证据发给别人，界面上没有任何入口。
                 */}
                {isRunTerminal(selected.status as RunStatus) ? (
                  <button
                    type="button"
                    className="runs__action"
                    disabled={rerunning.isRunning(selected.id)}
                    onClick={() => rerunning.run(() => runs.rerun(selected.id), selected.id)}
                  >
                    {rerunning.isRunning(selected.id) ? '启动中…' : '用相同参数重跑'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="runs__action"
                  disabled={exporting.isRunning(selected.id)}
                  onClick={() => exporting.run(() => exportDiagnostics(selected.id), selected.id)}
                >
                  {exporting.isRunning(selected.id) ? '导出中…' : '导出诊断包'}
                </button>
                {isActive(selected.status) ? (
                  <button
                    type="button"
                    className="runs__action"
                    disabled={cancelling.isRunning(selected.id)}
                    onClick={() => {
                      // 取消会杀掉一条正在跑的运行 —— 不可撤销，要确认。
                      // 而且后端不幂等，连点两次就是两条命令。
                      if (confirmCancel !== selected.id) {
                        setConfirmCancel(selected.id);
                        return;
                      }
                      setConfirmCancel(null);
                      cancelling.run(() => runs.cancel(selected.id), selected.id);
                    }}
                    data-danger={confirmCancel === selected.id ? 'true' : undefined}
                  >
                    {cancelling.isRunning(selected.id)
                      ? '取消中…'
                      : confirmCancel === selected.id
                        ? '确认取消运行'
                        : '取消运行'}
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
                    <CopyButton
                      value={selected.workdir}
                      label=""
                      className="runs__inline-copy"
                      ariaLabel="复制工作目录路径"
                    />
                  </span>
                ) : null}
              </div>
            </header>

            {progress.failed ? (
              <div className="runs__failed" role="alert">
                <p className="runs__failed-title">
                  <i className="ph-fill ph-x-circle" aria-hidden="true" />
                  <span>节点「{nodeLabelOf(runs.events, progress.failed)}」失败</span>
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
                    disabled={resuming.isRunning(selected.id)}
                    onClick={() => resuming.run(() => runs.resume(selected.id), selected.id)}
                  >
                    <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />
                    从失败节点重试
                  </button>
                  {/* 审批那一步选错了、后面才发现时走这条：
                      重试会沿用同一个决定，重跑又把前面的工作全丢掉 */}
                  <button
                    type="button"
                    className="runs__action"
                    disabled={rewinding.isRunning(selected.id)}
                    onClick={() =>
                      rewinding.run(() => runs.rewindToApproval(selected.id), selected.id)
                    }
                  >
                    回到最近审批点改选择
                  </button>
                  {/*
                   * 「用相同参数重跑」与「导出诊断包」已经提到详情头那一行 ——
                   * 它们对任何一次运行都有意义（成功但结果不对同样想重跑、
                   * 想把证据发给别人），不该只在失败时才出现。
                   * 横幅里只留失败专属的两个：从失败节点重试、回到审批点。
                   */}
                </div>
              </div>
            ) : null}

            {/*
             * 导出反馈在失败横幅**外面**：任何一次运行都能导出诊断包
             * （成功但结果不对同样想把证据发给别人），而它此前长在
             * `progress.failed` 那一块里 —— 成功的运行导出成功也什么都不显示。
             */}
            {exportError?.runId === selected.id ? (
              <p className="runs__error" role="alert">
                {exportError.message}
              </p>
            ) : null}
            {diagnostics?.runId === selected.id ? (
              <p className="runs__diagnostics" role="status">
                <i className="ph ph-file-arrow-down" aria-hidden="true" />
                已导出到 {diagnostics.path}
                <CopyButton
                  value={diagnostics.path}
                  label=""
                  className="runs__inline-copy"
                  ariaLabel="复制诊断包路径"
                />
                {/* 用户要把它发给别人，得知道能不能发 */}
                <span className="runs__diagnostics-note">
                  · 内容已过脱敏器，Secret 只以 keychain:// 引用出现
                </span>
              </p>
            ) : null}

            {selected.status === 'waiting_approval' ? (
              <ApprovalPanel
                /*
                 * key 让面板跟着「哪条运行的哪个节点」重挂 ——
                 * 里面的「确认拒绝」是组件内状态，不重挂就会跨审批残留：
                 * 在上一条审批点出确认态、切到下一条，第一下就直接拒了。
                 */
                key={`${selected.id}:${approvalNode ?? ''}`}
                nodeId={approvalNode ?? ''}
                summary={approvalSummary}
                onDecide={(decision) => runs.decide(approvalNode ?? '', decision)}
              />
            ) : null}

            <div className="runs__tabs" role="tablist" aria-label="运行详情视图">
              {TABS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  id={`runs-tab-${entry.key}`}
                  aria-selected={tab === entry.key}
                  aria-controls="runs-panel"
                  // roving tabindex：未选中的退出 Tab 序列，键盘用左右键切换
                  tabIndex={tab === entry.key ? 0 : -1}
                  className="runs__tab"
                  onClick={() => setTab(entry.key)}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                    if (delta === 0) return;
                    event.preventDefault();
                    const keys = TABS.map((t) => t.key);
                    const index = keys.indexOf(entry.key); // 从焦点所在的按钮出发，不是从当前选中项 ——
                    // roving tabindex 下焦点与选中经常不在同一项
                    const next = keys[(index + delta + keys.length) % keys.length];
                    if (next) {
                      setTab(next);
                      document.getElementById(`runs-tab-${next}`)?.focus();
                    }
                  }}
                >
                  {entry.label}
                </button>
              ))}
              <span className="runs__grow" />
              <span className="runs__evcount">{runs.events.length} 条事件</span>
            </div>

            <div
              className="runs__detail-body"
              id="runs-panel"
              role="tabpanel"
              aria-labelledby={`runs-tab-${tab}`}
            >
              {tab === 'events' ? (
                selectedNode ? (
                  // 选中一个节点时给它的**专属视图**：脚本看命令与退出码、
                  // AI 看对话、worktree 看分支。同一张按时间排的事件表
                  // 等于让用户自己去认哪几行有用 —— 一次 AI 分析有几十条
                  // 工具调用，结论那一条淹在中间
                  <NodeDetail
                    nodeId={selectedNode}
                    nodeType={runs.nodeTypes[selectedNode] ?? ''}
                    nodeLabel={nodeLabelOf(runs.events, selectedNode)}
                    events={runs.events.filter((event) => event.nodeId === selectedNode)}
                    {...(selected ? { runId: selected.id } : {})}
                    /* 这个节点开始了、还没结束 = 正在跑。
                       只有这时才收实时帧 —— 跑完之后那段话已经落库成
                       conversation.agent_message，再显示残留的帧会重复一次 */
                    running={
                      selected?.status === 'running' && nodeIsRunning(runs.events, selectedNode)
                    }
                    onOpenArtifact={(relPath) => {
                      setJumpToArtifact(relPath);
                      setTab('artifacts');
                    }}
                  />
                ) : (
                  <EventList
                    events={runs.events}
                    loading={runs.loading}
                    truncated={runs.truncated}
                  />
                )
              ) : null}
              {tab === 'artifacts' ? (
                <ArtifactList runId={selected.id} openInitially={jumpToArtifact} />
              ) : null}
              {tab === 'conversation' ? (
                <ConversationView
                  events={runs.events}
                  // 「有没有 AI 节点」从事件流推：图这一层这里拿不到，
                  // 而 system.model_resolved 只有 AI 节点会写
                  hasAiNode={runs.events.some((event) => event.type === 'system.model_resolved')}
                  onOpenArtifact={(relPath) => {
                    setJumpToArtifact(relPath);
                    setTab('artifacts');
                  }}
                />
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
  now,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
  /** 由页面统一给一个时刻，避免每行各取一次 Date.now() 导致同屏时间不一致 */
  now: number;
}) {
  const params = Object.entries(run.inputs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
  const duration = runDuration(run.startedAt, run.endedAt, now);

  return (
    <button
      type="button"
      className="runs__item"
      data-selected={selected ? 'true' : undefined}
      // 状态挂在元素上：e2e 要挑一条「跑完了因而必然有事件」的运行，
      // 按顺序取第一条的话，刚创建还没跑的那条会让断言落空
      data-status={run.status}
      onClick={onSelect}
    >
      <span className="runs__item-row">
        <span className="runs__item-name">{run.workflowName}</span>
        <StatusBadge status={runStatus(run.status)} />
      </span>
      {params ? <span className="runs__item-params">{params}</span> : null}
      <span className="runs__item-foot">
        <span className="runs__item-node">{run.currentNode ?? ''}</span>
        {/*
         * 绝对时刻回答不了「刚才那条是哪个」「这条跑了多久」——
         * 在 20 条运行里找刚起的那条，只能逐条读年月日时分秒。
         * 超过一天的相对时间没意义，那时退回绝对日期。
         */}
        <span title={formatTime(run.startedAt)}>
          {relativeTime(run.startedAt, now) || formatTime(run.startedAt)}
        </span>
        {duration ? <span className="runs__item-duration">· {duration}</span> : null}
      </span>
    </button>
  );
}

function EventList({
  events,
  loading,
  truncated,
}: {
  events: readonly RunEvent[];
  loading: boolean;
  truncated: boolean;
}) {
  /*
   * 一条 AI 密集的运行有几百条事件，而这一栏此前没有任何收窄的手段：
   * 「它在哪一步崩的」只能一行行往下读。
   */
  const [onlyProblems, setOnlyProblems] = useState(false);
  /**
   * 一次只铺这么多。
   *
   * 事件上限是 5000 条，全铺出来的话每 1.2 秒一次的轮询要让 5000 个 DOM
   * 节点参与一次 diff（规范 §8：超过 300 行要虚拟滚动）。
   * 「最近 N 条 + 加载更早」比虚拟滚动简单得多，而且它顺带回答了
   * 「我要看的通常是最后发生的事」。
   */
  const [windowSize, setWindowSize] = useState(EVENT_WINDOW);
  /** 「跳到失败处」标记的那一条。标记而不是滚动 —— 滚动在 jsdom 里也验证不了。 */
  const [jumpedId, setJumpedId] = useState<string | null>(null);

  // 最后一条出问题的事件。用最后一条：重试过的运行前面那些失败已经被覆盖了
  const lastProblem = [...events].reverse().find((event) => {
    const tone = toneOfEvent(event.type, event.summary);
    return tone === 'failed' || tone === 'warn';
  });

  const filtered = onlyProblems
    ? events.filter((event) => {
        const tone = toneOfEvent(event.type, event.summary);
        return tone === 'failed' || tone === 'warn';
      })
    : events;
  // 取**最近的**一段：截头不截尾
  const hidden = Math.max(0, filtered.length - windowSize);
  const shown = hidden > 0 ? filtered.slice(hidden) : filtered;

  return (
    <>
      {events.length > 0 ? (
        <div className="runs__event-tools">
          <button
            type="button"
            className="runs__action runs__action--small"
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems((on) => !on)}
          >
            <i className="ph ph-funnel" aria-hidden="true" />
            只看异常
          </button>
          {/* 没有异常时不显示 —— 点了没反应的按钮比没有更糟 */}
          {lastProblem ? (
            <button
              type="button"
              className="runs__action runs__action--small"
              onClick={() => setJumpedId(lastProblem.id)}
            >
              <i className="ph ph-crosshair" aria-hidden="true" />
              跳到失败处
            </button>
          ) : null}
        </div>
      ) : null}
      {/*
       * 「未加载」与「真的没有」必须分开说。
       *
       * select() 是先把 events 清成 [] 再去拉的，所以每点一条运行，
       * 右栏都会先闪一句「这次运行还没有事件」——一个错误的结论；
       * 后端慢一点这句话就停在屏幕上，用户会以为这条运行什么都没记。
       */}
      {events.length === 0 ? (
        <p className="runs__empty">{loading ? '正在读取事件…' : '这次运行还没有事件。'}</p>
      ) : null}
      {events.length > 0 && shown.length === 0 ? (
        <p className="runs__empty">这条运行没有异常事件。</p>
      ) : null}
      {hidden > 0 ? (
        <button
          type="button"
          className="runs__action runs__action--small runs__load-earlier"
          onClick={() => setWindowSize((size) => size + EVENT_WINDOW)}
        >
          <i className="ph ph-arrow-up" aria-hidden="true" />
          加载更早的 {hidden} 条
        </button>
      ) : null}
      <ul className="runs__events">
        {shown.map((event) => (
          <li
            key={event.id}
            className="runs__event"
            data-kind={category(event.type)}
            /*
             * 语气按结果分，不按前缀 —— 此前 node.failed 与 node.succeeded
             * 在同一条流里长得一模一样，几百条事件里找不出「哪一步崩的」。
             */
            data-tone={toneOfEvent(event.type, event.summary)}
            data-jumped={event.id === jumpedId ? 'true' : undefined}
            ref={
              event.id === jumpedId
                ? // 可选调用：jsdom 与老 WebView 里没有这个方法，
                  // 而「滚过去」失败不该把整条事件流一起炸掉
                  (el) => el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
                : undefined
            }
          >
            <span className="runs__event-rail" aria-hidden="true" />
            <span className="runs__event-head">
              {/* seq 是这条事件的唯一号码：报问题时要引用「第几条」 */}
              <span className="runs__event-seq">#{event.seq}</span>
              <span className="runs__event-time">{formatClock(event.ts)}</span>
              <span className="runs__event-cat">{category(event.type)}</span>
              <span className="runs__event-type">{event.type}</span>
              {event.nodeId ? (
                // 同上：显示标题，没有才退回 id
                <span className="runs__event-node">{event.nodeLabel ?? event.nodeId}</span>
              ) : null}
            </span>
            <span className="runs__event-title">{event.summary}</span>
          </li>
        ))}
      </ul>
      {/*
       * store 里 truncated 存了、也测了，但界面从来没读过它 ——
       * 而 store 自己的注释写着「静默截断会让用户以为那就是全部」。
       * 超过上限的运行，用户看到的是被截断的一半，缺的恰好是「它最后怎么结束的」。
       */}
      {truncated ? (
        <p className="runs__error" role="status">
          <i className="ph ph-warning" aria-hidden="true" />
          事件太多，只显示了最近的一部分。完整记录请用「导出诊断包」。
        </p>
      ) : null}
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
  /** 磁盘上的绝对路径。图纸列表底部显示的是它的父目录。 */
  path: string;
  /** 相对运行目录的路径，预览接口收的就是它。 */
  relPath: string;
  bytes: number;
  sha256: string;
}

interface Preview {
  text?: string;
  binary: boolean;
  truncated: boolean;
  bytes: number;
}

function ArtifactList({
  runId,
  openInitially = null,
}: {
  runId: string;
  /** 进来时先展开哪一条（从对话里点「全文」跳过来的）。 */
  openInitially?: string | null;
}) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 展开中的那一条的相对路径。同时只展开一条 —— 图纸是就地展开，不是弹层。 */
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const togglePreview = async (relPath: string) => {
    if (openPath === relPath) {
      setOpenPath(null);
      setPreview(null);
      return;
    }

    setOpenPath(relPath);
    setPreview(null);
    setError(null);
    try {
      const result = (await coreClient.call('run.artifactContent', {
        runId,
        // 相对路径：绝对路径进了这个接口就等于任意文件读
        path: relPath,
      })) as Preview;
      setPreview(result);
    } catch (err) {
      setOpenPath(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 从对话跳过来时把那一条展开。放在 effect 里而不是初始 state：
  // 用户在产物 tab 里点开了别的，再切回对话又切回来，不该被强行拉回去
  useEffect(() => {
    if (openInitially) void togglePreview(openInitially);
    // togglePreview 每次渲染都是新函数，列进依赖会无限循环；
    // 这里要的就是「openInitially 变了才跑一次」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openInitially]);

  /*
   * 产物是边跑边产的，而这里此前只在挂载时拉一次 —— 用户看到的永远是
   * 打开那一刻的快照，后面产的一个都不出现，界面上还没有刷新入口。
   *
   * 不做自动轮询：产物接口要遍历运行目录，跑一条 AI 密集的运行时
   * 每 1.2 秒扫一遍磁盘不划算；给一个明确的刷新按钮就够了。
   */
  const [reloadKey, setReloadKey] = useState(0);
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
  }, [runId, reloadKey]);

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
      <div className="runs__artifacts-head">
        <button
          type="button"
          className="runs__action runs__action--small"
          onClick={() => setReloadKey((n) => n + 1)}
        >
          <i className="ph ph-arrows-clockwise" aria-hidden="true" />
          刷新产物
        </button>
      </div>
      {items.length === 0 ? (
        <p className="runs__empty">这次运行还没有产物。脚本的输出与生成的文件会出现在这里。</p>
      ) : (
        <ul className="runs__artifacts">
          {items.map((item) => (
            <li key={item.path} className="runs__artifact">
              <div className="runs__artifact-row">
                <i className={`ph ${artifactIcon(item.kind)}`} aria-hidden="true" />
                <span className="runs__artifact-main">
                  <span className="runs__artifact-name">{item.name}</span>
                  <span className="runs__artifact-meta">
                    {formatBytes(item.bytes)} · {item.nodeId}
                  </span>
                </span>
                <button
                  type="button"
                  className="runs__action"
                  aria-label={`预览 ${item.name}`}
                  aria-expanded={openPath === item.relPath}
                  onClick={() => void togglePreview(item.relPath)}
                >
                  预览
                </button>
              </div>

              {openPath === item.relPath ? (
                <div className="runs__artifact-preview">
                  {preview === null ? (
                    <p className="runs__empty">正在读取…</p>
                  ) : preview.binary ? (
                    // 显示一段乱码比不显示更糟 —— 用户会以为文件坏了
                    <p className="runs__empty">
                      这是二进制文件（{formatBytes(preview.bytes)}），没法在这里预览。
                    </p>
                  ) : (
                    <>
                      <pre>{preview.text}</pre>
                      {preview.truncated ? (
                        <p className="runs__artifact-truncated">
                          只显示了前一部分，完整内容共 {formatBytes(preview.bytes)}。
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {root ? (
        <p className="runs__redact">
          <i className="ph ph-folder-open" aria-hidden="true" />
          {root}
          {/* 这条路径用户要拿去终端里 cd 进去 —— 此前只能手选 */}
          <CopyButton value={root} label="复制路径" className="runs__inline-copy" />
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

function ApprovalPanel({
  nodeId,
  summary,
  onDecide,
}: {
  nodeId: string;
  summary: string;
  onDecide: (decision: string) => Promise<unknown>;
}) {
  /*
   * 两个按钮都要中间态：`approval.decide` 不幂等，而界面此前要等下一次
   * 1.2s 轮询才有反应 —— 中间用户会再点一次，于是发出两条决定。
   * 同一个文件里 resume/rewind/rerun 早就用上 useAsyncAction 了。
   */
  const deciding = useAsyncAction();
  /** 拒绝不可撤销，先确认再发（§5.4：危险操作只用红色文字 + 确认）。 */
  const [confirmReject, setConfirmReject] = useState(false);

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
          disabled={deciding.running}
          onClick={() => deciding.run(() => onDecide('approved'))}
        >
          {deciding.running ? '批准中…' : '批准'}
        </button>
        <button
          type="button"
          className="runs__action"
          disabled={deciding.running}
          data-danger={confirmReject ? 'true' : undefined}
          onClick={() => {
            if (!confirmReject) {
              setConfirmReject(true);
              return;
            }
            setConfirmReject(false);
            deciding.run(() => onDecide('rejected'));
          }}
        >
          {confirmReject ? '确认拒绝' : '拒绝'}
        </button>
      </div>
    </div>
  );
}

// ── 从事件推出界面需要的东西 ───────────────────────────────────────────────

type NodeState = 'succeeded' | 'failed' | 'running' | 'waiting';

interface NodeRow {
  nodeId: string;
  /** 用户看得懂的名字。事件里没有标题时退回 id。 */
  label: string;
  state: NodeState;
  summary: string;
}

/**
 * 节点列表按事件里第一次出现的顺序排，与实际执行顺序一致。
 *
 * 显示的是**标题**而不是 nodeId：用户从没见过 `internal_shell_77`，
 * 他看到的是自己在画布上起的名字。老事件没有标题时退回 id ——
 * 显示一个 id 也好过什么都不显示。
 */
function nodeRows(events: readonly RunEvent[]): NodeRow[] {
  const rows = new Map<string, NodeRow>();
  for (const event of events) {
    if (!event.nodeId) continue;
    const state = stateOf(event.type);
    if (!state) continue;
    rows.set(event.nodeId, {
      nodeId: event.nodeId,
      // 后来的事件可能带标题而先前那条没有，所以只在有值时覆盖
      label: event.nodeLabel ?? rows.get(event.nodeId)?.label ?? event.nodeId,
      state,
      summary: event.summary,
    });
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
 * 节点的标题。界面上凡是要显示节点的地方都走它。
 *
 * 事件里记着节点**当时**的名字，草稿改名不影响历史。
 * 老事件没有 nodeLabel（那个字段是后加的），退回 id ——
 * 显示一个 id 也好过什么都不显示。
 */
function nodeLabelOf(events: readonly RunEvent[], nodeId: string): string {
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

/** 活跃 = 非终态，从契约派生（见 runsStore 里同名注释）。 */
function isActive(status: string): boolean {
  return !isRunTerminal(status as RunStatus);
}

/** 0–1 的比例，喂给 CSS 的 scaleX；分母取不到时调用方不渲染进度条。 */
function progressRatio(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, done / total);
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

/**
 * 状态原样交给徽章。
 *
 * 曾经在这里挡一道：不在白名单里的一律变成 `'created'`。那份白名单是
 * 契约状态的**第三份副本**，而它的失效方式最难发现 —— 契约加一个状态，
 * 界面把它显示成「已创建」，一条正在跑的运行看起来像刚建好的，
 * 而没有任何报错。
 *
 * 徽章自己对未知状态返回状态名（见 statusLabel）—— 显示 `resuming_v2`
 * 至少是诚实的。
 */
function runStatus(status: string): RunStatusName {
  return status as RunStatusName;
}

/** 给测试用：验证契约的每个状态都原样通过，未知状态不被伪装。 */
export const runStatusForTest = runStatus;

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

/**
 * 这个节点是不是**正在跑**。
 *
 * 「运行是 running」不等于「这个节点在跑」：用户完全可能一边跑
 * 一边翻看前面已经跑完的节点。那时收帧会把当前节点的话
 * 显示到一个早就结束的节点下面。
 */
function nodeIsRunning(events: readonly RunEvent[], nodeId: string): boolean {
  const mine = events.filter((event) => event.nodeId === nodeId);
  const started = mine.some((event) => event.type === 'node.started');
  const ended = mine.some((event) =>
    ['node.succeeded', 'node.failed', 'node.skipped', 'node.cancelled'].includes(event.type),
  );
  return started && !ended;
}
