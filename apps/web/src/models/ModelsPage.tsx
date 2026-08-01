import { useEffect, useState } from 'react';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch.js';
import { describeError } from '../data/describeError.js';
import { AGENT_RUNTIMES, type Model, LIST_PAGE_SIZE } from '@aiwf/contracts';
import { SplitPane } from '../layout/SplitPane.js';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';
import { ListEmpty } from '../layout/ListEmpty.js';
import { useFocusOnce } from '../hooks/useFocusOnce.js';
import { useAsyncAction } from '../data/useAsyncAction.js';

/**
 * 模型 —— 严格照图纸「07 模型」：262px 左栏（按接入方式分组）+ 详情。
 *
 * 两条产品规则在这一屏兑现：
 * 1.「系统内所有模型下拉只列出这里已启用的条目」—— 停用是一等操作
 * 2. 凭据只显示 `keychain://` 引用，界面上**不存在**查看明文的路径。
 *    留一个「显示明文」按钮，等于把密钥搬到截图与录屏里
 */

/** 界面上多带一个「最近一次测试的延迟」，契约里它是可选的。 */
type ModelRow = Model & { lastLatencyMs?: number };

/**
 * 接入方式的显示名。图纸左栏按这个分组。
 *
 * 键直接取自契约的 AGENT_RUNTIMES —— 自己另写一套字符串的话，
 * 界面发出去的值会被 Zod 挡在 Core API 门口，而症状只是「保存没反应」。
 * 这个坑踩过一次（端到端测试抓到的）。
 */
const RUNTIME_LABELS: Record<(typeof AGENT_RUNTIMES)[number], string> = {
  'acp.claude': 'Claude Code（ACP）',
  'acp.codex': 'Codex（ACP）',
};

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

function runtimeLabel(runtime: string): string {
  return RUNTIME_LABELS[runtime as (typeof AGENT_RUNTIMES)[number]] ?? runtime;
}

export function ModelsPage() {
  // 换条件时回第一页：停在第 2 页搜完可能一条都没有
  const search = useDebouncedSearch((query) => void load(0, query));
  const [items, setItems] = useState<ModelRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 进入确认态时把焦点接过来 —— 原来的按钮已经被移除，焦点会掉回 body */
  const focusConfirm = useFocusOnce();
  const [error, setError] = useState<string | null>(null);
  /**
   * 连通性测试：**正在测哪一个**，以及最近一次结果。
   *
   * 只存一个布尔时它会跟着跑：测 A 的过程中切到 B，B 的按钮显示
   * 「测试中…」并且点不动，而那个请求根本不是对它发的。
   */
  /*
   * 连通性测试的防连点。
   *
   * 用 useAsyncAction 而不是自己数一个数组：它的锁是 ref（同步的），
   * 而 state 里的数组在同一批事件里读到的还是旧值 —— 极快连点两次时
   * `includes` 判不出来，两条请求都会发出去。这正是那个 hook
   * 头一句注释在说的事，没必要在这里再写一份差一点的。
   */
  const testing = useAsyncAction();
  /*
   * 结果里带着**是哪个模型**的 id。此前是一个页面级的匿名结果，
   * 在 A 上测出「连不上」再切到 B，那句红字就挂在 B 的详情里了。
   * 绑 id 比「切换时记得清空」稳：新增一个切换入口时不会忘。
   */
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    detail: string;
  } | null>(null);
  /** 测试失败的报错。与结果一样绑 id —— 页面级的 error 会跟着跑。 */
  const [testError, setTestError] = useState<{ id: string; message: string } | null>(null);
  /** 满足条件的总条数与当前页起点。后端早就分页了，缺的是界面这一层。 */
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

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
      const result = (await coreClient.call('model.list', {
        enabledOnly: false,
        // 搜索发给后端：前端过滤只能过滤当前页
        ...(query ? { query } : {}),
        limit: LIST_PAGE_SIZE,
        offset: nextOffset,
      })) as { items: ModelRow[]; total: number };
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * 测一个模型现在能不能用。
   *
   * 测完要**重新拉列表**：延迟写回了模型行，不拉的话凭据卡上那行
   * 还是上一次的数字 —— 用户会以为测试没生效。
   */
  const runTest = async () => {
    if (!selectedId) return;
    setTestResult(null);
    setTestError(null);
    try {
      const result = (await coreClient.call('model.test', { id: selectedId })) as {
        ok: boolean;
        detail: string;
        latencyMs: number;
      };
      setTestResult({ id: selectedId, ok: result.ok, detail: result.detail });
      await load(offset);
    } catch (err) {
      // 错误也绑 id：不绑的话 A 的「连不上」会显示在 B 的详情下
      setTestError({ id: selectedId, message: err instanceof Error ? err.message : String(err) });
    }
  };

  /**
   * 从 runtime 同步模型清单。
   *
   * **这是模型清单的唯一来源。** 在这之前模型要手工登记 ——
   * 用户自己敲模型 ID、上下文窗口、能力清单，而敲进去的值多半是错的：
   * 内置种子那两条（`gpt-5-codex` / `claude-opus-5`）实测都不在
   * agent 认的候选里，设下去会被当场拒掉。
   *
   * 清单也不能写死在代码里：本机 CLI 一升级就会多出模型
   * （实测 codex 现在 5 个模型族 × 6 档深度），而写死的那份不会跟着变。
   */
  const syncing = useAsyncAction();
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncRuntime, setSyncRuntime] = useState<string>(AGENT_RUNTIMES[0]);

  const runSync = () =>
    syncing.run(async () => {
      setSyncNote(null);
      setError(null);
      try {
        const result = (await coreClient.call('model.sync', { runtime: syncRuntime })) as {
          models: { value: string }[];
          efforts: { value: string }[];
          currentModel: string;
          added: number;
        };
        setSyncNote(
          `${runtimeLabel(syncRuntime)}：${result.models.length} 个模型 / ` +
            `${result.efforts.length} 档推理深度` +
            (result.added > 0 ? `，新增 ${result.added} 条` : '，清单没有变化') +
            (result.currentModel ? ` · 当前默认 ${result.currentModel}` : ''),
        );
        // 同步完必须重拉：不拉的话用户点完什么都没变，
        // 而条目其实已经进库了 —— 他会以为没点上，再点几次
        await load(0);
      } catch (err) {
        // 空列表与「adapter 没装」在界面上长得一样，而要做的事完全不同
        setError(describeError(err));
      }
    });

  useEffect(() => {
    void load();
  }, []);

  const selected = items?.find((model) => model.id === selectedId) ?? null;
  const grouped = groupByRuntime(items ?? []);

  /**
   * 启用 / 停用。
   *
   * 失败要说话：用户点了「停用」而界面一声不吭的话，他会再点几次，
   * 然后开始怀疑是不是自己没点上 —— 而真正的原因（乐观锁冲突、
   * 数据库忙）一个字都没露出来。
   */
  const onToggle = async () => {
    if (!selected) return;
    setError(null);
    try {
      await coreClient.call('model.update', { id: selected.id, enabled: !selected.enabled });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    setError(null);
    try {
      await coreClient.call('model.delete', { id: selected.id });
      // 只有真删掉了才清空选中：失败还清的话，
      // 用户连重试的入口都找不到
      setSelectedId(null);
      setConfirmDelete(false);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <SplitPane className="models" storageKey="models.listWidth" defaultWidth={262}>
      <aside className="models__list">
        <div className="models__list-head">
          <h2 className="runs__label runs__label--heading">模型</h2>
          <span className="runs__grow" />
          <button
            type="button"
            className="models__add"
            aria-label="登记模型"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            <i className="ph ph-plus" aria-hidden="true" />
          </button>
        </div>

        {/* 同步：先选接入方式，再问它现在能用什么。
            清单只能从 runtime 拿 —— 手工敲的值多半不在它认的候选里 */}
        <div className="models__sync">
          <select
            aria-label="接入方式"
            value={syncRuntime}
            onChange={(event) => setSyncRuntime(event.target.value)}
            disabled={syncing.running}
          >
            {AGENT_RUNTIMES.map((runtime) => (
              <option key={runtime} value={runtime}>
                {runtimeLabel(runtime)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void runSync()} disabled={syncing.running}>
            <i className="ph ph-arrows-clockwise" aria-hidden="true" />
            {syncing.running ? '同步中…' : '同步'}
          </button>
        </div>
        {syncNote ? <p className="models__sync-note">{syncNote}</p> : null}

        {/* 输入即搜（300ms 防抖）—— 与其余五个列表页同一套交互。
            模型 ID 也参与匹配：那是用户从文档里抄来的字符串 */}
        <label className="runs__search models__search">
          <i className="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索名称或模型 ID"
            aria-label="搜索模型"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search.onEnter();
            }}
          />
        </label>

        {/* 有名字的区域：分组标题（「Codex（ACP）」）与上面接入方式下拉里的
            选项文字一模一样，不圈定范围的话连测试都分不清哪个是哪个 ——
            用屏幕阅读器的人同样分不清 */}
        <div className="models__list-body" role="region" aria-label="模型列表">
          {items !== null && items.length === 0 ? (
            <ListEmpty query={search.value} noun="模型" onClear={() => search.onChange('')}>
              {/* 原来这里写着「ACP 握手不返回模型列表，所以模型要在这里手工登记」。
                  **那句话是错的**：`session/new` 的 configOptions 里就带着模型清单，
                  两端实测都有（docs/acp/transcripts/{codex,claude}-model.jsonl）。
                  照那句话去手工敲，敲出来的值多半不在 agent 认的候选里。 */}
              还没有模型。选好上面的接入方式点「同步」—— 清单由 runtime 自己给出，
              比手工敲准，而且本机 CLI 升级后再同步一次就能拿到新模型。
            </ListEmpty>
          ) : null}

          {grouped.map(([runtime, models]) => (
            <div key={runtime}>
              <p className="models__group">
                <span>{runtimeLabel(runtime)}</span>
                <span className="runs__grow" />
                <span>{models.length}</span>
              </p>
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className="models__item"
                  data-selected={model.id === selectedId ? 'true' : undefined}
                  onClick={() => {
                    setSelectedId(model.id);
                    setCreating(false);
                    setConfirmDelete(false);
                  }}
                >
                  <span className="models__item-main">
                    <span className="models__item-name">{model.name}</span>
                    <span className="models__item-meta">
                      {model.modelId} · {model.effort}
                    </span>
                  </span>
                  <span className="models__item-state" data-enabled={model.enabled}>
                    {model.enabled ? '已启用' : '已停用'}
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
          系统内所有模型下拉只列出这里已启用的条目，AI 无法引用未登记的模型。
        </p>
      </aside>

      <section className="models__detail" aria-label="模型详情">
        {/*
         * 一条都没启用时给出路。
         *
         * 内置那两条默认停用是**对的**（model_id 是示例值，两端 adapter
         * 都不认，启用了每次运行都写 model_downgraded）—— 缺的一直是
         * 「那我该做什么」：首次进来两条红色「已停用」，右边一个空态，
         * 而所有 Agent 角色与 AI 节点的模型下拉全是空的，系统开箱不可用
         * （第三方巡检 C-04 / DEBT O-18）。
         */}
        {items !== null && !items.some((model) => model.enabled) ? (
          <p className="models__no-usable" role="status" aria-label="没有可用模型">
            <i className="ph-fill ph-warning-circle" aria-hidden="true" />
            <span>
              <strong>还没有启用任何模型</strong> —— AI 节点与主管 AI 现在都跑不了。
              内置那两条的模型名是示例值（adapter 不认）， 点「同步」让 runtime
              自己报它现在能用什么。
            </span>
            <button type="button" onClick={() => void runSync()} disabled={syncing.running}>
              {syncing.running ? '同步中…' : `从 ${runtimeLabel(syncRuntime)} 同步`}
            </button>
          </p>
        ) : null}
        {error ? (
          <p className="runs__error" role="alert">
            {error}
          </p>
        ) : null}

        {creating ? (
          <ModelForm
            onCancel={() => setCreating(false)}
            onSaved={async () => {
              setCreating(false);
              await load();
            }}
          />
        ) : selected ? (
          <>
            <header className="models__detail-head">
              <div>
                <div className="models__detail-title">
                  <h4>{selected.name}</h4>
                  <span className="models__badge" data-enabled={selected.enabled}>
                    {selected.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <p className="models__detail-sub">{runtimeLabel(selected.runtime)}</p>
              </div>
              <span className="runs__grow" />
              {/* 图纸的按钮顺序：测试连通性 | 启用/停用 | 删除。
                  只做握手 + 建会话，不发提示词 —— 那样快、不花钱，
                  而且已经足以回答「这个模型现在能不能用」 */}
              <button
                type="button"
                className="runs__action"
                disabled={testing.isRunning(selected.id)}
                onClick={() => testing.run(() => runTest(), selected.id)}
              >
                {testing.isRunning(selected.id) ? '测试中…' : '测试连通性'}
              </button>
              <button type="button" className="runs__action" onClick={() => void onToggle()}>
                {selected.enabled ? '停用' : '启用'}
              </button>
              {confirmDelete ? (
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
            </header>

            {confirmDelete ? (
              <p className="models__warn" role="status">
                {/* 原来写的是「引用这个模型的 Agent 与节点会失效」——
                    两处都不准：还有角色在引用时后端**直接拒绝**（不会删掉），
                    而 model_ref 引擎从来不读（只有 runtime 决定起哪个
                    adapter），所以也谈不上「失效」。承诺一件不会发生的事，
                    用户会按错的预期做决定 */}
                还有 Agent 角色在用它的话删不掉 —— 会告诉你是哪几个。确认要删除吗？
              </p>
            ) : null}

            <div className="models__grid">
              <Field
                label="接入方式"
                value={RUNTIME_LABELS[selected.runtime] ?? selected.runtime}
              />
              <Field label="模型 ID" value={selected.modelId} mono />
              <div>
                <p className="models__label">推理档位</p>
                {/* 展示器，不是控件：「同一模型的不同档位登记为不同条目」——
                    在这里改档位等于换一个条目，那不是「编辑」而是「新建」。
                    所以按钮 disabled，并用 aria-pressed 说明哪个是当前值：
                    四个按钮 class 完全相同、又没有语义的话，
                    读屏用户与灰度截图都读不出当前档位 */}
                <div className="launch__seg" role="group" aria-label="推理档位">
                  {EFFORTS.map((effort) => (
                    <button
                      key={effort}
                      type="button"
                      disabled
                      aria-pressed={selected.effort === effort}
                      data-active={selected.effort === effort}
                    >
                      {effort}
                    </button>
                  ))}
                </div>
                <p className="models__note">
                  档位不能就地改 —— 同一模型的不同档位是不同条目，改档位请另外登记一条。
                </p>
                <p className="models__note">同一模型的不同档位登记为不同条目，运行记录能区分</p>
              </div>
              <Field
                label="上下文窗口"
                value={
                  selected.contextWindow === 0
                    ? '未知（同步来源不报窗口大小）'
                    : selected.contextWindow.toLocaleString('en-US')
                }
              />
            </div>

            <div className="models__cards">
              <div className="models__card">
                <p className="models__card-title">凭据与端点</p>
                <dl className="models__kv">
                  <dt>凭据</dt>
                  <dd className="models__mono">{selected.credentialRef ?? '未设置'}</dd>
                  <dt>延迟</dt>
                  <dd>
                    {selected.lastLatencyMs === undefined
                      ? '尚未测试'
                      : `${selected.lastLatencyMs} ms（最近一次测试）`}
                  </dd>
                </dl>
                {/* 测试结果连原因一起显示：adapter 没装是最常见的情况，
                    而用户需要的是「装什么」，不是一个红色的「失败」 */}
                {testError?.id === selected.id ? (
                  <p className="runs__error" role="alert">
                    {testError.message}
                  </p>
                ) : null}
                {testResult && testResult.id === selected.id ? (
                  <p className="models__test-result" data-ok={testResult.ok} role="status">
                    <i
                      className={`ph ${testResult.ok ? 'ph-check-circle' : 'ph-warning-circle'}`}
                      aria-hidden="true"
                    />
                    {testResult.detail}
                  </p>
                ) : null}
              </div>

              <div className="models__card">
                <p className="models__card-title">能力标签</p>
                <ul className="models__caps" aria-label="能力标签">
                  {selected.capabilities.map((cap) => (
                    <li key={cap}>{cap}</li>
                  ))}
                </ul>
                <p className="models__note">
                  不具备「结构化输出」的模型不会出现在要求 JSON Schema 的节点下拉里。
                </p>
              </div>
            </div>

            <div className="models__acp">
              <p className="models__acp-title">
                <i className="ph ph-plugs-connected" aria-hidden="true" />
                ACP 模型清单从哪来
              </p>
              <p className="models__acp-body">
                较新的 adapter 会在握手时报告可用模型与推理档位 —— 上面的「同步」按钮拉的就是它，
                同一屏的「测试连通性」也会显示。老版本 adapter 不报，那时需要手动登记。
                同步来的条目上下文窗口显示「未知」（两端语义不同，引擎不编数字），
                需要的话可在详情里手动补填；连通性测试见每条模型的详情。
              </p>
            </div>
          </>
        ) : (
          <p className="runs__empty runs__empty--center">选一个模型查看详情，或登记一个新的。</p>
        )}
      </section>
    </SplitPane>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="models__label">{label}</p>
      <p className={mono ? 'models__value models__mono' : 'models__value'}>{value}</p>
    </div>
  );
}

function ModelForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<string>(AGENT_RUNTIMES[0]);
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState('medium');
  const [contextWindow, setContextWindow] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    // 明文密钥在界面这一层就拦住：让它走到 IPC 再报错，
    // 那一路上它已经出现在日志与错误上报里了
    if (credentialRef && !credentialRef.startsWith('keychain://')) {
      setError('凭据必须是 keychain:// 引用。请先把密钥存进钥匙串，再在这里引用它。');
      return;
    }
    if (!name.trim() || !modelId.trim() || !contextWindow.trim()) {
      setError('名称、模型 ID 与上下文窗口是必填项。');
      return;
    }
    /*
     * 只查非空的话，「abc」会被 Number() 变成 NaN 发给后端 ——
     * 契约那头 positive int 会拒，但错误要等一个来回才回来，
     * 而且报的是契约语言，用户看不懂自己填错了哪一格。
     */
    const window = Number(contextWindow);
    if (!Number.isInteger(window) || window <= 0) {
      setError('上下文窗口要填一个正整数（单位是 token），比如 200000。');
      return;
    }

    setError(null);
    try {
      await coreClient.call('model.create', {
        name,
        runtime,
        modelId,
        effort,
        contextWindow: window,
        capabilities: [],
        ...(credentialRef ? { credentialRef } : {}),
        enabled: true,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    /*
     * 是 <form> 而不是 div：填完在输入框里按回车提交是填表最自然的收尾，
     * 而那个默认行为要有 form 才成立。
     */
    <form
      className="models__form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <h4>登记模型</h4>
      <label className="models__field">
        <span className="models__label">名称</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="models__field">
        <span className="models__label">接入方式</span>
        <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
          {Object.entries(RUNTIME_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="models__field">
        <span className="models__label">模型 ID</span>
        <input type="text" value={modelId} onChange={(e) => setModelId(e.target.value)} />
      </label>
      <label className="models__field">
        <span className="models__label">推理档位</span>
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          {EFFORTS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="models__field">
        <span className="models__label">上下文窗口</span>
        <input
          type="text"
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
        />
      </label>
      <label className="models__field">
        <span className="models__label">凭据</span>
        <input
          type="text"
          placeholder="keychain://…"
          value={credentialRef}
          onChange={(e) => setCredentialRef(e.target.value)}
        />
      </label>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="models__form-actions">
        <button type="button" className="runs__action" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="runs__action runs__action--primary">
          保存
        </button>
      </div>
    </form>
  );
}

/** 按接入方式分组，组内保持后端给的顺序（已按 runtime + name 排过）。 */
function groupByRuntime(models: readonly ModelRow[]): [string, ModelRow[]][] {
  const groups = new Map<string, ModelRow[]>();
  for (const model of models) {
    const bucket = groups.get(model.runtime) ?? [];
    bucket.push(model);
    groups.set(model.runtime, bucket);
  }
  return [...groups.entries()];
}
