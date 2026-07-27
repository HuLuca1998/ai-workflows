import { useEffect, useState } from 'react';
import type { AGENT_RUNTIMES } from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';

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
}

const RUNTIME_LABELS: Record<(typeof AGENT_RUNTIMES)[number], string> = {
  'acp.claude': 'Claude Code（ACP）',
  'acp.codex': 'Codex（ACP）',
  'provider.api': 'API 提供商',
};

/** 权限项的显示名。键与契约的 CapabilitiesSchema 对应。 */
const CAPABILITY_LABELS: Record<string, string> = {
  fileRead: '文件读',
  fileWrite: '文件写',
  network: '网络',
  command: '命令',
  memory: '记忆',
  approval: '审批',
};

export function AgentsPage() {
  const [items, setItems] = useState<Agent[] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = (await coreClient.call('agent.list', {})) as { items: Agent[] };
      setItems(result.items);
    } catch (err) {
      setError(describe(err));
    }
  };

  useEffect(() => {
    void load();
    // 只要已启用的：过滤在后端做，前端不该拿到停用条目再自己筛
    void coreClient
      .call('model.list', { enabledOnly: true })
      .then((result) => setModels((result as { items: ModelOption[] }).items))
      .catch(() => setModels([]));
  }, []);

  const selected = items?.find((agent) => agent.id === selectedId) ?? null;

  const onSave = async () => {
    if (!selected) return;
    try {
      await coreClient.call('agent.update', { id: selected.id, name: selected.name });
      await load();
    } catch (err) {
      setError(describe(err));
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
      setError(describe(err));
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
      setError(describe(err));
    }
  };

  return (
    <div className="agents">
      <aside className="agents__list">
        <div className="agents__list-head">
          <span className="runs__label">Agent 角色</span>
          <span className="runs__grow" />
          <button type="button" className="models__add" aria-label="新建角色">
            <i className="ph ph-plus" aria-hidden="true" />
          </button>
        </div>

        <div className="agents__list-body">
          {items !== null && items.length === 0 ? (
            <p className="runs__empty">
              还没有 Agent 角色。角色把「人格 + 权限 + 模型」打包成一个可引用的整体，
              节点引用它而不是各自复制一份 Prompt。
            </p>
          ) : null}

          {(items ?? []).map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="agents__item"
              data-selected={agent.id === selectedId ? 'true' : undefined}
              onClick={() => {
                setSelectedId(agent.id);
                setConfirmDelete(false);
              }}
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

        {selected ? (
          <>
            <header className="agents__detail-head">
              <div className="agents__avatar">
                <i className="ph ph-robot" aria-hidden="true" />
              </div>
              <div>
                <h4>{selected.name}</h4>
                <p className="models__detail-sub">
                  {selected.role} · v{selected.ver} ·{' '}
                  {RUNTIME_LABELS[selected.runtime as never] ?? selected.runtime}
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
                内置角色不能删除。要改的话先复制一份 —— 副本是可编辑的。
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
                <p className="models__label agents__spaced">目标</p>
                <p className="agents__block">{selected.goal}</p>
              </div>

              <div className="models__card">
                <p className="agents__card-head">
                  <span className="models__label">性格与指令</span>
                  <span className="runs__grow" />
                  <span className="models__note">决定语气与判断边界</span>
                </p>
                <p className="agents__persona">{selected.persona}</p>
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
                  <select className="agents__select" value={selected.modelRef} aria-label="模型">
                    {models.map((model) => (
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
                    value={selected.fallbackModelRef ?? ''}
                    aria-label="降级模型"
                  >
                    <option value="">不降级</option>
                    {models.map((model) => (
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
                  权限（引擎强制，Prompt 无法越权）
                </p>
                <dl className="models__kv">
                  {Object.entries(selected.capabilities).map(([key, value]) => (
                    <div key={key} className="agents__kv-row">
                      <dt>{CAPABILITY_LABELS[key] ?? key}</dt>
                      <dd>{formatCapability(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="models__card">
                <p className="models__card-title">
                  <i className="ph ph-wrench" aria-hidden="true" />
                  工具与 MCP 白名单
                </p>
                <ul className="models__caps" aria-label="工具与 MCP 白名单">
                  {selected.tools.map((tool) => (
                    <li key={tool}>{tool}</li>
                  ))}
                </ul>
                <p className="models__label agents__spaced">输出契约</p>
                <p className="agents__inline">{selected.outputContract || '未声明'}</p>
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
    </div>
  );
}

/** 权限值可能是布尔、字符串或数组，都要显示成人能读的。 */
function formatCapability(value: unknown): string {
  if (typeof value === 'boolean') return value ? '允许' : '禁止';
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '无';
  if (value === null || value === undefined) return '未声明';
  return String(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
