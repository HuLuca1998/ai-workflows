import { useEffect, useState } from 'react';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { describeError } from '../data/describeError.js';
import { LIST_PAGE_SIZE } from '@aiwf/contracts';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';
import { ListEmpty } from '../layout/ListEmpty.js';
import { RichText } from '@aiwf/ui';

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
  /** 丢弃提议同样不可撤销 —— 记住是哪一条，别让确认态跨条目残留 */
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  /**
   * 正在编写的那一条。
   *
   * 这一屏此前只能停用与删除 —— 契约里 memory.create / memory.update 都在，
   * MCP 也开着它们：用户能让 AI 间接写入，却不能自己写一条
   * 「构建命令是 pnpm verify」。一屏叫「管理」的页面只提供删除，
   * 是把能力锁在了界面外面。
   */
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);

  /**
   * 拉一页记忆。
   *
   * **必须带 limit/offset**：不带就只拿到后端默认的第一页，
   * 而顶部那句「N 条」如果显示 items.length，无论库里有多少
   * 都永远是 50 —— 用户拿不到第 51 条，也不知道自己拿不到。
   */
  const load = async (nextScope = scope, nextQuery = '', nextOffset = offset) => {
    // 任何成功的重新加载都清掉旧错误 —— 「缺少参数」横幅曾在成功的
    // 停用/启用之后仍然挂着,成功的操作看上去也像失败了(第 4 轮 #12)
    setError(null);
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

  const save = async (input: { key: string; value: string; scope: string }) => {
    try {
      if (editing === 'new') {
        await coreClient.call('memory.create', {
          scope: input.scope,
          key: input.key,
          value: input.value,
          // 契约要求的其余字段：来源与敏感度由界面这一层定死 ——
          // 用户手写的记忆一律 user / internal，密钥走 Keychain 不进这里
          source: 'user',
          createdBy: 'user',
          sensitivity: 'internal',
          tags: [],
          enabled: true,
        });
      } else if (editing) {
        // ver 是乐观锁：后端靠它判断这次改动基于哪一版
        await coreClient.call('memory.update', {
          id: editing.id,
          ver: editing.ver,
          value: input.value,
        });
      }
      setEditing(null);
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
        <button
          type="button"
          className="runs__action runs__action--primary"
          onClick={() => setEditing('new')}
        >
          <i className="ph ph-plus" aria-hidden="true" />
          新建记忆
        </button>
        <label className="runs__search memory__search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索 key、内容或标签"
            aria-label="搜索记忆"
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
            // 选中态不能只靠颜色（§7）：读屏用户听到六个平级按钮时，
            // 无从得知当前筛的是哪个作用域
            aria-pressed={scope === entry.key}
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

        {editing ? (
          <MemoryEditor
            memory={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        ) : null}

        {proposals.length > 0 ? (
          <section className="memory__proposals" aria-label="AI 提议写入">
            <p className="memory__proposals-head">
              <i className="ph ph-sparkle" aria-hidden="true" />
              <span>AI 提议写入</span>
              <span className="memory__proposals-note">
                确认后才保存，并注入后续调用；丢弃是直接删掉这条提议，没有回收站
              </span>
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
                {/*
                 * 原来这个按钮叫「忽略」，发的却是 memory.delete —— 永久删除。
                 * 后端没有「已忽略」这个状态（提议就是 ai_proposed && !enabled，
                 * 留着它就还在提议区），所以只能把话说实，不能编一个状态出来。
                 */}
                {confirmDismiss === item.id ? (
                  <>
                    <button
                      type="button"
                      className="runs__action"
                      onClick={() => setConfirmDismiss(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="runs__action"
                      data-danger="true"
                      onClick={() => void dismiss(item)}
                    >
                      确认丢弃
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="runs__action"
                    onClick={() => setConfirmDismiss(item.id)}
                  >
                    丢弃这条提议
                  </button>
                )}
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
            <ListEmpty query={search.value} noun="记忆" onClear={() => search.onChange('')}>
              还没有记忆。AI 在运行结束时会提议值得长期记住的事实，你确认后才会写进来。
            </ListEmpty>
          ) : null}

          {saved.map((item) => (
            <div key={item.id} className="memory__row" data-enabled={item.enabled}>
              <div>
                <p className="memory__key">{item.key}</p>
                <p className="memory__state">
                  <span className="memory__scope-tag">
                    {SCOPE_LABELS[item.scope] ?? item.scope}
                  </span>
                  {/*
                   * §2.3 点名成功色的出现位置里就有「记忆已启用」。
                   * 之前「正在生效」是靠**什么都不渲染**表达的，而「已停用」
                   * 反被红色高亮 —— 注意力被引向了不生效的那些。
                   */}
                  {item.enabled && !isExpired(item) ? (
                    <span className="memory__on">已启用</span>
                  ) : null}
                  {item.enabled ? null : <span className="memory__off">已停用</span>}
                  {isExpired(item) ? <span className="memory__expired">已过期</span> : null}
                </p>
              </div>
              <div>
                {/* 内置种子自己就带 markdown,裸文本会把 ** 原样亮出来(M7) */}
                <div className="memory__value">
                  <RichText text={item.value} />
                </div>
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
                  aria-label={`编辑 ${item.key}`}
                  onClick={() => {
                    setConfirmDelete(null);
                    setEditing(item);
                  }}
                >
                  <i className="ph ph-pencil-simple" aria-hidden="true" />
                </button>
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
                    // 进武装态自动聚焦,Esc 撤销 —— 此前只能刷新页面复位,
                    // 而键盘用户「Enter 两下」极易误删(第 8 轮实测 P1-6)
                    ref={(el) => el?.focus()}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setConfirmDelete(null);
                    }}
                    onBlur={() => setConfirmDelete(null)}
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
          sticky
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

/**
 * 写一条记忆。
 *
 * 新建与编辑共用这一个面板，差别只有两处：编辑时 key 与作用域不可改
 * （它们是这条记忆的身份，改了等于换一条），而 memory.update 也只收 value。
 */
function MemoryEditor({
  memory,
  onCancel,
  onSave,
}: {
  memory: Memory | null;
  onCancel: () => void;
  onSave: (input: { key: string; value: string; scope: string }) => void | Promise<void>;
}) {
  const [key, setKey] = useState(memory?.key ?? '');
  const [value, setValue] = useState(memory?.value ?? '');
  const [scope, setScope] = useState(memory?.scope ?? 'workspace');

  const ready = key.trim().length > 0 && value.trim().length > 0;

  return (
    <form
      className="memory__editor"
      aria-label={memory ? '编辑记忆' : '新建记忆'}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void onSave({ key: key.trim(), value: value.trim(), scope });
      }}
    >
      <label className="models__field">
        <span className="models__label">Key</span>
        <input
          type="text"
          value={key}
          // key 是这条记忆的身份，改了等于换一条 —— 而 memory.update 也只收 value
          readOnly={memory !== null}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <label className="models__field">
        <span className="models__label">作用域</span>
        <select
          value={scope}
          disabled={memory !== null}
          onChange={(event) => setScope(event.target.value)}
        >
          {SCOPES.filter((entry) => entry.key).map((entry) => (
            <option key={entry.key} value={entry.key as string}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <label className="models__field">
        <span className="models__label">内容</span>
        <textarea value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <p className="models__note">
        这条内容会注入后续每一次 AI 调用。Secret 不要写在这里 —— 它只进 Keychain， 在这里只以
        keychain:// 引用出现。
      </p>
      <div className="models__form-actions">
        <button type="button" className="runs__action" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="runs__action runs__action--primary" disabled={!ready}>
          保存
        </button>
      </div>
    </form>
  );
}
