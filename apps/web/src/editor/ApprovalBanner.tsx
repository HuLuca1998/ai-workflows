import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { coreClient } from '../data/workspace.js';

/**
 * 等待审批横幅 —— 严格照图纸「02 画布编辑器」顶部那条。
 *
 * 图纸原文：「nodeName 7 · 审批：检查 Diff」+「正在等待你的决定 ·
 * 已等待 2 分 11 秒 · 3 个文件变更，测试 12/12 通过」+ 两个按钮。
 *
 * 不给这条的话，用户在编辑器里改流程时不会知道有一个运行正卡在审批上
 * 等他 —— 而那个运行占着 worktree，也占着他的时间。改完发布之后才发现
 * 「原来早上那次跑到一半停了」是最糟的顺序。
 */

/** 审批是低频事件，5 秒一次足够，也不会给引擎添压。 */
const PROBE_MS = 5000;

interface Run {
  id: string;
  currentNode?: string;
  startedAt?: string;
}

interface RunEvent {
  seq: number;
  type: string;
  nodeId?: string;
  nodeLabel?: string;
  summary: string;
}

export interface ApprovalBannerProps {
  workflowId: string;
  /**
   * 上报「哪个节点正等着批」。
   *
   * 规范 §6 的审批是**双通道**：画布节点脉冲高亮 + 顶部横幅。此前这个组件
   * 手里就有 request.nodeId，却没有任何一行把它交给画布 —— 用户看到横幅后
   * 仍要自己在图里找是哪个节点，双通道退化成单通道。
   */
  onWaitingNode?: (nodeId: string | null) => void;
}

export function ApprovalBanner({ workflowId, onWaitingNode }: ApprovalBannerProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [request, setRequest] = useState<RunEvent | null>(null);
  /** 每秒重算一次「已等待多久」——数字不动的话用户会以为界面卡了。 */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const result = (await coreClient.call('run.list', {
          workflowId,
          status: ['waiting_approval'],
          limit: 1,
        })) as { items: Run[] };
        const waiting = result.items[0];
        if (cancelled) return;
        // 没有等待中的运行就把横幅收掉 —— 批过之后它不该继续挂在那里
        if (!waiting) {
          setRun(null);
          setRequest(null);
          return;
        }
        setRun(waiting);

        // 审批请求那条事件里有「在批什么」的摘要
        const events = (await coreClient.call('run.events', {
          runId: waiting.id,
          fromSeq: 0,
          limit: 200,
        })) as { events: RunEvent[] };
        if (cancelled) return;
        const last = [...events.events]
          .reverse()
          .find((event) => event.type === 'approval.requested');
        setRequest(last ?? null);
      } catch {
        // 查不到就不显示。编辑器不该因为一次查询失败多出一个错误条 ——
        // 用户此刻在做的是改流程，那条报错帮不上他任何忙
      }
    };

    void probe();
    /*
     * 必须轮询：运行往往是在编辑器已经打开之后才走到审批那一步的，
     * 只在挂载时探一次的话，之后卡住等你也不会有任何提示 ——
     * 正是这个组件开头注释说要防止的那个顺序。
     */
    const timer = setInterval(() => void probe(), PROBE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workflowId]);

  // 把「谁在等」交给画布，让那个节点亮起来（规范 §6 的第二条通道）
  useEffect(() => {
    onWaitingNode?.(run ? (request?.nodeId ?? run.currentNode ?? null) : null);
  }, [run, request, onWaitingNode]);

  useEffect(() => {
    if (!run) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [run]);

  if (!run) return null;

  const nodeName = request?.nodeLabel ?? request?.nodeId ?? run.currentNode ?? '审批';
  const summary = request?.summary;
  const waited = waitedFor(run.startedAt, tick);

  return (
    <div className="editor-approval" role="status">
      <i className="ph-fill ph-hand-palm" aria-hidden="true" />
      <div className="editor-approval__text">
        <b>{nodeName}</b>
        <span>
          正在等待你的决定
          {waited ? ` · 已等待 ${waited}` : ''}
          {summary ? ` · ${summary}` : ''}
        </span>
      </div>
      <span className="editor-approval__grow" />
      {/* 审批在执行记录里做：那里有完整的事件流与产物，
          而编辑器这一屏是设计态，塞一个审批弹层会把两种模式混在一起 */}
      <Link className="runs__action" to={`/runs?run=${run.id}&tab=artifacts`}>
        查看 Diff
      </Link>
      <Link className="runs__action runs__action--primary" to={`/runs?run=${run.id}`}>
        处理审批
      </Link>
    </div>
  );
}

/** 「2 分 11 秒」。不满一分钟只说秒 —— 「0 分 43 秒」读起来别扭。 */
function waitedFor(startedAt: string | undefined, _tick: number): string | null {
  if (!startedAt) return null;
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return null;

  const seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
