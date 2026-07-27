import { Field } from './Field.js';
import { Frame } from './_frame.js';

export default {
  title: 'Components/Field',
  component: Field,
};

export const Basic = () => (
  <Frame>
    <Field label="Issue 编号" name="issue" defaultValue="548" />
  </Frame>
);

export const Required = () => (
  <Frame>
    <Field label="仓库" name="repo" required defaultValue="atlas-api" />
  </Frame>
);

export const WithHint = () => (
  <Frame>
    <Field
      label="工作目录"
      name="workdir"
      defaultValue="~/code/atlas-api"
      hint="已授权目录 · 权限档 Workspace Safe（Push / PR 仍需审批）"
    />
  </Frame>
);

export const WithError = () => (
  <Frame>
    <Field label="工作目录" name="workdir" defaultValue="/etc" error="目录未授权" />
  </Frame>
);

/** 启动表单：由入口节点的输入 Schema 自动生成的那一屏。 */
export const LaunchForm = () => (
  <Frame>
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 420 }}>
      <Field label="Issue 编号" name="issue" required defaultValue="561" />
      <Field label="仓库" name="repo" defaultValue="atlas-api" />
      <Field label="基础分支" name="branch" defaultValue="main" />
      <Field
        label="GitHub Token"
        name="token"
        defaultValue="keychain://gh-cli"
        hint="引用，不展开明文"
      />
    </div>
  </Frame>
);
