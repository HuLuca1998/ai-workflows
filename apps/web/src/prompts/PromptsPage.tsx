import { useEffect, useState } from 'react';
import { SplitPane } from '../layout/SplitPane.js';
import { coreClient } from '../data/workspace.js';

/**
 * 提示词库 —— 严格照图纸「06 提示词库」：266px 左栏 + 详情四个 tab。
 *
 * 四条产品规则在这一屏兑现：
 *
 * 1. **系统调用 AI 的每一处都在这里**。内置条目不能删 ——
 *    删掉就意味着某处调用没有提示词可用，而那处调用不会因此消失。
 * 2. **框架分段可见可改**。分段是有序数组（Role / Task / Context /
 *    Constraints / Output contract），不是一整块文本 ——
 *    可分段才能只改其中一段而不动其余。
 * 3. **Secret 只以引用形式出现**。变量表里写明这一点，
 *    预览也不展开 —— 展开一次就会进截图、进日志。
 * 4. **运行记录引用具体版本**。保存是「保存新版本」，版本号只增不改，
 *    历史结果才解释得清。
 */

interface Section {
  title: string;
  body: string;
}

interface PromptVar {
  name: string;
  source: string;
  onMissing: string;
  default?: string;
}

interface Prompt {
  id: string;
  group: string;
  name: string;
  sections: Section[];
  vars: PromptVar[];
  ver: number;
  builtin: boolean;
  updatedAt: string;
}

type Tab = 'template' | 'vars' | 'preview' | 'versions';

const TABS: { key: Tab; label: string }[] = [
  { key: 'template', label: '模板' },
  { key: 'vars', label: '变量' },
  { key: 'preview', label: '预览' },
  { key: 'versions', label: '版本' },
];

/** 变量缺失时的行为，照图纸的文案。 */
const ON_MISSING_LABELS: Record<string, string> = {
  empty_and_log: '留空并记录',
  fail: '直接失败',
  default: '用默认值',
};

export function PromptsPage() {
  const [items, setItems] = useState<Prompt[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('template');
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 编辑中的分段。null 表示「没动过」。
   *
   * 分段是有序数组而不是一整块文本，正是为了只改其中一段而不动其余 ——
   * 所以这里存整个数组的副本，改哪段替换哪段。
   */
  const [sections, setSections] = useState<Section[] | null>(null);

  const load = async (search?: string) => {
    try {
      const result = (await coreClient.call('prompt.list', search ? { query: search } : {})) as {
        items: Prompt[];
      };
      setItems(result.items);
    } catch (err) {
      setError(describe(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selected = items?.find((prompt) => prompt.id === selectedId) ?? null;
  const grouped = groupBy(items ?? []);

  const onSave = async () => {
    if (!selected) return;
    if (selected.builtin) {
      setError('内置提示词不能直接改 —— 先「复制」一份，副本是可编辑的。');
      return;
    }
    if (sections === null) {
      setError('没有改动可保存。');
      return;
    }

    try {
      // ver 是乐观锁：后端靠它判断这次改动基于哪一版，
      // 少发的话契约层直接拒，而错误信息说不清是哪个字段
      await coreClient.call('prompt.update', { id: selected.id, ver: selected.ver, sections });
      setSections(null);
      setError(null);
      await load(query);
    } catch (err) {
      setError(describe(err));
    }
  };

  const onCreate = async (input: { group: string; name: string }) => {
    try {
      const result = (await coreClient.call('prompt.create', {
        ...input,
        // 图纸的框架分段就是这五段，新建时把骨架给出来 ——
        // 让用户对着空白想「该写哪几段」是最没必要的一道坎
        sections: [
          { title: 'Role', body: '' },
          { title: 'Task', body: '' },
          { title: 'Context', body: '' },
          { title: 'Constraints', body: '' },
          { title: 'Output contract', body: '' },
        ],
        vars: [],
      })) as { id: string };
      setCreating(false);
      setSelectedId(result.id);
      setTab('template');
      await load(query);
    } catch (err) {
      setError(describe(err));
    }
  };

  const onDuplicate = async () => {
    if (!selected) return;
    try {
      await coreClient.call('prompt.duplicate', {
        id: selected.id,
        name: `${selected.name} 副本`,
      });
      await load(query);
    } catch (err) {
      setError(describe(err));
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    try {
      await coreClient.call('prompt.delete', { id: selected.id });
      setSelectedId(null);
      setConfirmDelete(false);
      await load(query);
    } catch (err) {
      setError(describe(err));
    }
  };

  return (
    <SplitPane className="prompts" storageKey="prompts.listWidth" defaultWidth={266}>
      <aside className="prompts__list">
        <div className="prompts__list-head">
          <span className="runs__label">提示词库</span>
          <span className="runs__grow" />
          <button
            type="button"
            className="models__add"
            aria-label="新建提示词"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
              setSections(null);
            }}
          >
            <i className="ph ph-plus" aria-hidden="true" />
          </button>
        </div>

        <label className="runs__search prompts__search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索名称、变量或正文"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // 搜索发给后端：前端过滤只能过滤已加载的那些
              if (event.key === 'Enter') void load(query);
            }}
          />
        </label>

        <div className="prompts__list-body">
          {items !== null && items.length === 0 ? (
            <p className="runs__empty">
              还没有提示词。系统调用 AI 的每一处都会在这里留下一条，可见也可改。
            </p>
          ) : null}

          {grouped.map(([group, prompts]) => (
            <div key={group}>
              <p className="models__group">
                <span>{group}</span>
                <span className="runs__grow" />
                <span>{prompts.length}</span>
              </p>
              {prompts.map((prompt) => (
                <button
                  key={prompt.id}
                  type="button"
                  className="prompts__item"
                  data-selected={prompt.id === selectedId ? 'true' : undefined}
                  onClick={() => {
                    setSelectedId(prompt.id);
                    setConfirmDelete(false);
                    setCreating(false);
                    setSections(null);
                    setTab('template');
                  }}
                >
                  <span className="prompts__item-name">{prompt.name}</span>
                  <span className="prompts__item-meta">
                    {prompt.sections.length} 段 · {prompt.vars.length} 变量
                  </span>
                  <span className="prompts__item-ver">
                    {prompt.builtin ? '内置' : ''} v{prompt.ver}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <p className="models__foot">
          系统调用 AI 的每一处都在这里：节点、⌘K 协作、记忆提议、通知与失败归因。
        </p>
      </aside>

      <section className="prompts__detail" aria-label="提示词详情">
        {error ? (
          <p className="runs__error" role="alert">
            {error}
          </p>
        ) : null}

        {creating ? (
          <PromptForm
            groups={[...new Set((items ?? []).map((p) => p.group))]}
            onCancel={() => setCreating(false)}
            onSubmit={onCreate}
          />
        ) : selected ? (
          <>
            <header className="prompts__detail-head">
              <div>
                <h4>{selected.name}</h4>
                <p className="models__detail-sub">
                  {selected.group} · v{selected.ver}
                </p>
              </div>
              <span className="runs__grow" />
              <button type="button" className="runs__action" onClick={() => void onDuplicate()}>
                <i className="ph ph-copy" aria-hidden="true" />
                复制
              </button>
              {selected.builtin ? null : confirmDelete ? (
                <button type="button" className="runs__action" onClick={() => void onDelete()}>
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  className="runs__action"
                  onClick={() => setConfirmDelete(true)}
                >
                  删除
                </button>
              )}
              <button
                type="button"
                className="runs__action runs__action--primary"
                onClick={() => void onSave()}
              >
                保存新版本
              </button>
            </header>

            {selected.builtin ? (
              <p className="models__warn" role="status">
                内置提示词不能删除 —— 删掉就意味着某处 AI 调用没有提示词可用。 要改的话先复制一份。
              </p>
            ) : null}

            <div className="prompts__tabs" role="tablist" aria-label="提示词视图">
              {TABS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.key}
                  className="prompts__tab"
                  onClick={() => setTab(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
              <span className="runs__grow" />
              <span className="prompts__hint">框架分段可见可改 · 保存后新运行生效</span>
            </div>

            <div className="prompts__body" role="tabpanel">
              {tab === 'template' ? (
                <TemplateTab
                  sections={sections ?? selected.sections}
                  readOnly={selected.builtin}
                  onChange={setSections}
                />
              ) : null}
              {tab === 'vars' ? <VarsTab vars={selected.vars} /> : null}
              {tab === 'preview' ? <PreviewTab /> : null}
              {tab === 'versions' ? <VersionsTab prompt={selected} /> : null}
            </div>
          </>
        ) : (
          <p className="runs__empty runs__empty--center">选一条提示词查看它的分段与变量。</p>
        )}
      </section>
    </SplitPane>
  );
}

function TemplateTab({
  sections,
  readOnly,
  onChange,
}: {
  sections: readonly Section[];
  readOnly: boolean;
  onChange: (next: Section[]) => void;
}) {
  return (
    <div className="prompts__sections">
      {sections.map((section, index) => (
        <div key={section.title}>
          <p className="prompts__section-head">
            <label className="runs__label" htmlFor={`section-${section.title}`}>
              {section.title}
            </label>
          </p>
          {readOnly ? (
            // 内置条目只读：改它等于改掉系统某处调用的行为，而那处调用别人也在用。
            // 复制一份是有意的一步 —— 副本归用户，改坏了也只影响自己
            <pre className="prompts__section-body">{section.body}</pre>
          ) : (
            <textarea
              id={`section-${section.title}`}
              className="prompts__section-body prompts__section-body--edit"
              value={section.body}
              rows={Math.max(3, section.body.split('\n').length + 1)}
              onChange={(event) => {
                const next = [...sections];
                next[index] = { title: section.title, body: event.target.value };
                onChange(next);
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 新建提示词表单。
 *
 * 分组是自由文本但给出已有的作为建议 —— 逼用户从固定枚举里选，
 * 新场景就没地方放；完全自由又会让同一类提示词散在三个名字略不同的组里。
 */
function PromptForm({
  groups,
  onSubmit,
  onCancel,
}: {
  groups: string[];
  onSubmit: (input: { group: string; name: string }) => void;
  onCancel: () => void;
}) {
  const [group, setGroup] = useState(groups[0] ?? '');
  const [name, setName] = useState('');
  const ready = group.trim() !== '' && name.trim() !== '';

  return (
    <form
      className="models__form"
      aria-label="新建提示词"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit({ group: group.trim(), name: name.trim() });
      }}
    >
      <h4>新建提示词</h4>

      <label className="models__field">
        <span>分组</span>
        <input list="prompt-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
        <datalist id="prompt-groups">
          {groups.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </label>

      <label className="models__field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <p className="models__note">
        会按框架分段建出骨架：Role / Task / Context / Constraints / Output contract。
      </p>

      <div className="models__form-actions">
        <button type="button" className="runs__action" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="runs__action runs__action--primary" disabled={!ready}>
          创建
        </button>
      </div>
    </form>
  );
}

function VarsTab({ vars }: { vars: readonly PromptVar[] }) {
  return (
    <div className="prompts__vars">
      <div className="prompts__vars-head">
        <span>变量</span>
        <span>运行时来源</span>
        <span>缺失时</span>
      </div>
      {vars.map((item) => (
        <div key={item.name} className="prompts__vars-row">
          <span className="prompts__var-name">{item.name}</span>
          <span>{item.source}</span>
          <span>{ON_MISSING_LABELS[item.onMissing] ?? item.onMissing}</span>
        </div>
      ))}
      <p className="prompts__vars-foot">Secret 只能以引用形式出现，预览与日志中永不展开明文。</p>
    </div>
  );
}

function PreviewTab() {
  // 图纸的预览是「用某次运行的真实上下文替换变量」，
  // 那需要 AI 节点跑过一次（M3 接 ACP 之后）。在此之前不放假的替换结果 ——
  // 一份看起来像真的、其实是编的预览，比没有预览更糟
  return (
    <p className="runs__empty">
      预览要用一次真实运行的上下文替换变量。等 AI 节点接上 ACP 并跑过一次后，
      这里会显示替换后的完整提示词与 token 估算。
    </p>
  );
}

function VersionsTab({ prompt }: { prompt: Prompt }) {
  return (
    <div className="prompts__versions">
      <div className="prompts__version prompts__version--current">
        <span className="prompts__version-row">
          <span className="prompts__version-name">v{prompt.ver} · 当前</span>
          <span className="runs__grow" />
          <span className="prompts__version-when">{formatTime(prompt.updatedAt)}</span>
        </span>
      </div>
      <p className="agents__foot">
        <i className="ph ph-info" aria-hidden="true" />
        运行记录会引用当时的提示词版本，历史结果始终可解释。
      </p>
    </div>
  );
}

/** 按分组聚合，组内保持后端给的顺序（已按 group + name 排过）。 */
function groupBy(prompts: readonly Prompt[]): [string, Prompt[]][] {
  const groups = new Map<string, Prompt[]>();
  for (const prompt of prompts) {
    const bucket = groups.get(prompt.group) ?? [];
    bucket.push(prompt);
    groups.set(prompt.group, bucket);
  }
  return [...groups.entries()];
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
