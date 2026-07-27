import { useMemo, useState } from 'react';
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
import { SchemaField } from './SchemaField.jsx';

export interface NodeConfigDialogProps {
  node: GraphNode;
  graph: WorkflowGraph;
  onClose: () => void;
  onSave: (config: unknown, title: string) => void;
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
export function NodeConfigDialog({ node, graph, onClose, onSave }: NodeConfigDialogProps) {
  const definition = getNodeDefinition(node.type);
  const fields = useMemo(() => fieldDescriptors(node.type), [node.type]);
  const [tab, setTab] = useState<Tab>('配置');
  const [title, setTitle] = useState(node.title);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({
    ...(node.config as Record<string, unknown>),
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const inCount = graph.edges.filter((e) => e.target.nodeId === node.id).length;
  const outCount = graph.edges.filter((e) => e.source.nodeId === node.id).length;

  const onSubmit = () => {
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
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="cfg" role="dialog" aria-modal="true" aria-label={`配置 ${node.title}`}>
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
              aria-selected={tab === name}
              className="cfg__tab"
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
          <span className="cfg__tabs-grow" />
          <span className="cfg__scope">改动只影响草稿</span>
        </nav>

        <div className="cfg__body">
          {tab === '配置' ? (
            <div className="cfg__fields">
              {fields.map((field) => (
                <SchemaField
                  key={field.key}
                  field={field}
                  value={draft[field.key]}
                  {...(fieldErrors[field.key] ? { error: fieldErrors[field.key] } : {})}
                  onChange={(next) => setDraft((prev) => ({ ...prev, [field.key]: next }))}
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
          {/* 「测试运行此节点」要靠引擎，M2 接入前禁用并说明 */}
          <Button disabled title="单节点试运行需要执行引擎，M2 阶段接入">
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
          能力声明（由引擎强制，Prompt 无法越权）
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
          这个节点会产生外部写操作，运行时必须由审批或决策结果授权，重试前会核对外部状态。
        </p>
      ) : null}

      <p className="cfg__hint-block">
        扩大权限会让已保存的 Trusted Workflow 策略失效并要求重新确认。 能力的可视化编辑在 M3 随
        Agent 角色一起做——现在改这里等于改不了引擎的强制项。
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
        重试策略的编辑要等引擎（M2）——现在改这里没有执行方去读它。
      </p>
    </div>
  );
}
