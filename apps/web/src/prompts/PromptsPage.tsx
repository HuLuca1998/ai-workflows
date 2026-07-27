import { useEffect, useState } from 'react';
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
  const [error, setError] = useState<string | null>(null);

  const load = async (search?: string) => {
    try {
      const result = (await coreClient.call('prompt.list', {
        ...(search ? { query: search } : {}),
      })) as { items: Prompt[] };
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
    try {
      await coreClient.call('prompt.update', {
        id: selected.id,
        sections: selected.sections,
      });
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
    <div className="prompts">
      <aside className="prompts__list">
        <div className="prompts__list-head">
          <span className="runs__label">提示词库</span>
          <span className="runs__grow" />
          <button type="button" className="models__add" aria-label="新建提示词">
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

        {selected ? (
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
              {tab === 'template' ? <TemplateTab sections={selected.sections} /> : null}
              {tab === 'vars' ? <VarsTab vars={selected.vars} /> : null}
              {tab === 'preview' ? <PreviewTab /> : null}
              {tab === 'versions' ? <VersionsTab prompt={selected} /> : null}
            </div>
          </>
        ) : (
          <p className="runs__empty runs__empty--center">选一条提示词查看它的分段与变量。</p>
        )}
      </section>
    </div>
  );
}

function TemplateTab({ sections }: { sections: readonly Section[] }) {
  return (
    <div className="prompts__sections">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="prompts__section-head">
            <span className="runs__label">{section.title}</span>
          </p>
          <pre className="prompts__section-body">{section.body}</pre>
        </div>
      ))}
    </div>
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
