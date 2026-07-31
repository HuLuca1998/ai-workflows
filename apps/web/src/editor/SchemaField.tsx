import { useId, useState } from 'react';
import type { FieldDescriptor } from './editorDeps.js';

export interface ReferenceOption {
  value: string;
  label: string;
}

export interface SchemaFieldProps {
  field: FieldDescriptor;
  value: unknown;
  error?: string;
  onChange: (next: unknown) => void;
  /**
   * 引用字段（field.reference）的候选。给了就渲染成下拉 ——
   * 自由文本要用户手打 `builtin:analyst` 这类内部 id，
   * 是三轮浏览器实测里最一致的阻断点（S4/P5/#3）。
   */
  referenceOptions?: ReferenceOption[];
  /**
   * JSON 控件的解析状态上报。不上报的话，「红字报错」与「保存放行」
   * 会同时成立 —— 保存的是上一次能解析的旧值，用户看到的和存下的不一致。
   */
  onParseError?: (error: string | null) => void;
}

/**
 * 单个字段的渲染。控件由描述符的 control 决定，这里只认那七种——
 * 新增节点类型不该改这个文件（功能文档 §14）。
 *
 * 布局照图纸的弹层字段：标签 11.5px · 控件行 34px · 提示 11.5px。
 */
export function SchemaField({
  field,
  value,
  error,
  onChange,
  onParseError,
  referenceOptions,
}: SchemaFieldProps) {
  const id = useId();
  const describedBy = [field.hint ? `${id}-hint` : null, error ? `${id}-err` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="cfg-field" data-invalid={error ? 'true' : undefined}>
      <label className="cfg__label" htmlFor={id}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>

      <Control
        id={id}
        field={field}
        value={value}
        onChange={onChange}
        {...(describedBy ? { describedBy } : {})}
        {...(onParseError ? { onParseError } : {})}
        {...(referenceOptions ? { referenceOptions } : {})}
      />

      {field.hint ? (
        <p className="cfg__field-hint" id={`${id}-hint`}>
          {field.hint}
        </p>
      ) : null}
      {error ? (
        <p className="cfg__field-error" id={`${id}-err`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Control({
  id,
  field,
  value,
  onChange,
  describedBy,
  onParseError,
  referenceOptions,
}: {
  id: string;
  field: FieldDescriptor;
  value: unknown;
  onChange: (next: unknown) => void;
  describedBy?: string | undefined;
  onParseError?: ((error: string | null) => void) | undefined;
  referenceOptions?: ReferenceOption[] | undefined;
}) {
  // 引用字段优先于按类型分派:它在 Schema 里就是 string,
  // 但值必须来自库 —— 自由文本填出幽灵引用只能等到 Dry Run 才发现
  if (field.reference && referenceOptions) {
    const current = typeof value === 'string' ? value : '';
    const known = referenceOptions.some((option) => option.value === current);
    return (
      <select
        id={id}
        required={field.required}
        aria-describedby={describedBy}
        className="cfg__control"
        value={current}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      >
        {field.required ? (
          current === '' ? (
            <option value="">请选择</option>
          ) : null
        ) : (
          <option value="">未设置（用内建）</option>
        )}
        {/* 当前值不在库里也要显示出来 —— 静默换掉等于替用户改配置 */}
        {current !== '' && !known ? (
          <option value={current}>{current}（在库里找不到）</option>
        ) : null}
        {referenceOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  const common = {
    id,
    required: field.required,
    'aria-describedby': describedBy,
    'aria-invalid': undefined,
  } as const;

  switch (field.control) {
    case 'enum':
      return (
        <select
          {...common}
          className="cfg__control"
          value={String(value ?? field.defaultValue ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* 非必填给一个空选项，否则用户没法把值清掉 */}
          {field.required ? null : <option value="">未设置</option>}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );

    case 'boolean':
      return (
        <label className="cfg__switch">
          <input
            {...common}
            type="checkbox"
            checked={Boolean(value ?? field.defaultValue)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{(value ?? field.defaultValue) ? '开启' : '关闭'}</span>
        </label>
      );

    case 'number':
      return (
        <input
          {...common}
          type="number"
          className="cfg__control"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );

    case 'text-long':
      return (
        <textarea
          {...common}
          className="cfg__control cfg__control--long"
          rows={5}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'list':
      return <ListControl id={id} value={value} onChange={onChange} describedBy={describedBy} />;

    case 'key-value':
      return (
        <KeyValueControl id={id} value={value} onChange={onChange} describedBy={describedBy} />
      );

    case 'json':
      return (
        <JsonControl
          id={id}
          value={value}
          onChange={onChange}
          describedBy={describedBy}
          {...(onParseError ? { onParseError } : {})}
        />
      );

    default:
      return (
        <input
          {...common}
          type="text"
          className="cfg__control"
          value={String(value ?? '')}
          // 可选字段清空 = 回到「未设置」。存空串的话 Zod 的 min(1) 会拒,
          // 用户按应用自己的自救指引「清空该字段」都做不到(第 4 轮实测 #2)
          onChange={(e) =>
            onChange(e.target.value === '' && !field.required ? undefined : e.target.value)
          }
        />
      );
  }
}

/** 标量数组 → 图纸里的 chips：每项一个小块，末尾一个 + 添加。 */
function ListControl({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  describedBy?: string | undefined;
}) {
  const items = Array.isArray(value) ? value : [];
  const [pending, setPending] = useState('');

  const add = () => {
    const text = pending.trim();
    if (!text) return;
    // 原本是数字数组就保持数字，避免把 0 变成 "0"
    const numeric = items.length > 0 && items.every((i) => typeof i === 'number');
    onChange([...items, numeric && !Number.isNaN(Number(text)) ? Number(text) : text]);
    setPending('');
  };

  return (
    <div className="cfg__chips">
      {items.map((item, index) => (
        <span key={`${String(item)}-${index}`} className="cfg__chip">
          {String(item)}
          <button
            type="button"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            aria-label={`移除 ${String(item)}`}
          >
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="cfg__chip-input"
        value={pending}
        aria-describedby={describedBy}
        aria-label="添加一项"
        onChange={(e) => setPending(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder="+"
      />
    </div>
  );
}

/** Record<string, string> → 键值对表格。 */
function KeyValueControl({
  id,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  describedBy?: string | undefined;
}) {
  // 行在本地渲染，配置只收非空键的行。第一版没有本地行：
  // 新行键是空串，被空键过滤当场丢掉 ——「+ 添加一项」是个死按钮（P9）
  const [rows, setRows] = useState<[string, string][]>(() =>
    Object.entries((value ?? {}) as Record<string, string>),
  );
  const entries = rows;

  const update = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim() !== '')));
  };

  return (
    <div className="cfg__kv" id={id} aria-describedby={describedBy}>
      {/* key 不能含键名：那样键每敲一个字符整行重挂、焦点丢失 */}
      {entries.map(([key, val], index) => (
        <div key={index} className="cfg__kv-row">
          <input
            className="cfg__control"
            value={key}
            aria-label={`键 ${index + 1}`}
            onChange={(e) => {
              const next = [...entries] as [string, string][];
              next[index] = [e.target.value, val];
              update(next);
            }}
          />
          <input
            className="cfg__control"
            value={val}
            aria-label={`值 ${index + 1}`}
            onChange={(e) => {
              const next = [...entries] as [string, string][];
              next[index] = [key, e.target.value];
              update(next);
            }}
          />
          <button
            type="button"
            className="cfg__kv-remove"
            onClick={() => update(entries.filter((_, i) => i !== index) as [string, string][])}
            aria-label={`移除 ${key}`}
          >
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="cfg__kv-add"
        onClick={() => update([...entries, ['', '']] as [string, string][])}
      >
        + 添加一项
      </button>
    </div>
  );
}

/**
 * 结构自由的字段（对象数组、任意 JSON）→ 文本编辑。
 * 解析失败时保留用户输入并提示，不悄悄丢掉他写的东西。
 */
function JsonControl({
  id,
  value,
  onChange,
  describedBy,
  onParseError,
}: {
  id: string;
  value: unknown;
  onChange: (next: unknown) => void;
  describedBy?: string | undefined;
  onParseError?: ((error: string | null) => void) | undefined;
}) {
  // 未设置就显示空 —— stringify(null) 会在文本域里印出字符串「null」
  const [text, setText] = useState(() =>
    value === undefined || value === null ? '' : JSON.stringify(value, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div className="cfg__json">
      <textarea
        id={id}
        className="cfg__control cfg__control--long cfg__control--mono"
        rows={6}
        value={text}
        aria-describedby={describedBy}
        onChange={(e) => {
          setText(e.target.value);
          // 清空 = 回到「未设置」，不是一次 JSON 解析失败
          if (e.target.value.trim() === '') {
            onChange(undefined);
            setParseError(null);
            onParseError?.(null);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setParseError(null);
            onParseError?.(null);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setParseError(message);
            onParseError?.(message);
          }
        }}
      />
      {parseError ? (
        <p className="cfg__field-error" role="alert">
          JSON 无法解析：{parseError}
        </p>
      ) : null}
    </div>
  );
}
