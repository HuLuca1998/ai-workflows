import { Card } from './Card.js';

export default { component: Card };

export const Basic = {
  args: { title: '今日运行', children: '120 成功' },
};

export const WithKickerAndMeta = {
  args: {
    kicker: '统计',
    title: 'Token 用量',
    children: '1.24M',
    meta: '本周 · 较上周 +8%',
  },
};

/** 概览页顶部的统计条：四列等宽。 */
export const StatRow = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)' }}>
    <Card kicker="等待审批" title="1">Issue #548</Card>
    <Card kicker="今日运行" title="12">10 成功</Card>
    <Card kicker="Token 用量" title="1.24M">本周</Card>
    <Card kicker="活跃 worktree" title="3">占用 412 MB</Card>
  </div>
);
