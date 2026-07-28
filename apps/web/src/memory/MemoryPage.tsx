import { useEffect, useState } from 'react';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { describeError } from '../data/describeError.js';
import { LIST_PAGE_SIZE } from '@aiwf/contracts';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';

/**
 * 记忆管理 —— 严格照图纸「04 记忆管理」。
 *
 * 记忆会被注入**后续每一次** AI 调用，所以它既是长期上下文，
 * 也是一条持续生效的指令。这决定了这一屏的几处设计：
 *
 * 1. **AI 提议要确认才生效**。图纸原话「确认后才保存，并注入后续调用」——
 *    模型建议记住的东西直接生效的话，它就能自己给自己加指令。
 * 2. **停用是比删除更轻的一档**。先停掉看看有没有影响，确认没用了再删。
 *    停用与过期的条目仍留在列表里，用户要知道它们为什么不生效。
 * 3. **密钥禁止写入**。存储层会拦，界面也说明为什么。
 */

interface Memory {
  id: string;
  scope: string;
  scopeId?: string;
  key: string;
  value: string;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  ver: number;
  tags: string[];
  enabled: boolean;
}

/** 图纸顶部那排作用域 chips。 */
const SCOPES: { key: string | null; label: string }[] = [
  { key: null, label: '全部' },
  { key: 'global', label: '全局' },
  { key: 'workspace', label: '工作区' },
  { key: 'workflow', label: '工作流' },
  { key: 'agent', label: 'Agent' },
  { key: 'session', label: '会话' },
];

const SCOPE_LABELS: Record<string, string> = {
  global: '全局',
  workspace: '工作区',
  workflow: '工作流',
  agent: 'Agent',
  session: '会话',
};

export function MemoryPage() {
  // 输入即搜（300ms 防抖）—— 与其余五个列表页同一套交互
  const search = useDebouncedSearch((next) => void load(scope, next, 0));
  const [items, setItems] = useState<Memory[] | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  /** 搜索词由 useDebouncedSearch 持有 —— 见下面的 search。 */
  const [error, setError] = useState<string | null>(null);
  /** 满足条件的总条数与当前页起点。后端早就分页了，缺的是界面这一层。 */
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  /** 正在等第二次点击的那一条；null 表示没有。 */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /**
   * 拉一页记忆。
   *
   * **必须带 limit/offset**：不带就只拿到后端默认的第一页，
   * 而顶部那句「N 条」如果显示 items.length，无论库里有多少
   * 都永远是 50 —— 用户拿不到第 51 条，也不知道自己拿不到。
   */
  const load = async (nextScope = scope, nextQuery = '', nextOffset = offset) => {
    setOffset(nextOffset);
    try {
      const result = (await coreClient.call('memory.list', {
        ...(nextScope ? { scope: nextScope } : {}),
        ...(nextQuery ? { query: nextQuery } : {}),
        limit: LIST_PAGE_SIZE,
        offset: nextOffset,
      })) as { items: Memory[]; total: number };
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(describeError(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // AI 提议的条目还没启用 —— 它们单独占一块，等用户决定
  const proposals = (items ?? []).filter((item) => item.source === 'ai_proposed' && !item.enabled);
  const saved = (items ?? []).filter((item) => !(item.source === 'ai_proposed' && !item.enabled));

  const accept = async (memory: Memory) => {
    try {
      await coreClient.call('memory.toggle', { id: memory.id, enabled: true });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const dismiss = async (memory: Memory) => {
    try {
      await coreClient.call('memory.delete', { id: memory.id });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const toggle = async (memory: Memory) => {
    try {
      await coreClient.call('memory.toggle', { id: memory.id, enabled: !memory.enabled });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const remove = async (memory: Memory) => {
    setConfirmDelete(null);
    try {
      await coreClient.call('memory.delete', { id: memory.id });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <article className="memory">
      <header className="memory__head">
        <div>
          <p className="runs__label">Memory</p>
          <h1>记忆管理</h1>
          <p className="memory__sub">
            记忆会注入后续每一次 AI 调用；删除后不再注入，停用则先留着不生效。
          </p>
        </div>
        <span className="runs__grow" />
        <label className="runs__search memory__search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索 key、内容或标签"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search.onEnter();
            }}
          />
        </label>
      </header>

      <div className="memory__scopes" role="group" aria-label="作用域">
        {SCOPES.map((entry) => (
          <button
            key={entry.label}
            type="button"
            className="runs__chip"
            data-active={scope === entry.key ? 'true' : undefined}
            onClick={() => {
              setScope(entry.key);
              // 换条件时回第一页：停在第 3 页时切作用域，
              // 筛完可能一条都没有，而用户以为是「这个作用域没有记忆」
              void load(entry.key, search.value, 0);
            }}
          >
            {entry.label}
          </button>
        ))}
        <span className="runs__grow" />
        {/* 显示**总数**而不是这一页的行数：后者永远是 50，
            而用户会以为库里就这么多 */}
        <span className="memory__count">{total} 条</span>
      </div>

      <div className="memory__body">
        {error ? (
          <p className="runs__error" role="alert">
            {error}
          </p>
        ) : null}

        {proposals.length > 0 ? (
          <section className="memory__proposals" aria-label="AI 提议写入">
            <p className="memory__proposals-head">
              <i className="ph ph-sparkle" aria-hidden="true" />
              <span>AI 提议写入</span>
              <span className="memory__proposals-note">确认后才保存，并注入后续调用</span>
            </p>
            {proposals.map((item) => (
              <div key={item.id} className="memory__proposal">
                <div className="memory__proposal-main">
                  <p className="memory__proposal-key">
                    <span className="memory__key">{item.key}</span>
                    <span className="memory__scope-tag">
                      {SCOPE_LABELS[item.scope] ?? item.scope}
                    </span>
                  </p>
                  <p className="memory__proposal-value">{item.value}</p>
                  <p className="memory__proposal-by">来源 {item.createdBy}</p>
                </div>
                <button type="button" className="runs__action" onClick={() => void dismiss(item)}>
                  忽略
                </button>
                <button
                  type="button"
                  className="runs__action runs__action--primary"
                  onClick={() => void accept(item)}
                >
                  采纳并保存
                </button>
              </div>
            ))}
          </section>
        ) : null}

        <div className="memory__table">
          <div className="memory__row memory__row--head">
            <span>Key</span>
            <span>内容与来源</span>
            <span>更新 / 标签</span>
            <span className="memory__actions-head">操作</span>
          </div>

          {items !== null && saved.length === 0 ? (
            <p className="runs__empty">
              还没有记忆。AI 在运行结束时会提议值得长期记住的事实，你确认后才会写进来。
            </p>
          ) : null}

          {saved.map((item) => (
            <div key={item.id} className="memory__row" data-enabled={item.enabled}>
              <div>
                <p className="memory__key">{item.key}</p>
                <p className="memory__state">
                  <span className="memory__scope-tag">
                    {SCOPE_LABELS[item.scope] ?? item.scope}
                  </span>
                  {item.enabled ? null : <span className="memory__off">已停用</span>}
                  {isExpired(item) ? <span className="memory__off">已过期</span> : null}
                </p>
              </div>
              <div>
                <p className="memory__value">{item.value}</p>
                <p className="memory__meta">
                  {item.source === 'ai_proposed' ? 'AI 提议' : item.createdBy} · v{item.ver}
                </p>
              </div>
              <div>
                <p className="memory__updated">{formatTime(item.updatedAt)}</p>
                <p className="memory__tags">{item.tags.join(' · ')}</p>
              </div>
              <div className="memory__actions">
                <button
                  type="button"
                  aria-label={item.enabled ? `停用 ${item.key}` : `启用 ${item.key}`}
                  onClick={() => {
                    // 点别的动作就把那个红按钮收回去，别让它一直悬着
                    setConfirmDelete(null);
                    void toggle(item);
                  }}
                >
                  <i className="ph ph-power" aria-hidden="true" />
                </button>
                {/* 删除要按两次，与模型、Agent、提示词三页一致。
                    记忆是用户攒出来的长期上下文，误删之后没有回收站 */}
                {confirmDelete === item.id ? (
                  <button
                    type="button"
                    className="memory__confirm-delete"
                    aria-label={`确认删除 ${item.key}`}
                    onClick={() => void remove(item)}
                  >
                    确认删除
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`删除 ${item.key}`}
                    onClick={() => setConfirmDelete(item.id)}
                  >
                    <i className="ph ph-trash" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <Pager
          total={total}
          offset={offset}
          pageSize={LIST_PAGE_SIZE}
          onChange={(next) => void load(scope, search.value, next)}
        />

        <p className="memory__foot">
          <i className="ph ph-shield-check" aria-hidden="true" />
          Token、密钥和敏感文件内容禁止写入记忆 · 删除后不再注入未来调用 · MCP 需 memory:read /
          memory:write 权限
        </p>
      </div>
    </article>
  );
}

function isExpired(memory: Memory): boolean {
  if (!memory.expiresAt) return false;
  const at = new Date(memory.expiresAt);
  return !Number.isNaN(at.getTime()) && at.getTime() < Date.now();
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}
