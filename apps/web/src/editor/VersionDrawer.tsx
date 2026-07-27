import { useEffect, useState } from 'react';
import { Button } from '@aiwf/ui';
import { diffGraphs, type WorkflowDiff, type WorkflowGraph } from './editorDeps.js';
import { DiffLines } from './DiffLines.js';
import type { VersionSummary } from './editorStore.js';

export interface VersionDrawerProps {
  rev: number;
  dirty: boolean;
  graph: WorkflowGraph;
  versions: readonly VersionSummary[];
  /** 读某个版本的图（回滚与对比都要）。 */
  loadVersionGraph: (versionId: string) => Promise<WorkflowGraph>;
  onClose: () => void;
  onPublish: () => void;
  onRollback: (versionId: string, version: number) => void;
  onExport: (graph: WorkflowGraph, label: string) => void;
}

/**
 * 版本抽屉，460px 从右侧滑入，照图纸：
 * 头部（版本历史 + 「发布快照不可变…」）· 当前草稿卡 · 版本列表 · Diff · 底部操作。
 *
 * Diff 是「选中版本 → 当前草稿」的方向，与图纸一致（+ 是草稿里新增的）。
 */
export function VersionDrawer({
  rev,
  dirty,
  graph,
  versions,
  loadVersionGraph,
  onClose,
  onPublish,
  onRollback,
  onExport,
}: VersionDrawerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(versions[0]?.id ?? null);
  const [selectedGraph, setSelectedGraph] = useState<WorkflowGraph | null>(null);
  const [diff, setDiff] = useState<WorkflowDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setSelectedGraph(null);
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadVersionGraph(selectedId)
      .then((versionGraph) => {
        if (cancelled) return;
        setSelectedGraph(versionGraph);
        setDiff(diffGraphs(versionGraph, graph));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, graph, loadVersionGraph]);

  const selected = versions.find((v) => v.id === selectedId);
  const nextVersion = (versions[0]?.version ?? 0) + 1;

  return (
    <div className="ver__backdrop" onClick={onClose}>
      <aside
        className="ver"
        aria-label="版本历史"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="ver__head">
          <i className="ph ph-git-branch" aria-hidden="true" />
          <div>
            <p className="ver__title">版本历史</p>
            <p className="ver__sub">发布快照不可变，运行记录永远引用具体版本</p>
          </div>
          <button type="button" className="ver__close" onClick={onClose} aria-label="关闭版本历史">
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </header>

        <div className="ver__body">
          <div className="ver__draft">
            <div className="ver__draft-row">
              <span className="ver__draft-name">当前草稿 rev{rev}</span>
              <span className="ver__draft-state">{dirty ? '有未保存改动' : '未发布'}</span>
            </div>
            <p className="ver__draft-note">
              {graph.nodes.length} 节点 {graph.edges.length} 连接
              {dirty ? ' · 先保存草稿才能发布' : ''}
            </p>
          </div>

          {versions.length === 0 ? (
            <p className="ver__empty">还没有发布过版本。发布后这里会列出每个不可变快照。</p>
          ) : null}

          {versions.map((version) => (
            <button
              key={version.id}
              type="button"
              className="ver__item"
              data-selected={version.id === selectedId ? 'true' : undefined}
              onClick={() => setSelectedId(version.id)}
            >
              <span className="ver__item-row">
                <span className="ver__item-name">v{version.version}</span>
                {version.version === versions[0]?.version ? (
                  <span className="ver__item-state">最新</span>
                ) : null}
                <span className="ver__item-when">{formatTime(version.publishedAt)}</span>
              </span>
              <span className="ver__item-note">发布者 {version.publishedBy}</span>
              <span className="ver__item-hash">配置哈希 {version.configHash.slice(0, 12)}</span>
            </button>
          ))}

          {selected ? (
            <section className="ver__diff" aria-label="版本对比">
              <p className="ver__diff-title">v{selected.version} → 当前草稿</p>
              <div className="ver__diff-body">
                {loading ? <p className="ver__diff-line">正在读取版本…</p> : null}
                {error ? (
                  <p className="ver__diff-line ver__diff-line--removed" role="alert">
                    {error}
                  </p>
                ) : null}
                {diff && !loading && !error ? <DiffLines diff={diff} /> : null}
              </div>
            </section>
          ) : null}
        </div>

        <footer className="ver__foot">
          <Button
            disabled={!selectedGraph}
            onClick={() => {
              if (selectedGraph && selected) onExport(selectedGraph, `v${selected.version}`);
            }}
          >
            导出此版本
          </Button>
          <span className="ver__grow" />
          <Button
            disabled={!selectedGraph}
            title={selectedGraph ? undefined : '先选一个版本'}
            onClick={() => {
              if (selected) onRollback(selected.id, selected.version);
            }}
          >
            回滚为草稿
          </Button>
          <Button
            variant="primary"
            disabled={dirty}
            title={dirty ? '有未保存的改动，先保存草稿' : undefined}
            onClick={onPublish}
          >
            发布草稿为 v{nextVersion}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}
