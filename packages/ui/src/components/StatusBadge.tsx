export type RunStatusName =
  | 'created'
  | 'preflight'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'interrupted'
  | 'resuming'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * 每个状态三件套：文字、形状、颜色。
 *
 * 验收标准要求「重要状态不只用颜色表达」，所以文字与形状是必须项，
 * 颜色只是第三层冗余信息。形状用于色觉障碍用户与灰度截图。
 */
const STATUS_META: Record<RunStatusName, { label: string; shape: string; tone: string }> = {
  created: { label: '已创建', shape: 'dot', tone: 'idle' },
  preflight: { label: '依赖检查', shape: 'dot', tone: 'queued' },
  queued: { label: '排队中', shape: 'dot', tone: 'queued' },
  running: { label: '运行中', shape: 'pulse', tone: 'running' },
  waiting_approval: { label: '等待审批', shape: 'ring', tone: 'waiting' },
  paused: { label: '已暂停', shape: 'bars', tone: 'waiting' },
  interrupted: { label: '已中断', shape: 'bars', tone: 'waiting' },
  resuming: { label: '恢复中', shape: 'pulse', tone: 'running' },
  succeeded: { label: '成功', shape: 'check', tone: 'success' },
  failed: { label: '失败', shape: 'cross', tone: 'failed' },
  cancelled: { label: '已取消', shape: 'slash', tone: 'cancelled' },
};

export interface StatusBadgeProps {
  status: RunStatusName;
  /** 附加说明，如「节点 3」「已等待 2 分 11 秒」。 */
  detail?: string;
}

export function StatusBadge({ status, detail }: StatusBadgeProps) {
  const meta = STATUS_META[status];
  return (
    <span
      role="status"
      data-status={status}
      data-shape={meta.shape}
      data-tone={meta.tone}
      className="aiwf-status"
    >
      <span aria-hidden="true" className="aiwf-status__mark" data-shape={meta.shape} />
      <span className="aiwf-status__label">{meta.label}</span>
      {detail ? <span className="aiwf-status__detail">{detail}</span> : null}
    </span>
  );
}

export function statusLabel(status: RunStatusName): string {
  return STATUS_META[status].label;
}
