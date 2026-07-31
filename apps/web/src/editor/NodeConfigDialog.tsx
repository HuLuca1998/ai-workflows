import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeIssue,
  fieldDescriptors,
  getNodeDefinition,
  resolveNodeOutputs,
  type FieldDescriptor,
  type GraphNode,
  type WorkflowGraph,
} from './editorDeps.js';
import { Button } from '@aiwf/ui';
import { iconFor } from './nodeVisuals.js';
import { SchemaField, type ReferenceOption } from './SchemaField.jsx';

export interface NodeConfigDialogProps {
  node: GraphNode;
  graph: WorkflowGraph;
  onClose: () => void;
  onSave: (config: unknown, title: string) => void;
  /**
   * 引用字段的候选（按 reference 类型分组）。EditorPage 从库里查好传进来 ——
   * 弹层自己不碰数据层，几十处测试都是按值构造它的。
   */
  references?: Partial<Record<'agentProfile' | 'prompt', ReferenceOption[]>>;
}

const TABS = ['配置', '输入 / 输出', '权限与能力', '重试与超时'] as const;
type Tab = (typeof TABS)[number];

/**
 * 节点配置弹层，760px，照图纸「02 画布编辑器」的弹层：
 * 头部（图标 + 标题 + 类型说明）· 四个标签页 · 内容区 · 底部操作。
 *
 * 配置页的表单**完全由 Schema 驱动**（fieldDescriptors），
 * 新增节点类型只要写 Schema 与 describe，这里一行都不用改。
 */
export function NodeConfigDialog({ node, graph, onClose, onSave, references }: NodeConfigDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * Esc 关闭挂在 document 上，不挂 backdrop 的 onKeyDown。
   *
   * 双击节点打开配置时，DOM 焦点停在被双击的 `.react-flow__node`（tabIndex 0）——
   * 那在 backdrop 的 React 子树之外，keydown 永远不会冒泡到 backdrop 的处理器，
   * 于是「Esc 关闭」这条规范要求一直是不生效的（而测试里没有 Escape 断言）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /** 焦点移进弹层：删除键这时才不会落到画布上把节点删掉。 */
  useEffect(() => {
    const title = dialogRef.current?.querySelector<HTMLInputElement>('.cfg__title');
    title?.focus();
    title?.select();
  }, []);

  const definition = getNodeDefinition(node.type);
  const fields = useMemo(() => fieldDescriptors(node.type), [node.type]);
  const [tab, setTab] = useState<Tab>('配置');
  const [title, setTitle] = useState(node.title);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({
    ...(node.config as Record<string, unknown>),
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // JSON 控件的解析错误。draft 里存的是上一次能解析的旧值，
  // 不单独记的话「红字报错」与「保存放行」会同时成立（第 2 轮实测）
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});

  const inCount = graph.edges.filter((e) => e.target.nodeId === node.id).length;
  const outCount = graph.edges.filter((e) => e.source.nodeId === node.id).length;

  const onSubmit = () => {
    if (Object.keys(jsonErrors).length > 0) {
      setFieldErrors((prev) => ({ ...prev, ...jsonErrors }));
      setTab('配置');
      return;
    }
    const parsed = definition.configSchema.safeParse(draft);
    if (!parsed.success) {
      // 逐字段回显错误，而不是弹一句「保存失败」让人猜哪里不对。
      // 文案走契约的 describeIssue —— Zod 默认吐的是英文
      //（`Too small: expected string to have >=1 characters`），
      // 而这一屏是 Schema 驱动渲染的，文案也该由 Schema 驱动
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !errors[key]) errors[key] = describeIssue(issue, definition.configSchema);
      }
      setFieldErrors(errors);
      setTab('配置');
      return;
    }
    setFieldErrors({});
    onSave(parsed.data, title.trim() || node.title);
  };

  return (
    <div
      className="cfg__backdrop"
      onMouseDown={(event) => {
        // 点遮罩关闭；点弹层内部不关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cfg"
        role="dialog"
        aria-modal="true"
        aria-label={`配置 ${node.title}`}
        ref={dialogRef}
      >
        <header className="cfg__head">
          <span className="cfg__icon" aria-hidden="true">
            <i className={`ph ${iconFor(node.type)}`} />
          </span>
          <div className="cfg__heading">
            <input
              className="cfg__title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="节点标题"
            />
            <p className="cfg__kind">
              {definition.title} · {definition.summary}
            </p>
          </div>
          <button type="button" className="cfg__close" onClick={onClose} aria-label="关闭配置">
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </header>

        <nav className="cfg__tabs" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`cfg-tab-${name}`}
              aria-selected={tab === name}
              aria-controls="cfg-panel"
              // roving tabindex：未选中的退出 Tab 序列，左右键切换
              tabIndex={tab === name ? 0 : -1}
              className="cfg__tab"
              onClick={() => setTab(name)}
              onKeyDown={(event) => {
                const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (delta === 0) return;
                event.preventDefault();
                const index = TABS.indexOf(name); // 从焦点所在的按钮出发，不是从当前选中项 ——
                // roving tabindex 下焦点与选中经常不在同一项
                const next = TABS[(index + delta + TABS.length) % TABS.length];
                if (next) {
                  setTab(next);
                  document.getElementById(`cfg-tab-${next}`)?.focus();
                }
              }}
            >
              {name}
            </button>
          ))}
          <span className="cfg__tabs-grow" />
          <span className="cfg__scope">改动只影响草稿</span>
        </nav>

        <div
          className="cfg__body"
          id="cfg-panel"
          role="tabpanel"
          aria-labelledby={`cfg-tab-${tab}`}
        >
          {tab === '配置' ? (
            <div className="cfg__fields">
              {fields.map((field) => (
                <SchemaField
                  key={field.key}
                  field={field}
                  value={draft[field.key]}
                  {...(field.reference && references?.[field.reference]
                    ? { referenceOptions: references[field.reference] }
                    : {})}
                  {...(fieldErrors[field.key] ? { error: fieldErrors[field.key] } : {})}
                  onChange={(next) => setDraft((prev) => ({ ...prev, [field.key]: next }))}
                  onParseError={(parseError) => {
                    setJsonErrors((prev) => {
                      const next = { ...prev };
                      if (parseError) next[field.key] = `JSON 无法解析：${parseError}`;
                      else delete next[field.key];
                      return next;
                    });
                    // 修好后同步清掉提交时复制进 fieldErrors 的那份 ——
                    // 不清的话红字残留到下一次提交(codex 复核抓到的)
                    if (!parseError) {
                      setFieldErrors((prev) => {
                        if (!(field.key in prev)) return prev;
                        const next = { ...prev };
                        delete next[field.key];
                        return next;
                      });
                    }
                  }}
                />
              ))}
            </div>
          ) : null}

          {tab === '输入 / 输出' ? (
            <IoTab node={node} inCount={inCount} outCount={outCount} />
          ) : null}

          {tab === '权限与能力' ? <PermissionsTab node={node} /> : null}

          {tab === '重试与超时' ? <RetryTab node={node} fields={fields} /> : null}
        </div>

        <footer className="cfg__foot">
          <span className="cfg__foot-note">改动保存到草稿，不影响已发布版本</span>
          <span className="cfg__tabs-grow" />
          <Button onClick={onClose}>取消</Button>
          {/* 「测试运行此节点」还没做：它要能只跑一个节点而不动整条流程，
              引擎目前只按图执行。禁用并说明，比给一个点了没反应的按钮好 */}
          <Button disabled title="单节点试运行还没做，现在只能跑整条工作流">
            测试运行此节点
          </Button>
          <Button variant="primary" onClick={onSubmit}>
            保存到草稿
          </Button>
        </footer>
      </div>
    </div>
  );
}

function IoTab({
  node,
  inCount,
  outCount,
}: {
  node: GraphNode;
  inCount: number;
  outCount: number;
}) {
  const definition = getNodeDefinition(node.type);
  const outputs = resolveNodeOutputs(node.type, node.config);

  return (
    <div className="cfg__io">
      <div className="cfg__topo">
        <i className="ph ph-flow-arrow" aria-hidden="true" />
        <div>
          <p className="cfg__topo-title">
            {inCount} 条入边 · {outCount} 条出边
          </p>
          <p className="cfg__topo-sub">
            {inCount > 1 ? '多入边：需要在画布上设置汇聚策略' : '执行语义由连线决定'}
          </p>
        </div>
        <span className="cfg__topo-note">只读 · 在画布上改连线</span>
      </div>

      {definition.ports.inputs.map((port) => (
        <div key={`in-${port.id}`} className="cfg__port">
          <span>输入 · {port.label}</span>
          <code>上游节点的输出字段</code>
        </div>
      ))}

      {outputs.map((port) => (
        <div key={`out-${port.id}`} className="cfg__port">
          <span>输出 · {port.label}</span>
          <code>{`\${${node.id}.${port.id}}`}</code>
        </div>
      ))}

      <p className="cfg__hint-block">
        下游节点按字段引用这些输出，文本拼接只作兼容方式。可记录字段与必须脱敏字段在节点定义里声明。
      </p>
    </div>
  );
}

function PermissionsTab({ node }: { node: GraphNode }) {
  const definition = getNodeDefinition(node.type);
  const caps = { ...definition.defaultCapabilities, ...node.capabilities };

  return (
    <div className="cfg__perm">
      <div className="cfg__caps">
        <p className="cfg__caps-title">
          <i className="ph ph-shield-check" aria-hidden="true" />
          能力声明（写进提示词交给 agent，引擎不强制）
        </p>
        <div className="cfg__caps-list">
          <code>文件：{caps.file}</code>
          <code>命令：{caps.command}</code>
          <code>网络：{caps.network}</code>
          <code>记忆：{caps.memory}</code>
          <code>凭据：{caps.secret?.length ? caps.secret.join(', ') : '未授予'}</code>
        </div>
      </div>

      {definition.externalWrite ? (
        <p className="cfg__warn">
          这个节点会写到这台机器之外。想在它之前停一下，就在画布上给它前面接一个「审批」节点 ——
          引擎不会替你拦。
        </p>
      ) : null}

      {/* 说清这几行字到底是什么。
          原来写的是「由引擎强制，Prompt 无法越权」，而引擎已经不强制了 ——
          界面承诺一件实现里没有的事，比不承诺更糟（CLAUDE.md 第二条纪律） */}
      <p className="cfg__hint-block">
        <strong>权限由流程管，不由节点各自管。</strong>
        执行节点拿到的是最高权限；要不要停下来问，取决于工作流里有没有在这个位置放一道「审批」节点
        —— 比如「探索完成 → 开始编辑」之间、「编码完成 → 开 PR」之间。
      </p>
      <p className="cfg__hint-block">
        上面这几项会拼进提示词交给 agent，请它自觉遵守；引擎**不**逐项拦截。
        要硬性的边界，用审批节点。
      </p>
    </div>
  );
}

function RetryTab({ node, fields }: { node: GraphNode; fields: FieldDescriptor[] }) {
  // 超时在部分节点类型的配置里（脚本、AI），统一在这一页显示实际取值
  const timeoutField = fields.find((f) => f.key === 'timeoutMs');
  const configured = (node.config as Record<string, unknown>)?.timeoutMs;
  const timeout = configured ?? timeoutField?.defaultValue;

  return (
    <div className="cfg__retry">
      <div>
        <p className="cfg__label">超时</p>
        <p className="cfg__readonly">
          {typeof timeout === 'number'
            ? `${Math.round(timeout / 60000)} min（墙钟）`
            : '该节点类型无超时设置'}
        </p>
      </div>
      <div>
        <p className="cfg__label">重试次数</p>
        <p className="cfg__readonly">
          {node.retry?.maxAttempts ?? 1} 次 · {node.retry?.backoff ?? 'exponential'}
        </p>
      </div>
      <div>
        <p className="cfg__label">重试模型 / 降级</p>
        <p className="cfg__readonly">{node.retry?.fallbackModel ?? '保持同模型'}</p>
      </div>
      <div>
        <p className="cfg__label">幂等策略</p>
        <p className="cfg__readonly">
          {node.retry?.idempotency === 'none' ? '不检查' : '副作用操作重试前检查外部状态'}
        </p>
      </div>
      <p className="cfg__hint-block cfg__retry-span">
        取消行为：收到取消信号后先停止子进程，再写入 node.cancelled 事件；已产生的 Artifact 保留。
        重试策略还不能改：引擎目前不读它，改了也不会生效。
      </p>
    </div>
  );
}
