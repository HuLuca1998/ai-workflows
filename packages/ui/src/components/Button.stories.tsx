import { Button } from './Button.js';
import { Frame } from './_frame.js';

export default {
  title: 'Components/Button',
  component: Button,
};

/**
 * 预览用例。一律写成函数形式：Preview.js 不解析 CSF 的 args，
 * 对象形式会被它用空 props 渲染，看到的是个空组件。
 */

export const Primary = () => (
  <Frame>
    <Button variant="primary">开始运行</Button>
  </Frame>
);

export const Secondary = () => (
  <Frame>
    <Button>取消</Button>
  </Frame>
);

export const Ghost = () => (
  <Frame>
    <Button variant="ghost">查看 Diff</Button>
  </Frame>
);

export const Danger = () => (
  <Frame>
    <Button variant="danger">拒绝并保留 worktree</Button>
  </Frame>
);

export const Loading = () => (
  <Frame>
    <Button variant="primary" loading>
      发布中
    </Button>
  </Frame>
);

export const Disabled = () => (
  <Frame>
    <Button disabled>发布版本</Button>
  </Frame>
);

export const IconOnly = () => (
  <Frame>
    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
      <Button variant="icon" aria-label="放大">
        +
      </Button>
      <Button variant="icon" aria-label="缩小">
        −
      </Button>
      <Button variant="icon" aria-label="适应视图">
        ⤢
      </Button>
    </div>
  </Frame>
);

/** 审批横幅上的一整排操作：检查按钮之间的间距、对齐与视觉优先级。 */
export const ApprovalRow = () => (
  <Frame>
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Button variant="primary">批准并推送、创建 PR</Button>
      <Button>要求修改</Button>
      <Button variant="danger">拒绝并保留 worktree</Button>
    </div>
  </Frame>
);
