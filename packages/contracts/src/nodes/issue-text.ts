import type { z } from 'zod';

/**
 * 把 Zod 的校验 issue 翻成用户看得懂的一句话。
 *
 * Zod 默认吐的是英文（`Too small: expected string to have >=1 characters`），
 * 而节点配置表单是 Schema 驱动渲染的 —— 校验文案也该由 Schema 驱动，
 * 不该在每个界面里各写一遍 if。
 *
 * 字段的中文名已经在 `.describe()` 里了，这里只是把它和 issue 拼起来。
 *
 * 刻意**不用** Zod 的全局 error map：那会连带改掉所有校验的文案，
 * 包括契约自身那些本就该给开发者看的（「未登记的 Core API 方法」之类）。
 */
export function describeIssue(issue: z.core.$ZodIssue, schema: z.ZodType): string {
  const name = fieldName(issue.path, schema);

  switch (issue.code) {
    case 'invalid_type':
      // 值缺席与类型不对是同一个 code，得看 input 才分得出来
      return issue.input === undefined
        ? `${name}是必填项`
        : `${name}的类型不对，应当是${typeName(issue.expected)}`;

    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string') {
        return min <= 1 ? `${name}不能为空` : `${name}至少需要 ${min} 个字符`;
      }
      if (issue.origin === 'array') {
        return min <= 1 ? `${name}至少要选一项` : `${name}至少要 ${min} 项`;
      }
      return `${name}不能小于 ${min}`;
    }

    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return `${name}最多 ${max} 个字符`;
      if (issue.origin === 'array') return `${name}最多 ${max} 项`;
      return `${name}不能大于 ${max}`;
    }

    case 'invalid_value': {
      const values = 'values' in issue ? issue.values : [];
      return values.length > 0 ? `${name}只能是：${values.join(' / ')}` : `${name}的取值不合法`;
    }

    case 'invalid_format':
      return `${name}的格式不对`;

    case 'unrecognized_keys':
      return `多了不认识的字段：${issue.keys.join('、')}`;

    case 'invalid_union':
      return `${name}不符合任何一种允许的形式`;

    default:
      // custom 之类带自定义 message 的直接用它 —— 那本来就是中文写的
      return issue.message || `${name}不合法`;
  }
}

/**
 * 从 Schema 里取字段的中文名。
 *
 * 取不到就退回路径本身 —— 显示 `weird_field` 也好过显示一句英文。
 */
/**
 * 字段的人话标签。
 *
 * 导出给图校验复用 —— 占位值那条 warning 要说「任务指令、Agent 角色」
 * 而不是 `instruction、agentProfileId`，而那份映射就在 `.describe()` 里。
 */
export function fieldName(path: readonly PropertyKey[], schema: z.ZodType): string {
  if (path.length === 0) return '这一项';

  const described = describeAt(path, schema);
  // `.describe()` 的第一行是标签，其余行是字段提示（约定见 fields.ts）。
  // 整段拿来当字段名的话，一条校验错误会把「白名单：任意可执行文件会绕过
  // 命令能力声明」这种整段说明塞进句子中间
  return described?.split('\n')[0] || path.map(String).join('.');
}

/** 沿路径下钻找 `.describe()`。找不到返回 undefined。 */
function describeAt(path: readonly PropertyKey[], schema: z.ZodType): string | undefined {
  let current: unknown = schema;

  for (const key of path) {
    const shape = shapeOf(current);
    if (!shape) return undefined;
    current = shape[String(key)];
    if (!current) return undefined;
  }

  const meta = (current as { description?: string }).description;
  return meta && meta.length > 0 ? meta : undefined;
}

/** 拿到 object schema 的 shape，顺带穿过 optional / default 这类包装。 */
function shapeOf(schema: unknown): Record<string, z.ZodType> | undefined {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
  if (!def) return undefined;

  if (def['type'] === 'object') {
    return def['shape'] as Record<string, z.ZodType>;
  }
  // optional / default / nullable 包了一层，往里再看一层
  if ('innerType' in def) return shapeOf(def['innerType']);
  return undefined;
}

function typeName(expected: string): string {
  const names: Record<string, string> = {
    string: '文本',
    number: '数字',
    boolean: '是 / 否',
    array: '列表',
    object: '对象',
  };
  return names[expected] ?? expected;
}
