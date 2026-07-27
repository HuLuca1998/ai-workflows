import { Button } from '@aiwf/ui';

export interface SupervisorDrawerProps {
  onClose: () => void;
}

/**
 * 主管 AI 抽屉（468px）。M0 只搭壳：会话、工具轨迹与结构化 Patch 在 M4 接上。
 *
 * 底部常驻本次会话授予的 Scope——用户随时看得到 AI 现在能做什么、不能做什么，
 * 这是「AI 建议 ≠ 执行」在界面上的兜底。
 */
export function SupervisorDrawer({ onClose }: SupervisorDrawerProps) {
  return (
    <aside aria-label="主管 AI" className="supervisor">
      <div className="supervisor__head">
        <div>
          <h2>主管 AI</h2>
          <p className="supervisor__sub">掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置</p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="收起主管 AI">
          收起
        </Button>
      </div>

      <div className="supervisor__body">
        <p className="supervisor__hint">M0 阶段这里只有壳。M4 接上会话、工具调用轨迹与结构化 Patch。</p>
      </div>

      <footer className="supervisor__scopes">
        <span>本次会话授予：</span>
        <code>workflow:read</code>
        <code>workflow:write-draft</code>
        <code>memory:read</code>
        <em>发布与运行未授权</em>
      </footer>
    </aside>
  );
}
