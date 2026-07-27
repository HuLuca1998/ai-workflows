import { Button } from './Button.js';

/**
 * Preview.js 用例。每个命名导出就是右侧预览面板里的一条。
 * 这些用例同时充当「组件长什么样」的活文档，改组件时请一并更新。
 */
export default { component: Button };

export const Primary = {
  args: { variant: 'primary' as const, children: '开始运行' },
};

export const Secondary = {
  args: { children: '取消' },
};

export const Ghost = {
  args: { variant: 'ghost' as const, children: '查看 Diff' },
};

export const Danger = {
  args: { variant: 'danger' as const, children: '拒绝并保留 worktree' },
};

export const Loading = {
  args: { variant: 'primary' as const, loading: true, children: '发布中' },
};

export const Disabled = {
  args: { disabled: true, children: '发布版本' },
};

/** 审批横幅上的一整排操作，检查按钮之间的间距与对齐。 */
export const ApprovalRow = () => (
  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
    <Button variant="primary">批准并推送、创建 PR</Button>
    <Button>要求修改</Button>
    <Button variant="danger">拒绝并保留 worktree</Button>
  </div>
);
