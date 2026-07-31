import { useEffect, useLayoutEffect, useState } from 'react';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { LIST_PAGE_SIZE } from '@aiwf/contracts';
import { describeError } from '../data/describeError.js';
import { SplitPane } from '../layout/SplitPane.js';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';
import { ListEmpty } from '../layout/ListEmpty.js';
import { useFocusOnce } from '../hooks/useFocusOnce.js';
import { CopyButton } from '../layout/CopyButton.js';

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
  // 输入即搜（300ms 防抖），回车立刻搜 —— 与其余五个列表页同一套交互。
  // 搜索发给后端：前端过滤只能过滤已加载的那些
  // 搜索必须回第一页：停在第 3 页时搜索，结果不足 100 条就是一片空白，
  // 用户会以为「没有这条提示词」。另两页都显式写了 load(0, query)。
  const search = useDebouncedSearch((next) => void load(0, next));
  const [items, setItems] = useState<Prompt[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('template');
  /** 搜索词由 useDebouncedSearch 持有 —— 见下面的 search。 */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 进入确认态时把焦点接过来 —— 原来的按钮已经被移除，焦点会掉回 body */
  const focusConfirm = useFocusOnce();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 满足条件的总条数与当前页起点。后端早就分页了，缺的是界面这一层。 */
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  /**
   * 编辑中的分段。null 表示「没动过」。
   *
   * 分段是有序数组而不是一整块文本，正是为了只改其中一段而不动其余 ——
   * 所以这里存整个数组的副本，改哪段替换哪段。
   */
  const [sections, setSections] = useState<Section[] | null>(null);
  /**
   * 有未保存改动时要拦下切换 —— 与 Agent 页同一道守卫。
   *
   * `sections` 不是 null 就说明用户动过正文；切走时 `setSections(null)`
   * 会直接把它丢掉，而这一屏的保存是显式的（按钮叫「保存新版本」）。
   */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const hasUnsaved = sections !== null;

  const goTo = (id: string) => {
    if (hasUnsaved) {
      // 点的就是当前这条:什么都不做 —— 第一版在这里把 sections 置空,
      // 未保存的改动被静默丢弃,而警告横幅还挂着(第 4 轮实测 #5)
      if (id === selectedId) return;
      setPendingSelect(id);
      return;
    }
    setSelectedId(id);
    setConfirmDelete(false);
    setCreating(false);
    setSections(null);
    setTab('template');
  };

  /**
   * 参数顺序与另两页统一成 (offset, query)，query 默认取当前搜索框。
   * 之前这一页是 (search, offset) —— 顺序相反，读代码时极易记反。
   */
  const load = async (nextOffset = offset, query: string | undefined = search.value) => {
    setOffset(nextOffset);
    try {
      const result = (await coreClient.call('prompt.list', {
        ...(query ? { query } : {}),
        limit: LIST_PAGE_SIZE,
        offset: nextOffset,
      })) as { items: Prompt[]; total: number };
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(describeError(err));
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
      // 改动已经落地，那条警告要跟着收
      setPendingSelect(null);
      setSections(null);
      setError(null);
      await load();
    } catch (err) {
      setError(describeError(err));
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
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const onDuplicate = async () => {
    if (!selected) return;
    try {
      await coreClient.call('prompt.duplicate', {
        id: selected.id,
        name: `${selected.name} 副本`,
      });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    try {
      await coreClient.call('prompt.delete', { id: selected.id });
      setSelectedId(null);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      setError(describeError(err));
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
            aria-label="搜索提示词"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search.onEnter();
            }}
          />
        </label>

        <div className="prompts__list-body">
          {items !== null && items.length === 0 ? (
            <ListEmpty query={search.value} noun="提示词" onClear={() => search.onChange('')}>
              还没有提示词。系统调用 AI 的每一处都会在这里留下一条，可见也可改。
            </ListEmpty>
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
                  onClick={() => goTo(prompt.id)}
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

        <Pager
          total={total}
          pageSize={LIST_PAGE_SIZE}
          offset={offset}
          onChange={(next) => void load(next)}
        />

        <p className="models__foot">
          AI 节点在配置里选了「提示词」的，运行时用库里那份做框架；
          没选的用内建框架。每次运行用了哪一版，看运行记录的 system.prompt_resolved 事件。
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
                  {selected.group} · v{selected.ver} ·{' '}
                  <code className="agents__id">{selected.id}</code>
                  <CopyButton value={selected.id} label="" ariaLabel="复制提示词 id" className="env__copy" />
                </p>
              </div>
              <span className="runs__grow" />
              <button type="button" className="runs__action" onClick={() => void onDuplicate()}>
                <i className="ph ph-copy" aria-hidden="true" />
                复制
              </button>
              {selected.builtin ? null : confirmDelete ? (
                /*
                 * 确认按钮**不能长在原位**：原位替换时用户双击「删除」的第二下
                 * 就落在「确认删除」上 —— 他以为自己双击了一个按钮，数据已经没了。
                 * 原位留给「取消」，确认排在它后面。
                 */
                <>
                  <button
                    type="button"
                    className="runs__action"
                    /*
                     * 「删除」这个 DOM 节点被换掉时焦点会掉回 body ——
                     * 键盘用户按 Enter 触发确认态之后，下一次 Tab 从整页
                     * 开头重新走。把焦点接过来，且只接一次
                     * （内联的 `(el) => el?.focus()` 会在每次重渲染时重新抢）。
                     */
                    ref={focusConfirm}
                    onClick={() => setConfirmDelete(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="runs__action"
                    data-danger="true"
                    onClick={() => void onDelete()}
                  >
                    确认删除
                  </button>
                </>
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
                /*
                 * 内置提示词点下去必然弹「不能直接改」—— 那句话该长在按钮上，
                 * 而不是等用户改完一大段正文、点了保存才说
                 */
                disabled={selected.builtin}
                title={
                  selected.builtin
                    ? '内置提示词不能直接改 —— 先「复制」一份，副本是可编辑的'
                    : undefined
                }
                onClick={() => void onSave()}
              >
                保存新版本
              </button>
            </header>

            {pendingSelect ? (
              <p className="models__warn" role="alert">
                这条提示词有未保存的改动。切到另一条会把它们丢掉。
                <button
                  type="button"
                  className="runs__action"
                  onClick={() => setPendingSelect(null)}
                >
                  留在这里
                </button>
                <button
                  type="button"
                  className="runs__action"
                  data-danger="true"
                  onClick={() => {
                    const id = pendingSelect;
                    setPendingSelect(null);
                    setSections(null);
                    setConfirmDelete(false);
                    setCreating(false);
                    setTab('template');
                    setSelectedId(id);
                  }}
                >
                  放弃改动并切换
                </button>
              </p>
            ) : null}

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
                  id={`prompts-tab-${entry.key}`}
                  aria-selected={tab === entry.key}
                  aria-controls="prompts-panel"
                  // roving tabindex：未选中的退出 Tab 序列，键盘用左右键切换
                  tabIndex={tab === entry.key ? 0 : -1}
                  className="prompts__tab"
                  onClick={() => setTab(entry.key)}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                    if (delta === 0) return;
                    event.preventDefault();
                    const keys = TABS.map((t) => t.key);
                    const index = keys.indexOf(entry.key); // 从焦点所在的按钮出发，不是从当前选中项 ——
                    // roving tabindex 下焦点与选中经常不在同一项
                    const next = keys[(index + delta + keys.length) % keys.length];
                    if (next) {
                      setTab(next);
                      document.getElementById(`prompts-tab-${next}`)?.focus();
                    }
                  }}
                >
                  {entry.label}
                </button>
              ))}
              <span className="runs__grow" />
              <span className="prompts__hint">
                {/* 内置条目整页只读 —— 说「可改」是撒谎（第 1 轮实测：0 个可编辑控件） */}
                {selected.builtin
                  ? '内置分段只读，要改先「复制」一份 —— 副本可在节点配置里选用'
                  : '分段可改 · 保存新版本后，选了这条提示词的节点下次运行即生效'}
              </span>
            </div>

            <div
              className="prompts__body"
              id="prompts-panel"
              role="tabpanel"
              aria-labelledby={`prompts-tab-${tab}`}
            >
              {tab === 'template' ? (
                <TemplateTab
                  sections={sections ?? selected.sections}
                  readOnly={selected.builtin}
                  onChange={setSections}
                />
              ) : null}
              {/* 变量以**编辑中的正文**为准：用户刚写进去的占位符
                  也要立刻出现在表里 */}
              {tab === 'vars' ? (
                <VarsTab vars={selected.vars} sections={sections ?? selected.sections} />
              ) : null}
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

/** 「插入变量」插进去的写法。用户由此学会占位符长什么样。 */
const VAR_PLACEHOLDER = '${input.}';

function TemplateTab({
  sections,
  readOnly,
  onChange,
}: {
  sections: readonly Section[];
  readOnly: boolean;
  onChange: (next: Section[]) => void;
}) {
  /** 正在添加的新分段的标题；null 表示没在添加。 */
  const [adding, setAdding] = useState<string | null>(null);
  /** 插入变量之后要把光标放回哪里。见 insertVar 的说明。 */
  const [pendingCaret, setPendingCaret] = useState<{ title: string; at: number } | null>(null);

  useLayoutEffect(() => {
    if (!pendingCaret) return;
    const box = document.getElementById(`section-${pendingCaret.title}`);
    if (box instanceof HTMLTextAreaElement) {
      box.focus();
      box.setSelectionRange(pendingCaret.at, pendingCaret.at);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  const insertVar = (index: number) => {
    const section = sections[index];
    if (!section) return;
    const next = [...sections];
    next[index] = { title: section.title, body: `${section.body}${VAR_PLACEHOLDER}` };
    onChange(next);

    // 焦点与光标一起交回正文，光标停在 `${input.` 和 `}` 之间。
    //
    // 不交的话焦点留在按钮上，用户紧接着打的字进不了正文 ——
    // 他得再点回文本框、自己把光标挪到花括号里。
    // 插入的价值就在于「接着往下打」，少了这一步它只是个贴字符串的按钮。
    //
    // 记下要把光标放哪儿，等这次渲染把新 value 写进 DOM 之后再设 ——
    // 现在设的话会被随后的渲染覆盖掉
    setPendingCaret({
      title: section.title,
      at: section.body.length + VAR_PLACEHOLDER.length - 1,
    });
  };

  return (
    <div className="prompts__sections">
      {sections.map((section, index) => (
        <div key={section.title}>
          <p className="prompts__section-head">
            <label className="runs__label" htmlFor={`section-${section.title}`}>
              {section.title}
            </label>
            {readOnly ? null : (
              <>
                <span className="runs__grow" />
                {/* 图纸每段标题右边都有它。变量表没有「添加」按钮 ——
                    变量是写在正文里的占位符，这个按钮就是教语法的地方 */}
                <button
                  type="button"
                  className="prompts__insert-var"
                  onClick={() => insertVar(index)}
                >
                  插入变量
                </button>
              </>
            )}
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

      {readOnly ? null : adding === null ? (
        <button type="button" className="prompts__add-section" onClick={() => setAdding('')}>
          <i className="ph ph-plus" aria-hidden="true" />
          添加分段（Examples / 失败处理 / 语言风格…）
        </button>
      ) : (
        <form
          className="prompts__add-section-form"
          onSubmit={(event) => {
            event.preventDefault();
            const title = adding.trim();
            // 同名分段会让 key 撞车，也会让「Role」这种标题出现两次
            if (!title || sections.some((s) => s.title === title)) return;
            onChange([...sections, { title, body: '' }]);
            setAdding(null);
          }}
        >
          <input
            aria-label="新分段的标题"
            value={adding}
            placeholder="Examples"
            onChange={(event) => setAdding(event.target.value)}
          />
          <button type="submit" className="runs__action runs__action--primary">
            添加
          </button>
          <button type="button" className="runs__action" onClick={() => setAdding(null)}>
            取消
          </button>
        </form>
      )}
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

/** 从正文里认出 `${…}` 占位符。同一个出现多次只算一次，保持出现顺序。 */
function extractVars(sections: readonly Section[]): string[] {
  const found: string[] = [];
  for (const section of sections) {
    for (const match of section.body.matchAll(/\$\{[^}\s]+\}/gu)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  }
  return found;
}

/**
 * 变量表 —— 图纸「06 提示词库」的变量页。
 *
 * 图纸这张表**没有「添加」按钮**：变量是写在正文里的占位符，
 * 表格只是把它们列出来说明各自从哪来。所以这里以正文为准 ——
 * 只显示后端存的那份的话，用户在正文里写了 `${input.repo}` 也不会出现，
 * 于是「0 变量」和正文里明明有的占位符对不上。
 */
function VarsTab({ vars, sections }: { vars: readonly PromptVar[]; sections: readonly Section[] }) {
  const inBody = extractVars(sections);
  const known = new Map(vars.map((item) => [item.name, item]));
  // 正文里的排前面（那是实际会被替换的），存过但正文里没有的跟在后面
  const names = [...inBody, ...vars.map((v) => v.name).filter((n) => !inBody.includes(n))];

  return (
    <div className="prompts__vars">
      <div className="prompts__vars-head">
        <span>变量</span>
        <span>运行时来源</span>
        <span>缺失时</span>
      </div>
      {names.map((name) => {
        const item = known.get(name);
        return (
          <div key={name} className="prompts__vars-row">
            <span className="prompts__var-name">{name}</span>
            <span>
              {item?.source ?? '未登记'}
              {inBody.includes(name) ? null : (
                // 存过但正文里没有：多半是改正文时把它删掉了，
                // 而运行时那份仍然会被当成「这条提示词需要的输入」
                <span className="prompts__var-unused">正文里没用到</span>
              )}
            </span>
            <span>{ON_MISSING_LABELS[item?.onMissing ?? 'empty_and_log'] ?? '留空并记录'}</span>
          </div>
        );
      })}
      {names.length === 0 ? (
        <p className="runs__empty">
          还没有变量。在分段正文里写 <code>{VAR_PLACEHOLDER}</code>{' '}
          这样的占位符，或点分段标题旁的「插入变量」。
        </p>
      ) : null}
      <p className="prompts__vars-foot">Secret 只能以引用形式出现，预览与日志中永不展开明文。</p>
    </div>
  );
}

function PreviewTab() {
  // 图纸的预览是「用某次运行的真实上下文替换变量」。执行路径已通
  // (B-3),但预览还没接运行数据 —— 不放假的替换结果,
  // 一份看起来像真的、其实是编的预览,比没有预览更糟。
  // 「AI 节点跑过一次后这里会显示」那句老文案已被实测证伪(第 4 轮 #7):
  // 跑过之后这里依然是空的,承诺没兑现就别挂着
  return (
    <p className="runs__empty">
      这里还不能预览替换后的提示词。想看某次运行实际发出的完整提示词,
      去「执行记录」打开那次运行的产物 prompt.md —— 那是真发出去的字节。
    </p>
  );
}

interface PromptVersion {
  ver: number;
  name: string;
  changedBy: string;
  createdAt: string;
}

/**
 * 版本页 —— 图纸「06 提示词库」：v4 · 当前 / v3 / v2，每条带时间与改的人。
 *
 * 只显示当前版本的话，这一页底部那句「运行记录会引用当时的提示词版本，
 * 历史结果始终可解释」就是空的 —— 历史根本看不到。
 */
function VersionsTab({ prompt }: { prompt: Prompt }) {
  const [history, setHistory] = useState<PromptVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError(null);
    coreClient
      .call('prompt.versions', { promptId: prompt.id })
      .then((result) => {
        if (!cancelled) setHistory((result as { items: PromptVersion[] }).items);
      })
      .catch((err: unknown) => {
        // 当前版本照旧显示，报错单独说 —— 取不到历史不该让整页空白
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // 依赖里带上 ver：保存新版本之后 id 不变而 ver 变了，
    // 只依赖 id 的话历史不会重拉 —— 用户看到的还是保存前那份
    //（那时它确实只有当前版本），于是「保存新版本」像是没生效
  }, [prompt.id, prompt.ver]);

  return (
    <div className="prompts__versions">
      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="prompts__version-list">
        <li className="prompts__version prompts__version--current">
          <span className="prompts__version-row">
            <span className="prompts__version-name">v{prompt.ver} · 当前</span>
            <span className="runs__grow" />
            <span className="prompts__version-when">{formatTime(prompt.updatedAt)}</span>
          </span>
        </li>
        {(history ?? []).map((item) => (
          <li key={item.ver} className="prompts__version">
            <span className="prompts__version-row">
              <span className="prompts__version-name">v{item.ver}</span>
              <span className="runs__grow" />
              <span className="prompts__version-when">
                {formatTime(item.createdAt)} · {item.changedBy}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {history !== null && history.length === 0 ? (
        <p className="runs__empty">还没有改过。保存新版本之后，被替换掉的那份会留在这里。</p>
      ) : null}

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
