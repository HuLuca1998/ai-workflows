import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { Field } from './Field.js';
import { Frame } from './_frame.js';

export default {
  title: 'Components/Dialog',
  component: Dialog,
};

export const NodeConfig = () => (
  <Frame>
    <Dialog
      open
      title="节点配置 · 运行 lint"
      onClose={() => {}}
      actions={
        <>
          <Button>取消</Button>
          <Button>测试运行此节点</Button>
          <Button variant="primary">保存到草稿</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Field label="解释器" name="interpreter" defaultValue="zsh" />
        <Field label="命令" name="cmd" defaultValue="pnpm lint" />
        <Field label="超时" name="timeout" defaultValue="120s" hint="墙钟时间；超时进失败分支" />
      </div>
    </Dialog>
  </Frame>
);

export const Approval = () => (
  <Frame>
    <Dialog
      open
      title="审批 · 检查 Diff 与风险"
      width={560}
      onClose={() => {}}
      actions={
        <>
          <Button>要求修改</Button>
          <Button variant="primary">批准并推送、创建 PR</Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        将要发生的外部写操作：commit → push 到 origin → 创建 PR。不会修改你当前分支。
      </p>
    </Dialog>
  </Frame>
);
