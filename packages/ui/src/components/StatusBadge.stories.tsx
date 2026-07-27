import { StatusBadge, type RunStatusName } from './StatusBadge.js';
import { Frame } from './_frame.js';

export const Running = () => (
  <Frame>
    <StatusBadge status="running" />
  </Frame>
);

export const WaitingApproval = () => (
  <Frame>
    <StatusBadge status="waiting_approval" detail="已等待 2 分 11 秒" />
  </Frame>
);

export const Failed = () => (
  <Frame>
    <StatusBadge status="failed" detail="节点 3 · timeout · exitCode 124" />
  </Frame>
);

/**
 * 全部状态并排。验收标准要求「重要状态不只用颜色表达」——
 * 把系统调成灰度或开启 Increase Contrast 后，这一屏仍应能逐条分辨。
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
    <Frame>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {statuses.map((status) => (
          <StatusBadge key={status} status={status} />
        ))}
      </div>
    </Frame>
  );
};
