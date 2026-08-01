import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Dialog } from '@aiwf/ui';
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
  // dirty 时点返回先确认 —— 静默丢改动是第 2 轮实测抓到的数据丢失路径：
  // 弹层的「保存到草稿」只落本地草稿，用户以为存了，一个返回全没了
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  /** 问题清单展开着吗。默认收起 —— 顶栏是常驻的，展开的一摞会挡画布 */
  const [issuesOpen, setIssuesOpen] = useState(false);
  const errorCount = validation.issues.filter((i) => i.level === 'error').length;
  const warningCount = validation.issues.length - errorCount;
  const issueCount = validation.issues.length;

  /**
   * Esc 与点外面都能关。
   *
   * 原来只能再点一次触发器 —— 而节点配置弹窗的 Esc 是好使的，
   * 同一个应用两套行为（复核实测 C）。这个浮层还会盖住模态弹窗：
   * 900×600 下开着它再双击节点，配置弹窗有三个标签点不到。
   */
  const issuesRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!issuesOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIssuesOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      // 点清单里面不关：用户要能选中文字复制节点 id
      if (issuesRef.current?.contains(event.target as Node)) return;
      setIssuesOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [issuesOpen]);

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
        onClick={() => (dirty ? setConfirmingLeave(true) : navigate('/'))}
        aria-label="返回工作流列表"
      >
        <i className="ph ph-arrow-left" aria-hidden="true" />
      </button>

      <Dialog
        open={confirmingLeave}
        title="有未保存的改动"
        onClose={() => setConfirmingLeave(false)}
        width={420}
        actions={
          <>
            <Button onClick={() => setConfirmingLeave(false)}>留下继续编辑</Button>
            <Button variant="danger" onClick={() => navigate('/')}>
              丢弃并返回
            </Button>
          </>
        }
      >
        <p>
          这份草稿还没保存到后端 —— 现在返回，这些改动会丢。 要保留的话先点工具栏的「保存草稿」。
        </p>
      </Dialog>

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

      {/*
       * 校验结果。**「N 个问题」必须说得出是哪 N 个** ——
       * 它原来是一段死文字（无 title、无 onclick），而节点只描红边：
       * 用户被禁用的「运行」卡住，却拿不到任何线索（第三方巡检 B-02）。
       * 同一份 issues 一直就在手里，只是没渲染出来。
       *
       * 只有警告时也不说「校验通过」：15 个互不相连的节点顶栏写着通过，
       * 点运行才知道 Dry Run 报「这些节点从入口走不到」（B-07）。
       */}
      <span
        ref={issuesRef}
        className="editor-bar__validation"
        data-ok={errorCount === 0 && warningCount === 0 ? 'true' : 'false'}
      >
        {issueCount === 0 ? (
          <>
            <i className="ph ph-check-circle" aria-hidden="true" />
            {`校验通过 · ${nodeCount} 节点 ${edgeCount} 连接`}
          </>
        ) : (
          <button
            type="button"
            className="editor-bar__issues-trigger"
            aria-expanded={issuesOpen}
            onClick={() => setIssuesOpen((open) => !open)}
          >
            <i
              className={`ph ${errorCount > 0 ? 'ph-warning-circle' : 'ph-info'}`}
              aria-hidden="true"
            />
            {errorCount > 0 ? `${errorCount} 个问题` : `${warningCount} 项提醒`}
            {` · ${nodeCount} 节点 ${edgeCount} 连接`}
            <i
              className={`ph ${issuesOpen ? 'ph-caret-up' : 'ph-caret-down'}`}
              aria-hidden="true"
            />
          </button>
        )}
        {/* 运行为什么灰着必须可见 —— 藏在 title 里的解释等于没有解释 */}
        {dirty && errorCount === 0 ? (
          <span className="editor-bar__hint">未保存 —— 保存草稿后才能运行</span>
        ) : null}

        {issuesOpen && issueCount > 0 ? (
          <ul className="editor-bar__issues" role="list">
            {validation.issues.map((issue, index) => (
              <li key={`${issue.code}:${issue.nodeId ?? index}`} data-level={issue.level}>
                <span className="editor-bar__issue-level">
                  {issue.level === 'error' ? '错误' : '提醒'}
                </span>
                <span>{issue.message}</span>
                {/* 节点 id 单独显示：用户要能拿它在画布上找到那个节点 */}
                {issue.nodeId ? <code>{issue.nodeId}</code> : null}
              </li>
            ))}
          </ul>
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
