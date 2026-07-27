import { Card } from './Card.js';
import { Frame } from './_frame.js';

export const Basic = () => (
  <Frame>
    <Card title="今日运行">120 成功</Card>
  </Frame>
);

export const WithKickerAndMeta = () => (
  <Frame>
    <Card kicker="统计" title="Token 用量" meta="本周 · 较上周 +8%">
      1.24M
    </Card>
  </Frame>
);

/** 概览页顶部的统计条：四列等宽。 */
export const StatRow = () => (
  <Frame>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)' }}>
      <Card kicker="等待审批" title="1">
        Issue #548
      </Card>
      <Card kicker="今日运行" title="12">
        10 成功
      </Card>
      <Card kicker="Token 用量" title="1.24M">
        本周
      </Card>
      <Card kicker="活跃 worktree" title="3">
        占用 412 MB
      </Card>
    </div>
  </Frame>
);
