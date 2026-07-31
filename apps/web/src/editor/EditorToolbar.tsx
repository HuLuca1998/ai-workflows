import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@aiwf/ui';
import type { ValidationResult } from './editorDeps.js';

export interface EditorToolbarProps {
  name: string;
  rev: number;
  /** 最近一个已发布版本号；没有就是从未发布。 */
  latestVersion?: number;
  dirty: boolean;
  saving: boolean;
  validation: ValidationResult;
  nodeCount: number;
  edgeCount: number;
  onSave: () => void;
  onPublish: () => void;
  onToggleVersions: () => void;
  onRun: () => void;
  onRename: (name: string) => void;
}

/**
 * 编辑器工具栏，50px，照图纸「02 画布编辑器」：
 * 返回 · 名称 · 草稿标签 · 撤销重做 · 校验状态 · 版本 · 发布版本 · 运行。
 *
 * 撤销重做按图纸是禁用态（图纸里重做那个图标用的是 neutral-700，
 * 且快捷键表把 ⌘Z 标为「待实现」），所以这里也保持禁用而不是画个点不动的按钮。
 */
export function EditorToolbar({
  name,
  rev,
  latestVersion,
  dirty,
  saving,
  validation,
  nodeCount,
  edgeCount,
  onSave,
  onPublish,
  onToggleVersions,
  onRun,
  onRename,
}: EditorToolbarProps) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const errorCount = validation.issues.filter((i) => i.level === 'error').length;

  const commitRename = (next: string) => {
    setRenaming(false);
    const trimmed = next.trim();
    // 空名字或没改就当没发生 —— 不为一次误触发一条审计记录
    if (trimmed && trimmed !== name) onRename(trimmed);
  };

  return (
    <header className="editor-bar">
      <button
        type="button"
        className="editor-bar__back"
        onClick={() => navigate('/')}
        aria-label="返回工作流列表"
      >
        <i className="ph ph-arrow-left" aria-hidden="true" />
      </button>

      {renaming ? (
        <input
          className="editor-bar__name editor-bar__name--editing"
          aria-label="工作流名称"
          autoFocus
          defaultValue={name}
          onBlur={(event) => commitRename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename(event.currentTarget.value);
            if (event.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        // 双击改名。新建只能得到「未命名工作流 N」，
        // 没有改名入口的话列表很快全是这种名字
        <h1 className="editor-bar__name" title="双击改名" onDoubleClick={() => setRenaming(true)}>
          {name}
        </h1>
      )}

      <span className="editor-bar__rev">
        {latestVersion ? `草稿 · 基于 v${latestVersion}` : `草稿 · rev${rev}`}
      </span>

      <span className="editor-bar__sep" aria-hidden="true" />

      {/* 撤销 / 重做：快捷键表里标为待实现，保持禁用而不是给个假按钮 */}
      <button type="button" className="editor-bar__icon" disabled aria-label="撤销（待实现）">
        <i className="ph ph-arrow-arc-left" aria-hidden="true" />
      </button>
      <button type="button" className="editor-bar__icon" disabled aria-label="重做（待实现）">
        <i className="ph ph-arrow-arc-right" aria-hidden="true" />
      </button>

      <span className="editor-bar__grow" />

      <span className="editor-bar__validation" data-ok={errorCount === 0 ? 'true' : 'false'}>
        <i
          className={`ph ${errorCount === 0 ? 'ph-check-circle' : 'ph-warning-circle'}`}
          aria-hidden="true"
        />
        {errorCount === 0
          ? `校验通过 · ${nodeCount} 节点 ${edgeCount} 连接`
          : `${errorCount} 个问题 · ${nodeCount} 节点 ${edgeCount} 连接`}
        {/* 运行为什么灰着必须可见 —— 藏在 title 里的解释等于没有解释 */}
        {dirty && errorCount === 0 ? (
          <span className="editor-bar__hint">未保存 —— 保存草稿后才能运行</span>
        ) : null}
      </span>

      <Button onClick={onToggleVersions}>
        <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
        版本
      </Button>
      <Button onClick={onSave} loading={saving} disabled={!dirty}>
        {dirty ? '保存草稿' : '已保存'}
      </Button>
      <Button onClick={onPublish} disabled={saving || errorCount > 0}>
        发布版本
      </Button>
      {/* 有未保存改动时先存：运行的是已落库的修订，本地改动不在其中 */}
      <Button
        variant="primary"
        disabled={dirty || errorCount > 0}
        title={
          dirty
            ? '有未保存的改动。先保存草稿再运行'
            : errorCount > 0
              ? '图有错误，先修好再运行'
              : undefined
        }
        onClick={onRun}
      >
        <i className="ph ph-play" aria-hidden="true" />
        运行
      </Button>
    </header>
  );
}
