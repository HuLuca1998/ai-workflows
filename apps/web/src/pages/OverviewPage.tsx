import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, StatusBadge, Tag } from '@aiwf/ui';
import { useWorkspace } from '../data/workspace.js';

/**
 * 概览与工作流 —— 严格照图纸「01 工作流首页」。
 *
 * 统计条的四张卡、标签、字号、颜色、筛选 chips 的药丸形状与位置都取自图纸。
 * 引擎（M2）与 AI 节点（M3）接上前，这些卡的**数值位留空**：
 * 结构照图纸，但不填演示数字，也不添加图纸上没有的说明文案。
 */

const FILTERS = ['全部', '运行中', '草稿', '失败'] as const;
type Filter = (typeof FILTERS)[number];

export function OverviewPage() {
  const navigate = useNavigate();
  const { workflows, loading, error, load, createWorkflow } = useWorkspace();
  const [filter, setFilter] = useState<Filter>('全部');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return workflows.filter((w) => {
      // M0 还没有运行数据，所有工作流都处于「草稿」状态
      if (filter === '运行中' || filter === '失败') return false;
      if (!keyword) return true;
      return w.name.toLowerCase().includes(keyword);
    });
  }, [workflows, filter, query]);

  const onCreate = async () => {
    setCreating(true);
    try {
      const id = await createWorkflow(`未命名工作流 ${workflows.length + 1}`);
      // 建完直接进编辑器：新建的意图就是要去搭流程
      if (id) navigate(`/editor/${id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <article className="overview">
      <header className="overview__head">
        <div>
          <p className="kicker">本地优先 · {workflows.length} 个工作流</p>
          <h1>工作流</h1>
        </div>
        <span className="overview__grow" />
        <label className="search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索工作流、运行或产物"
            aria-label="搜索工作流"
          />
        </label>
        <Button>导入</Button>
        <Button variant="primary" onClick={() => void onCreate()} loading={creating}>
          <i className="ph ph-plus" aria-hidden="true" />
          新建工作流
        </Button>
      </header>

      <section className="stats" role="region" aria-label="概览统计">
        <Stat label="等待审批" accent />
        <Stat label="今日运行" noteTone="success" />
        <Stat label="Token 用量" />
        <Stat label="活跃 worktree" />
      </section>

      <section className="list" role="region" aria-label="全部工作流">
        <header className="list__head">
          <h2>全部工作流</h2>
          <div className="chips" role="tablist" aria-label="状态筛选">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className="chip"
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <p className="list__error" role="alert">
            读取失败：{error}
          </p>
        ) : null}

        {loading && workflows.length === 0 ? <p className="list__hint">正在读取…</p> : null}

        {!loading && workflows.length === 0 && !error ? (
          <div className="empty">
            <i className="ph ph-flow-arrow" aria-hidden="true" />
            <p className="empty__title">还没有工作流</p>
            <p className="empty__detail">
              新建一个空工作流，然后在编辑器里从左侧拖入入口节点。
              <br />
              模板库（6 个预设流程）在 M1 随节点库一起上线。
            </p>
            <Button variant="primary" onClick={() => void onCreate()} loading={creating}>
              新建工作流
            </Button>
          </div>
        ) : null}

        {workflows.length > 0 ? (
          <table className="wf-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">状态</th>
                <th scope="col">最近一次运行</th>
                <th scope="col">版本 · 触发</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((w) => (
                <tr
                  key={w.id}
                  onClick={() => navigate(`/editor/${w.id}`)}
                  data-clickable="true"
                  title="打开编辑器"
                >
                  <td>
                    <p className="wf-table__name">{w.name}</p>
                    <p className="wf-table__desc">
                      {w.folder ? `${w.folder} · ` : ''}
                      更新于 {formatTime(w.updatedAt)}
                    </p>
                  </td>
                  <td>
                    <StatusBadge status="created" />
                  </td>
                  <td className="wf-table__muted">未运行</td>
                  <td>
                    <Tag tone="outline">草稿</Tag>
                    <span className="wf-table__muted"> · 手动</span>
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={4} className="wf-table__empty">
                    当前筛选下没有工作流
                    <button type="button" className="link-button" onClick={() => setFilter('全部')}>
                      清除筛选
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </section>
    </article>
  );
}

/**
 * 统计卡。图纸里第一张的数字用强调色、第二张的副文本用成功色。
 * value / note 缺省时数值位保持图纸的高度，不塌陷、不填占位符。
 */
function Stat({
  label,
  value,
  note,
  accent,
  noteTone,
}: {
  label: string;
  value?: string;
  note?: string;
  accent?: boolean;
  noteTone?: 'success';
}) {
  return (
    <div className="stat">
      <p className="stat__label">{label}</p>
      <p className="stat__value" data-accent={accent ? 'true' : undefined}>
        <span className="stat__number">{value ?? ''}</span>
        <span className="stat__note" data-tone={noteTone}>
          {note ?? ''}
        </span>
      </p>
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}
