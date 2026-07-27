import { StatusBadge, type RunStatusName } from './StatusBadge.js';

export default { component: StatusBadge };

export const Running = { args: { status: 'running' as const } };
export const WaitingApproval = {
  args: { status: 'waiting_approval' as const, detail: '已等待 2 分 11 秒' },
};
export const Failed = { args: { status: 'failed' as const, detail: '节点 3 · timeout' } };

/**
 * 全部状态并排——验收标准要求「重要状态不只用颜色表达」，
 * 把浏览器调成灰度或开启 Increase Contrast 后，这一屏仍应能逐条分辨。
 */
export const AllStatuses = () => {
  const statuses: RunStatusName[] = [
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
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {statuses.map((status) => (
        <StatusBadge key={status} status={status} />
      ))}
    </div>
  );
};
