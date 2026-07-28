import { useEffect, useState } from 'react';
import { AGENT_RUNTIMES, type Model } from '@aiwf/contracts';
import { SplitPane } from '../layout/SplitPane.js';
import { Pager } from '../layout/Pager.js';
import { coreClient } from '../data/workspace.js';

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
  'provider.api': 'API 提供商',
};

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

function runtimeLabel(runtime: string): string {
  return RUNTIME_LABELS[runtime as (typeof AGENT_RUNTIMES)[number]] ?? runtime;
}

/** 列表一页多少条。与契约的 LIST_PAGE_SIZE 一致。 */
const LIST_PAGE_SIZE = 50;

export function ModelsPage() {
  const [items, setItems] = useState<ModelRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 连通性测试：进行中的标记与最近一次结果。 */
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  /** 满足条件的总条数与当前页起点。后端早就分页了，缺的是界面这一层。 */
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  const load = async (nextOffset = offset) => {
    setOffset(nextOffset);
    try {
      const result = (await coreClient.call('model.list', {
        enabledOnly: false,
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
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = (await coreClient.call('model.test', { id: selectedId })) as {
        ok: boolean;
        detail: string;
        latencyMs: number;
      };
      setTestResult({ ok: result.ok, detail: result.detail });
      await load(offset);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const selected = items?.find((model) => model.id === selectedId) ?? null;
  const grouped = groupByRuntime(items ?? []);

  const onToggle = async () => {
    if (!selected) return;
    await coreClient.call('model.update', { id: selected.id, enabled: !selected.enabled });
    await load();
  };

  const onDelete = async () => {
    if (!selected) return;
    await coreClient.call('model.delete', { id: selected.id });
    setSelectedId(null);
    setConfirmDelete(false);
    await load();
  };

  return (
    <SplitPane className="models" storageKey="models.listWidth" defaultWidth={262}>
      <aside className="models__list">
        <div className="models__list-head">
          <span className="runs__label">已配置模型</span>
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

        <div className="models__list-body">
          {items !== null && items.length === 0 ? (
            <p className="runs__empty">
              还没有登记模型。ACP 握手不返回模型列表，所以模型要在这里手工登记， 或从本机 CLI
              配置导入。
            </p>
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
                disabled={testing}
                onClick={() => void runTest()}
              >
                {testing ? '测试中…' : '测试连通性'}
              </button>
              <button type="button" className="runs__action" onClick={() => void onToggle()}>
                {selected.enabled ? '停用' : '启用'}
              </button>
              {confirmDelete ? (
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
            </header>

            {confirmDelete ? (
              <p className="models__warn" role="status">
                删除后引用这个模型的 Agent 与节点会失效。确认要删除吗？
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
              <Field label="上下文窗口" value={selected.contextWindow.toLocaleString('en-US')} />
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
                {testResult ? (
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
                ACP 不提供模型列表
              </p>
              <p className="models__acp-body">
                ACP 握手只返回协议能力与 session modes（权限档位），不返回可用模型。 因此 ACP
                模型需要在这里登记；从 CLI 配置导入与连通性测试要等适配器接上（M3）。
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

    setError(null);
    try {
      await coreClient.call('model.create', {
        name,
        runtime,
        modelId,
        effort,
        contextWindow: Number(contextWindow),
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
    <div className="models__form">
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
        <button
          type="button"
          className="runs__action runs__action--primary"
          onClick={() => void onSave()}
        >
          保存
        </button>
      </div>
    </div>
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
