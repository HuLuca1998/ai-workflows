import { Tag } from './Tag.js';

export default { component: Tag };

export const Accent = { args: { tone: 'accent' as const, children: 'v7' } };
export const Neutral = { args: { children: '手动触发' } };
export const Outline = { args: { tone: 'outline' as const, children: '结构化输出' } };
export const Warning = { args: { tone: 'warning' as const, children: '等待审批' } };
export const Danger = { args: { tone: 'danger' as const, children: 'blocker' } };

export const CapabilityRow = () => (
  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
    <Tag tone="accent">v7</Tag>
    <Tag>ACP · Codex</Tag>
    <Tag tone="outline">结构化输出</Tag>
    <Tag tone="warning">需要审批</Tag>
    <Tag tone="danger">外部写操作</Tag>
  </div>
);
