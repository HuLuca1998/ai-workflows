import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../data/describeError.js';
import type { WorkflowGraph } from '../editor/editorDeps.js';
import { coreClient } from '../data/workspace.js';

/**
 * 启动表单 —— 严格照图纸的 660px 对话框。
 *
 * 「启动表单由入口节点的输入 Schema 自动生成」是图纸原话，
 * 所以字段一定从 schema 来，不写死。
 *
 * 依赖检查在**打开时**就跑（图纸里那块检查结果是直接显示的），
 * 没通过就拦住开始运行 —— 明知跑不通还让它跑起来，
 * 用户拿到的会是一个跑到一半失败的运行和一堆已经产生的副作用。
 */

interface VersionOption {
  id: string;
  version: number;
}

export interface LaunchDialogProps {
  workflowId: string;
  workflowName: string;
  graph: WorkflowGraph;
  /** 当前草稿修订。 */
  rev: number;
  versions: readonly VersionOption[];
  onClose: () => void;
  onStarted: (runId: string) => void;
}

interface Check {
  label: string;
  status: 'passed' | 'failed';
  detail: string;
}

interface DryRunReport {
  /** 实际会用的工作目录，由引擎决定 —— 前端猜不出应用数据目录在哪。 */
  workdir: string;
  checks: Check[];
  passed: number;
  failed: number;
  ok: boolean;
}

/**
 * 一个启动参数。
 *
 * `kind` 来自入口的 inputSchema。**丢掉类型的代价不是难看，是错**：
 * 整数字段拿到 "不是数字"、布尔字段拿到 "也不是布尔值"，
 * 运行照样成功，而后续节点拿到的参数类型是坏的。
 */
interface Field {
  key: string;
  label: string;
  required: boolean;
  kind: 'text' | 'number' | 'boolean' | 'enum';
  defaultValue: string;
  /** enum 的可选值。 */
  options?: string[];
  minimum?: number;
  maximum?: number;
}

export function LaunchDialog({
  workflowId,
  workflowName,
  graph,
  rev,
  versions,
  onClose,
  onStarted,
}: LaunchDialogProps) {
  const fields = useMemo(() => fieldsFromEntry(graph), [graph]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.defaultValue])),
  );
  const [versionId, setVersionId] = useState<string | null>(null);
  const [workdir, setWorkdir] = useState('');
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const target = versionId ? { versionId } : { draftRev: rev };

  useEffect(() => {
    let cancelled = false;
    void coreClient
      .call('run.dryRun', { workflowId, ...target, ...(workdir ? { workdir } : {}) })
      .then((result) => {
        if (!cancelled) setReport(result as DryRunReport);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, versionId, workdir]);

  const onStart = async () => {
    // 布尔字段的「false」也是填了 —— 用 trim() 判空会把它当成没填
    const empty = fields.filter(
      (field) => field.required && field.kind !== 'boolean' && !values[field.key]?.trim(),
    );
    if (empty.length > 0) {
      setMissing(empty.map((field) => field.key));
      return;
    }
    setMissing([]);
    setStarting(true);
    setError(null);
    try {
      const result = (await coreClient.call('run.start', {
        workflowId,
        ...target,
        inputs: coerce(fields, values),
        ...(workdir ? { workdir } : {}),
      })) as { runId: string };
      onStarted(result.runId);
    } catch (err) {
      // 留在表单里：关掉的话用户填的参数就没了，还得重来一遍
      setError(describeError(err));
    } finally {
      setStarting(false);
    }
  };

  const blocked = report !== null && !report.ok;

  return (
    <div className="launch__backdrop" onClick={onClose}>
      <div
        className="launch"
        role="dialog"
        aria-label={`运行 ${workflowName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="launch__head">
          <i className="ph ph-play-circle" aria-hidden="true" />
          <div>
            <p className="launch__title">运行 · {workflowName}</p>
            <p className="launch__sub">启动表单由入口节点的输入 Schema 自动生成</p>
          </div>
          <span className="launch__grow" />
          <button type="button" className="launch__close" aria-label="关闭" onClick={onClose}>
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </header>

        <div className="launch__body">
          <section>
            <p className="launch__label">运行版本</p>
            <div className="launch__seg" role="group" aria-label="运行版本">
              <button
                type="button"
                data-active={versionId === null ? 'true' : undefined}
                onClick={() => setVersionId(null)}
              >
                草稿 rev{rev}
              </button>
              {versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  data-active={versionId === version.id ? 'true' : undefined}
                  onClick={() => setVersionId(version.id)}
                >
                  v{version.version}
                </button>
              ))}
            </div>
            <p className="launch__note">
              {versionId
                ? '已发布版本不可变，这次运行会一直引用它'
                : '草稿会随编辑变化；运行记录里保存的是启动那一刻的修订号'}
            </p>
          </section>

          {fields.length > 0 ? (
            <section className="launch__fields">
              {fields.map((field) => (
                <label key={field.key} className="launch__field">
                  <span className="launch__label">
                    {/* id 挂在只含文本的这层：aria-labelledby 会取整个元素的
                        累积文本，星号一起进去的话字段的可读名就成了「数量 *」 */}
                    <span id={`launch-${field.key}`}>{field.label}</span>
                    {/* 星号是视觉标记，不进无障碍名 ——
                        否则字段的可读名字会变成「数量 *」 */}
                    {field.required ? (
                      <span className="launch__req" aria-hidden="true">
                        {' '}
                        *
                      </span>
                    ) : null}
                  </span>
                  <FieldInput
                    field={field}
                    value={values[field.key] ?? ''}
                    invalid={missing.includes(field.key)}
                    onChange={(next) => setValues((prev) => ({ ...prev, [field.key]: next }))}
                  />
                  {/* 只有红框的话读屏用户完全不知道为什么点了没反应 */}
                  {missing.includes(field.key) ? (
                    // 不重复字段名：错误就在字段下面，位置本身说明了是哪个，
                    // 重复一遍反而会和 label 撞成两个同名元素
                    <span className="launch__error">必填项，请填写</span>
                  ) : null}
                </label>
              ))}
            </section>
          ) : (
            <p className="launch__note">这个工作流不需要启动参数。</p>
          )}

          <section>
            <p className="launch__label">工作目录</p>
            <input
              className="launch__path"
              type="text"
              value={workdir}
              placeholder={report?.workdir ?? '正在读取默认目录…'}
              aria-label="工作目录"
              onChange={(event) => setWorkdir(event.target.value)}
            />
            <p className="launch__note">
              留空则用应用的运行目录。每次运行一个独立目录，并行运行互不影响。
            </p>
          </section>

          <section className="launch__checks">
            <p className="launch__checks-head">
              <i className="ph ph-list-checks" aria-hidden="true" />
              Dry Run 依赖检查
              <span className="launch__grow" />
              <span className="launch__checks-count">
                {report ? `${report.passed} 项通过 · ${report.failed} 项缺失` : '检查中…'}
              </span>
            </p>
            <div className="launch__checks-body">
              {(report?.checks ?? []).map((check) => (
                <p key={check.label} className="launch__check" data-status={check.status}>
                  <i
                    className={`ph-fill ${check.status === 'passed' ? 'ph-check-circle' : 'ph-x-circle'}`}
                    aria-hidden="true"
                  />
                  {check.label} · {check.detail}
                </p>
              ))}
            </div>
          </section>

          {error ? (
            <p className="launch__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="launch__foot">
          {blocked ? (
            <span className="launch__blocked">依赖检查未通过，先解决上面标出的问题</span>
          ) : null}
          <span className="launch__grow" />
          <button type="button" className="runs__action" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="runs__action runs__action--primary"
            disabled={blocked || starting}
            onClick={() => void onStart()}
          >
            <i className="ph ph-play" aria-hidden="true" />
            开始运行
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * 按类型渲染一个参数控件。
 *
 * 全用文本框的代价不是难看：整数字段拿到「不是数字」照样能启动运行，
 * 而后续节点拿到的参数是坏的 —— 那时的报错来自脚本，跟输入完全对不上。
 */
function FieldInput({
  field,
  value,
  invalid,
  onChange,
}: {
  field: Field;
  value: string;
  invalid: boolean;
  onChange: (next: string) => void;
}) {
  const shared = {
    'aria-labelledby': `launch-${field.key}`,
    'aria-invalid': invalid || undefined,
    'data-missing': invalid ? 'true' : undefined,
  } as const;

  if (field.kind === 'boolean') {
    return (
      <input
        {...shared}
        type="checkbox"
        checked={value === 'true'}
        onChange={(event) => onChange(String(event.target.checked))}
      />
    );
  }

  if (field.kind === 'enum') {
    return (
      <select {...shared} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">请选择</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      {...shared}
      type={field.kind === 'number' ? 'number' : 'text'}
      {...(field.minimum === undefined ? {} : { min: field.minimum })}
      {...(field.maximum === undefined ? {} : { max: field.maximum })}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

interface PropertySpec {
  type?: string;
  title?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

/**
 * 入口节点的 inputSchema → 表单字段。
 *
 * 类型信息一路带下来：JSON Schema 已经说清楚了每个字段是什么，
 * 全渲染成文本框等于把这份声明扔掉，然后指望用户不填错。
 */
function fieldsFromEntry(graph: WorkflowGraph): Field[] {
  const entry = graph.nodes.find((node) => node.type === 'entry');
  const schema = (entry?.config as { inputSchema?: unknown } | undefined)?.inputSchema as
    { required?: string[]; properties?: Record<string, PropertySpec> } | undefined;

  const properties = schema?.properties;
  if (!properties) return [];
  const required = new Set(schema.required ?? []);

  return Object.entries(properties).map(([key, spec]) => {
    const options = Array.isArray(spec.enum) ? spec.enum.map(String) : undefined;
    return {
      key,
      label: spec.title ?? key,
      required: required.has(key),
      kind: kindOf(spec, options),
      defaultValue: spec.default === undefined ? '' : String(spec.default),
      ...(options ? { options } : {}),
      ...(spec.minimum === undefined ? {} : { minimum: spec.minimum }),
      ...(spec.maximum === undefined ? {} : { maximum: spec.maximum }),
    };
  });
}

/** 认不出的类型退回文本框 —— 不为了统一而瞎猜。 */
function kindOf(spec: PropertySpec, options?: string[]): Field['kind'] {
  if (options && options.length > 0) return 'enum';
  if (spec.type === 'integer' || spec.type === 'number') return 'number';
  if (spec.type === 'boolean') return 'boolean';
  return 'text';
}

/**
 * 表单值 → 发给引擎的参数。
 *
 * 数字发成字符串的话，脚本里 `${input.count} + 1` 会变成字符串拼接 ——
 * 而那只有在跑到那一行时才会暴露。
 */
function coerce(fields: readonly Field[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === '') continue;
    switch (field.kind) {
      case 'number': {
        const parsed = Number(raw);
        out[field.key] = Number.isNaN(parsed) ? raw : parsed;
        break;
      }
      case 'boolean':
        out[field.key] = raw === 'true';
        break;
      default:
        out[field.key] = raw;
    }
  }
  return out;
}
