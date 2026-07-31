import { useEffect, useState } from 'react';
import { describeError } from '../data/describeError.js';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { LIST_PAGE_LIMIT_MAX, LIST_PAGE_SIZE } from '@aiwf/contracts';
import type { AGENT_RUNTIMES } from '@aiwf/contracts';
import { SplitPane } from '../layout/SplitPane.js';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';
import { ListEmpty } from '../layout/ListEmpty.js';
import { useFocusOnce } from '../hooks/useFocusOnce.js';
import { CopyButton } from '../layout/CopyButton.js';

/**
 * Agent 角色 —— 严格照图纸「05 Agent 角色」：250px 左栏 + 详情区四块。
 *
 * 三条产品规则在这一屏兑现：
 *
 * 1. **角色是被引用的，不是被复制的**。节点存的是角色 id，
 *    所以角色升级后引用它的节点一并生效 —— 详情区的按钮叫「保存新版本」，
 *    版本号由存储层递增，运行记录才能说清当时用的是第几版。
 * 2. **权限由引擎强制**。这一块只是展示，真正的拦截在引擎里；
 *    界面要把这句话说出来，否则用户会以为改 Prompt 能绕过。
 * 3. **模型下拉只列已启用的**。过滤放在后端（enabledOnly），
 *    前端拿到全部再自己筛的话，某天忘了筛就漏出去了。
 */

interface Agent {
  id: string;
  name: string;
  role: string;
  goal: string;
  persona: string;
  runtime: string;
  modelRef: string;
  fallbackModelRef?: string;
  tools: string[];
  capabilities: Record<string, unknown>;
  outputContract: string;
  turnLimit: number;
  timeoutMs: number;
  ver: number;
  builtin: boolean;
}

interface ModelOption {
  id: string;
  name: string;
  /** 下拉按角色 runtime 过滤用 —— 跨 runtime 的引用引擎解析不了。 */
  runtime: string;
}

const RUNTIME_LABELS: Record<(typeof AGENT_RUNTIMES)[number], string> = {
  'acp.claude': 'Claude Code（ACP）',
  'acp.codex': 'Codex（ACP）',
};

/**
 * 权限项。键、取值都照契约的 `CapabilitiesSchema`。
 *
 * 图纸「05 Agent 角色」的权限块画的是纯展示（五行），
 * 但同一屏有「保存新版本」——详情区本来就是编辑区，原型只是画了
 *「配好之后长什么样」。不给入口的话，「引擎强制，Prompt 无法越权」
 * 这句就没有下文：引擎确实会拦，而用户无处声明允许什么。
 */
/**
 * 每一项**到底管到哪儿**，界面上直说。
 *
 * 引擎的 `check_capability` 从 `profile_for(node)` 取能力，
 * 而它只认 config 里的 `agentProfileId` —— 只有四个 AI 节点有这个字段。
 * 里面真正写了分支的又只有 `ai.execute`（file 与 command 各一条）。
 *
 * 所以「引擎强制，Prompt 无法越权」这句无条件写就是假的：
 * 脚本与 worktree 节点挂不上角色，用户把「命令」调成「不允许」，
 * 它们照跑（它们真正的关卡是权限档 —— 最严档下逐项审批）。
 * network 与 memory 则是引擎压根不读。
 *
 * 照 `NodeConfigDialog.tsx:269` 那个写法：说清楚，而不是让用户
 * 以为自己配了一道并不存在的防线。接上一项就改这里的 note。
 */
const CAPABILITY_FIELDS: {
  key: string;
  label: string;
  options: string[];
  note: string;
}[] = [
  {
    key: 'file',
    label: '文件',
    options: ['none', 'read', 'read-write'],
    note: '只在「AI 执行」节点上校验',
  },
  {
    key: 'command',
    label: '命令',
    options: ['none', 'declared', 'any'],
    note: '只在「AI 执行」节点上校验',
  },
  { key: 'network', label: '网络', options: ['none', 'allowlist', 'any'], note: '引擎暂不读它' },
  { key: 'memory', label: '记忆', options: ['none', 'read', 'read-write'], note: '引擎暂不读它' },
];

/** 取值的中文说法。存的是契约里那些英文 id。 */
const CAPABILITY_VALUE_LABELS: Record<string, string> = {
  none: '不允许',
  read: '只读',
  'read-write': '可读写',
  declared: '仅已声明的命令',
  any: '不限',
  allowlist: '白名单内',
};

/** 结构相同就算没改。对象与数组比不了引用 —— 每次渲染都是新的。 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 新建角色的默认能力档。
 *
 * 提交与乐观插入必须用同一份 —— 之前乐观行写的是 `{}`，
 * 而详情区取不到键就回落 'none'，于是刚建好的角色在安全设置上显示的是假值。
 */
const NEW_AGENT_CAPABILITIES = {
  file: 'read',
  command: 'none',
  network: 'none',
  // 读记忆：AI 节点靠注入的记忆才知道这个工作区的长期约定
  memory: 'read',
  secret: [],
} as const;

/** 「离开当前这一条」要去哪。用判别联合，不用字符串哨兵。 */
type GoTarget = { kind: 'new' } | { kind: 'agent'; id: string };

export function AgentsPage() {
  const [items, setItems] = useState<Agent[] | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 进入确认态时把焦点接过来 —— 原来的按钮已经被移除，焦点会掉回 body */
  const focusConfirm = useFocusOnce();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在输入的工具名；null 表示没在添加。 */
  const [addingTool, setAddingTool] = useState<string | null>(null);
  /** 搜索发给后端 —— 前端过滤只能过滤当前页。 */
  // 换条件时回第一页：停在第 3 页的话，搜完可能一条都没有，
  // 而用户以为是「没有这个角色」
  const search = useDebouncedSearch((query) => void load(0, query));
  /** 满足条件的总条数与当前页起点。后端早就分页了，缺的是界面这一层。 */
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  /**
   * 详情区的本地改动。
   *
   * 不直接改 items 里的对象：那样「改了但没保存」与「已保存」就分不出来了，
   * 而这一屏的保存是显式的（按钮叫「保存新版本」）。
   */
  const [draft, setDraft] = useState<Partial<Agent>>({});
  /*
   * 切走时要拦一下，所以「改了没有」这个判断有两个用处：保存与守卫。
   * 两份各写各的迟早会不一致 —— 那时按钮说「没有改动可保存」而守卫
   * 还在拦人，用户被卡在中间。
   */
  /*
   * 判别联合而不是 `string | 'new'` —— 后者在 TypeScript 里就是 string，
   * 而契约允许任意非空 Agent id：真有一条 id 叫 `new` 的角色时，
   * 点它会跳进新建表单。当前 Rust 存储生成 `agent_*`，撞不上，
   * 但这种「靠数据碰巧不冲突」的约定迟早会被另一个后端打破。
   */
  const [pendingSelect, setPendingSelect] = useState<GoTarget | null>(null);

  /**
   * query 默认取当前搜索框的内容。
   *
   * 之前是 `query?: string`，翻页写的是 `load(next)`、删除后写的是 `load()` ——
   * 两处都不传词，`...(query ? {query} : {})` 于是整段消失：用户搜「review」
   * 得到 60 条，点「下一页」立刻变成全部 120 条的第 51–100 条，
   * 而搜索框里还写着「review」，他会以为这些都匹配。
   */
  const load = async (nextOffset = offset, query: string | undefined = search.value) => {
    setOffset(nextOffset);
    try {
      const result = (await coreClient.call('agent.list', {
        // 搜索发给后端：前端过滤只能过滤当前页，而列表有一百多条
        ...(query ? { query } : {}),
        limit: LIST_PAGE_SIZE,
        offset: nextOffset,
      })) as { items: Agent[]; total: number };
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(describeError(err));
    }
  };

  useEffect(() => {
    void load();
    // 只要已启用的：过滤在后端做，前端不该拿到停用条目再自己筛
    void coreClient
      // 同 SupervisorDrawer：下拉要全量，不写 limit 会被默认分页截断
      .call('model.list', { enabledOnly: true, limit: LIST_PAGE_LIMIT_MAX })
      .then((result) => setModels((result as { items: ModelOption[] }).items))
      // 读失败也要落地成空数组：留在 null 的话表单会永远显示「正在读取」
      .catch(() => setModels([]));
  }, []);

  const selected = items?.find((agent) => agent.id === selectedId) ?? null;

  /** 相对当前选中项，草稿里真正改了的字段（不含 id/ver）。 */
  const changedFields = (): Record<string, unknown> => {
    if (!selected) return {};
    const changed: Record<string, unknown> = {};
    for (const key of [
      'name',
      'goal',
      'persona',
      'modelRef',
      'fallbackModelRef',
      'outputContract',
    ] as const) {
      const next = draft[key];
      if (next !== undefined && next !== selected[key]) changed[key] = next;
    }
    // 这两个是对象/数组，比不了引用，用序列化后的内容判断
    if (draft.capabilities && !same(draft.capabilities, selected.capabilities)) {
      changed['capabilities'] = draft.capabilities;
    }
    if (draft.tools && !same(draft.tools, selected.tools)) {
      changed['tools'] = draft.tools;
    }
    return changed;
  };

  const hasUnsaved = Object.keys(changedFields()).length > 0;

  /**
   * 离开当前这一条。`'new'` 表示去新建表单。
   *
   * 「新建」也要走这道守卫 —— 它同样会把详情区换掉。第一版只拦了列表里的
   * 切换，于是改了名字没保存、点右上角的「+」，改动照样没了。
   */
  const goTo = (target: GoTarget) => {
    if (hasUnsaved) {
      // 点的就是当前这条:什么都不做,不静默重置(第 5 轮实测 P9)
      if (target.kind === 'agent' && target.id === selectedId) return;
      setPendingSelect(target);
      return;
    }
    setConfirmDelete(false);
    setDraft({});
    if (target.kind === 'new') {
      setCreating(true);
      setSelectedId(null);
      return;
    }
    setSelectedId(target.id);
    setCreating(false);
  };

  const onSave = async () => {
    if (!selected) return;
    // 只发真正改过的字段：全量回写会把并发的其他改动覆盖掉，
    // 而 agent.update 的契约本来就是 partial。
    const fields = changedFields();
    if (Object.keys(fields).length === 0) {
      setError('没有改动可保存。');
      return;
    }
    // ver 是乐观锁，必带 —— 少发它的话后端无从判断这次改动基于哪一版
    const changed = { id: selected.id, ver: selected.ver, ...fields };

    try {
      await coreClient.call('agent.update', changed);
      setDraft({});
      // 改动已经落地，那条「有未保存的改动」的警告要跟着收 ——
      // 不收的话它还挂在屏幕上说着一件已经不成立的事
      setPendingSelect(null);
      setError(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const onCreate = async (input: NewAgentInput) => {
    try {
      const result = (await coreClient.call('agent.create', {
        ...input,
        tools: [],
        // 键必须与 CapabilitiesSchema 一致。写成 `{fileRead, fileWrite}` 的话
        // **校验照样通过** —— Zod 对未知键是 strip、对缺失键是填默认值，
        // 于是到引擎那边变成全 none：用户新建的角色挂到脚本节点上必然失败，
        // 而下面那句文案还写着「默认只读文件、不联网」
        capabilities: NEW_AGENT_CAPABILITIES,
        outputContract: '',
        turnLimit: 12,
        timeoutMs: 900_000,
      })) as { id: string };
      setCreating(false);
      setSelectedId(result.id);
      await load();

      // 列表分页后一页封顶 50 条，而 Agent 按名字排 ——
      // 刚建的这条很可能落在第二页，`items.find` 就找不到它，
      // 详情区会退回「选一个角色查看详情」。
      // 用户刚建完正要接着填目标与权限，那时详情区必须是它。
      setItems((current) => {
        const rows = current ?? [];
        if (rows.some((agent) => agent.id === result.id)) return rows;
        return [
          {
            id: result.id,
            name: input.name,
            role: input.role,
            goal: input.goal,
            persona: input.persona,
            runtime: input.runtime,
            modelRef: input.modelRef,
            tools: [],
            // 必须与上面提交的那份是同一个常量。写 `{}` 的话详情区取不到键
            // 会回落 'none'，四项全显示「不允许」—— 而表单上明写着
            // 「新建时默认只读文件、不联网」，用户看到的是假值。
            capabilities: NEW_AGENT_CAPABILITIES,
            outputContract: '',
            turnLimit: 12,
            timeoutMs: 900_000,
            ver: 1,
            builtin: false,
          },
          ...rows,
        ];
      });
    } catch (err) {
      setError(describeError(err));
    }
  };

  const onDuplicate = async () => {
    if (!selected) return;
    try {
      await coreClient.call('agent.duplicate', {
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
      await coreClient.call('agent.delete', { id: selected.id });
      setSelectedId(null);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <SplitPane className="agents" storageKey="agents.listWidth" defaultWidth={250}>
      <aside className="agents__list">
        <div className="agents__list-head">
          <h2 className="runs__label runs__label--heading">Agent 角色</h2>
          <span className="runs__grow" />
          <button
            type="button"
            className="models__add"
            aria-label="新建角色"
            onClick={() => goTo({ kind: 'new' })}
          >
            <i className="ph ph-plus" aria-hidden="true" />
          </button>
        </div>

        {/* 图纸左栏顶部就有它。100 多条角色靠翻页找是不可行的 ——
            输入即搜（300ms 防抖），与首页、执行记录同一套交互 */}
        <label className="runs__search agents__search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索角色、目标或工具"
            aria-label="搜索 Agent 角色"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search.onEnter();
            }}
          />
        </label>

        <div className="agents__list-body">
          {items !== null && items.length === 0 ? (
            <ListEmpty query={search.value} noun="角色" onClear={() => search.onChange('')}>
              还没有 Agent 角色。角色把「人格 + 权限 + 模型」打包成一个可引用的整体，
              节点引用它而不是各自复制一份 Prompt。
            </ListEmpty>
          ) : null}

          {(items ?? []).map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="agents__item"
              data-selected={agent.id === selectedId ? 'true' : undefined}
              onClick={() => goTo({ kind: 'agent', id: agent.id })}
            >
              <i className="ph ph-robot" aria-hidden="true" />
              <span className="agents__item-main">
                <span className="agents__item-row">
                  <span className="agents__item-name">{agent.name}</span>
                  <span className="agents__item-tag">
                    {agent.builtin ? '内置' : `v${agent.ver}`}
                  </span>
                </span>
                <span className="agents__item-meta">
                  {agent.role} · {RUNTIME_LABELS[agent.runtime as never] ?? agent.runtime}
                </span>
              </span>
            </button>
          ))}
        </div>

        <Pager
          total={total}
          pageSize={LIST_PAGE_SIZE}
          offset={offset}
          onChange={(next) => void load(next)}
        />

        <p className="models__foot">
          节点引用角色而不是复制 Prompt；角色升级后引用它的节点一并生效。
        </p>
      </aside>

      <section className="agents__detail" aria-label="角色详情">
        {error ? (
          <p className="runs__error" role="alert">
            {error}
          </p>
        ) : null}

        {creating ? (
          <AgentForm onCancel={() => setCreating(false)} onSubmit={onCreate} models={models} />
        ) : selected ? (
          <>
            {pendingSelect ? (
              <p className="models__warn" role="alert">
                这个角色有未保存的改动。切到另一个会把它们丢掉。
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
                    const target = pendingSelect;
                    setPendingSelect(null);
                    setDraft({});
                    setConfirmDelete(false);
                    if (!target || target.kind === 'new') {
                      setCreating(true);
                      setSelectedId(null);
                      return;
                    }
                    setCreating(false);
                    setSelectedId(target.id);
                  }}
                >
                  放弃改动并切换
                </button>
              </p>
            ) : null}
            <header className="agents__detail-head">
              <div className="agents__avatar">
                <i className="ph ph-robot" aria-hidden="true" />
              </div>
              <div>
                <input
                  className="agents__name-input"
                  aria-label="角色名称"
                  /*
                   * 内置角色的权限、工具、输出契约都是只读的，这三个输入框
                   * 却照样能改 —— 改完点保存必然被后端拒。一半能改一半不能
                   * 是最难懂的一种状态。
                   */
                  readOnly={selected.builtin}
                  value={draft.name ?? selected.name}
                  onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
                />
                <p className="models__detail-sub">
                  {selected.role} · v{selected.ver} ·{' '}
                  {RUNTIME_LABELS[selected.runtime as never] ?? selected.runtime} ·{' '}
                  {/* id 露出来:节点配置、MCP、排查都认 id 不认名字 ——
                      此前全应用无处可查(第 5 轮实测 P5) */}
                  <code className="agents__id">{selected.id}</code>
                  <CopyButton
                    value={selected.id}
                    label=""
                    ariaLabel="复制角色 id"
                    className="env__copy"
                  />
                </p>
              </div>
              <span className="runs__grow" />
              <button
                type="button"
                className="runs__action"
                /*
                 * 复制走的是后端的 agent.duplicate —— 它拿到的是**已保存的**
                 * 那一版，界面里没保存的草稿它看不见。有草稿时把这句说出来，
                 * 否则用户会以为副本带着他刚改的内容。
                 */
                title={
                  hasUnsaved ? '复制的是已保存的那一版，界面里未保存的改动不会带过去' : undefined
                }
                onClick={() => void onDuplicate()}
              >
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
                 * 内置角色改了必然被后端拒 —— 权限、工具、输出契约已经只读，
                 * 两个模型下拉与这个按钮却还能动，等于让用户白改一遍
                 */
                disabled={selected.builtin}
                title={
                  selected.builtin
                    ? '内置角色不能直接改 —— 先「复制」一份，副本是可编辑的'
                    : undefined
                }
                onClick={() => void onSave()}
              >
                保存新版本
              </button>
            </header>

            {selected.builtin ? (
              <p className="models__warn" role="status">
                内置角色是只读的：名称、目标、性格与指令都不能改，也不能删除。
                要改的话先「复制」一份 —— 副本是可编辑的。
              </p>
            ) : null}
            {confirmDelete ? (
              <p className="models__warn" role="status">
                删除后引用它的节点会失效，而用户往往意识不到某个节点在用它。确认删除吗？
              </p>
            ) : null}

            <div className="models__cards">
              <div className="models__card">
                <p className="models__label">角色</p>
                <p className="models__value">{selected.role}</p>
                <label className="models__label agents__spaced" htmlFor="agent-goal">
                  目标
                </label>
                <textarea
                  id="agent-goal"
                  className="agents__block agents__editable"
                  readOnly={selected.builtin}
                  value={draft.goal ?? selected.goal}
                  onChange={(event) => setDraft((d) => ({ ...d, goal: event.target.value }))}
                />
              </div>

              <div className="models__card">
                <p className="agents__card-head">
                  <label className="models__label" htmlFor="agent-persona">
                    性格与指令
                  </label>
                  <span className="runs__grow" />
                  <span className="models__note">决定语气与判断边界</span>
                </p>
                <textarea
                  id="agent-persona"
                  className="agents__persona agents__editable"
                  readOnly={selected.builtin}
                  value={draft.persona ?? selected.persona}
                  onChange={(event) => setDraft((d) => ({ ...d, persona: event.target.value }))}
                />
              </div>
            </div>

            <div className="models__card agents__models">
              <p className="models__card-title">
                <i className="ph ph-cpu" aria-hidden="true" />
                模型与 Runtime
              </p>
              <div className="agents__grid">
                <div>
                  <p className="models__label">模型</p>
                  <select
                    className="agents__select"
                    aria-label="模型"
                    disabled={selected.builtin}
                    value={draft.modelRef ?? selected.modelRef}
                    onChange={(event) => setDraft((d) => ({ ...d, modelRef: event.target.value }))}
                  >
                    {/* 引用的模型可能已被停用 —— 保留它并标出来，
                        而不是让下拉悄悄跳到第一项：那会让用户以为已经改绑 */}
                    {(models ?? []).some(
                      (m) => m.id === (draft.modelRef ?? selected.modelRef),
                    ) ? null : (
                      <option value={draft.modelRef ?? selected.modelRef}>
                        {selected.modelRef}（已停用或已删除）
                      </option>
                    )}
                    {/* 只列与角色同 runtime 的 —— 引擎解析时按 runtime 过滤候选，
                        跨 runtime 的引用配了也是每次运行一条「runtime 不符」的降级 */}
                    {(models ?? [])
                      .filter((model) => !selected.runtime || model.runtime === selected.runtime)
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <p className="models__label">降级模型</p>
                  <select
                    className="agents__select"
                    aria-label="降级模型"
                    disabled={selected.builtin}
                    value={draft.fallbackModelRef ?? selected.fallbackModelRef ?? ''}
                    onChange={(event) =>
                      setDraft((d) => ({ ...d, fallbackModelRef: event.target.value }))
                    }
                  >
                    <option value="">不降级</option>
                    {(models ?? [])
                      .filter((model) => !selected.runtime || model.runtime === selected.runtime)
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <p className="models__label">Turn 上限</p>
                  <p className="models__value">{selected.turnLimit}</p>
                </div>
              </div>
              <p className="models__note">
                下拉只列出「模型」页里已启用的条目；降级发生时会写入 RunEvent，不会静默替换模型。
              </p>
            </div>

            <div className="models__cards">
              <div className="models__card">
                <p className="models__card-title">
                  <i className="ph ph-shield-check" aria-hidden="true" />
                  权限（写进提示词交给 agent，引擎不强制）
                </p>
                <div className="agents__caps" role="group" aria-label="权限">
                  {CAPABILITY_FIELDS.map((field) => {
                    const current =
                      (draft.capabilities ?? selected.capabilities)[field.key] ?? 'none';
                    return (
                      <div key={field.key} className="agents__kv-row">
                        {/* 提示放在 label **外面**：进去的话字段的可访问名
                            会变成「网络引擎暂不读它」，读屏用户听到的是一句
                            粘在一起的话（`launch__req` 那个星号踩过同一个坑）。
                            用 aria-describedby 挂到控件上 —— 这句有信息量，
                            不该对读屏用户藏起来 */}
                        <label htmlFor={`cap-${field.key}`}>{field.label}</label>
                        <span
                          id={`cap-${field.key}-note`}
                          data-testid={`cap-note-${field.key}`}
                          className="agents__cap-note"
                        >
                          {field.note}
                        </span>
                        {selected.builtin ? (
                          // 内置角色只读：改它等于改掉系统某处调用的行为，
                          // 而那处调用别人也在用。复制一份是有意的一步
                          <span>{CAPABILITY_VALUE_LABELS[String(current)] ?? String(current)}</span>
                        ) : (
                          <select
                            id={`cap-${field.key}`}
                            aria-describedby={`cap-${field.key}-note`}
                            value={String(current)}
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                capabilities: {
                                  ...(prev.capabilities ?? selected.capabilities),
                                  [field.key]: event.target.value,
                                },
                              }))
                            }
                          >
                            {field.options.map((option) => (
                              <option key={option} value={option}>
                                {CAPABILITY_VALUE_LABELS[option] ?? option}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* 不写这句的话，用户会以为把「命令」调成「不允许」
                    就管住了所有节点。脚本与 worktree 挂不上角色
                    （契约里没有 agentProfileId 字段），它们照跑 */}
                <p className="models__note">
                  脚本与 worktree 节点挂不上角色，不看这里；它们由运行时的权限档管 ——
                  最严那档会在执行前逐项等你审批。
                </p>
              </div>

              <div className="models__card">
                <p className="models__card-title">
                  <i className="ph ph-wrench" aria-hidden="true" />
                  工具与 MCP 白名单
                </p>
                <ul className="models__caps" aria-label="工具与 MCP 白名单">
                  {(draft.tools ?? selected.tools).map((tool) => (
                    <li key={tool}>
                      {tool}
                      {selected.builtin ? null : (
                        <button
                          type="button"
                          className="agents__tool-remove"
                          aria-label={`移除 ${tool}`}
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              tools: (prev.tools ?? selected.tools).filter((t) => t !== tool),
                            }))
                          }
                        >
                          <i className="ph ph-x" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {selected.builtin ? null : addingTool !== null ? (
                  <form
                    className="agents__tool-add"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = addingTool.trim();
                      const current = draft.tools ?? selected.tools;
                      if (!name || current.includes(name)) return;
                      setDraft((prev) => ({ ...prev, tools: [...current, name] }));
                      setAddingTool(null);
                    }}
                  >
                    {/* autoFocus：输入框原地替换了按钮，不聚焦的话视觉上
                        几乎没变化 —— codex 自主体验时就没找到它，
                        报了「点击后没有任何反应」。点了就该能直接打字 */}
                    <input
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      aria-label="工具名"
                      value={addingTool}
                      placeholder="工具名，回车添加；Esc 取消"
                      onChange={(event) => setAddingTool(event.target.value)}
                      onKeyDown={(event) => {
                        // 点开了又不想加时得能退出去
                        if (event.key === 'Escape') setAddingTool(null);
                      }}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="agents__tool-add-btn"
                    onClick={() => setAddingTool('')}
                  >
                    + 添加
                  </button>
                )}

                <label className="models__label agents__spaced" htmlFor="agent-output">
                  输出契约
                </label>
                {selected.builtin ? (
                  <p className="agents__inline">{selected.outputContract || '未声明'}</p>
                ) : (
                  <textarea
                    id="agent-output"
                    className="agents__persona agents__editable"
                    rows={2}
                    value={draft.outputContract ?? selected.outputContract}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, outputContract: event.target.value }))
                    }
                  />
                )}
              </div>
            </div>

            <p className="agents__foot">
              <i className="ph ph-info" aria-hidden="true" />
              节点可覆盖任务指令、输出 Schema 和 Turn 上限，但不能静默扩大这里声明的权限。
            </p>
          </>
        ) : (
          <p className="runs__empty runs__empty--center">选一个角色查看详情，或新建一个。</p>
        )}
      </section>
    </SplitPane>
  );
}

export interface NewAgentInput {
  name: string;
  role: string;
  goal: string;
  persona: string;
  runtime: string;
  modelRef: string;
}

/**
 * 新建角色表单。
 *
 * 最少必填就是「名称 + 角色 + 模型」—— 其余（权限、工具、输出契约）
 * 建完再在详情区调，逼用户一次填十几个字段只会让人放弃。
 */
function AgentForm({
  models,
  onSubmit,
  onCancel,
}: {
  /** null 表示还在读。空数组才是「一个都没有」。 */
  models: ModelOption[] | null;
  onSubmit: (input: NewAgentInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [goal, setGoal] = useState('');
  const [persona, setPersona] = useState('');
  // 默认 codex：这个应用本身跑在 Claude Code 里开发，
  // 用 claude 的 adapter 会与开发环境互相干扰（见 docs/TESTING.md）
  const [runtime, setRuntime] = useState('acp.codex');
  const [modelRef, setModelRef] = useState('');

  /**
   * 模型晚到时补上默认选择。
   *
   * useState 的初值只在首次渲染时算一次 —— 用户手快、在 model.list
   * 回来之前就点了「新建角色」的话，那次算的是空数组，
   * 于是下拉永远是空的、创建按钮永远 disabled。
   *
   * 只在用户还没选过时补：他选过之后数据再到也不该覆盖他的选择。
   */
  useEffect(() => {
    if (modelRef === '' && models && models.length > 0) {
      setModelRef(models[0]?.id ?? '');
    }
  }, [models, modelRef]);

  const loading = models === null;
  const ready = !loading && name.trim() !== '' && role.trim() !== '' && modelRef !== '';

  return (
    <form
      className="models__form"
      aria-label="新建角色"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSubmit({ name: name.trim(), role: role.trim(), goal, persona, runtime, modelRef });
      }}
    >
      <h4>新建角色</h4>

      <label className="models__field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <label className="models__field">
        <span>角色</span>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="例如：代码审查者"
          required
        />
      </label>

      <label className="models__field">
        <span>目标</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} />
      </label>

      <label className="models__field">
        <span>性格与指令</span>
        <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={3} />
      </label>

      <label className="models__field">
        <span>Runtime</span>
        <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
          {Object.entries(RUNTIME_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="models__field">
        <span>模型</span>
        <select value={modelRef} onChange={(e) => setModelRef(e.target.value)} required>
          {/* 「先去登记一个」是「确实没有」时说的话。
              加载中显示它会让用户跑去登记一个他本来就有的模型 */}
          {loading ? <option value="">正在读取模型…</option> : null}
          {!loading && models.length === 0 ? (
            <option value="">先去「模型」页登记一个</option>
          ) : null}
          {(models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>

      <p className="models__note">
        权限、工具白名单和输出契约建完再调 —— 新建时默认只读文件、不联网。
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
