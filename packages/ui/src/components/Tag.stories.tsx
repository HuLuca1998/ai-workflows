import { Tag } from './Tag.js';
import { Frame } from './_frame.js';

export const Accent = () => (
  <Frame>
    <Tag tone="accent">v7</Tag>
  </Frame>
);

export const Neutral = () => (
  <Frame>
    <Tag>手动触发</Tag>
  </Frame>
);

export const AllTones = () => (
  <Frame>
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Tag tone="accent">v7</Tag>
      <Tag>ACP · Codex</Tag>
      <Tag tone="outline">结构化输出</Tag>
      <Tag tone="warning">需要审批</Tag>
      <Tag tone="danger">外部写操作</Tag>
    </div>
  </Frame>
);
