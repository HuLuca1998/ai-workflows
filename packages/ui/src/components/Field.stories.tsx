import { Field } from './Field.js';

export default { component: Field };

export const Basic = { args: { label: 'Issue 编号', name: 'issue', defaultValue: '548' } };

export const Required = {
  args: { label: '仓库', name: 'repo', required: true, defaultValue: 'atlas-api' },
};

export const WithHint = {
  args: {
    label: '工作目录',
    name: 'workdir',
    defaultValue: '~/code/atlas-api',
    hint: '已授权目录 · 权限档 Workspace Safe（Push / PR 仍需审批）',
  },
};

export const WithError = {
  args: { label: '工作目录', name: 'workdir', defaultValue: '/etc', error: '目录未授权' },
};

/** 启动表单的样子：由入口节点的输入 Schema 自动生成。 */
export const LaunchForm = () => (
  <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 420 }}>
    <Field label="Issue 编号" name="issue" required defaultValue="561" />
    <Field label="仓库" name="repo" defaultValue="atlas-api" />
    <Field label="基础分支" name="branch" defaultValue="main" />
    <Field label="GitHub Token" name="token" defaultValue="keychain://gh-cli" hint="引用，不展开明文" />
  </div>
);
