import { z } from 'zod';
import { getNodeDefinition, type NodeType } from './definitions.js';

/**
 * 从节点的 configSchema 提取出「表单渲染需要知道的一切」。
 *
 * 这是「配置表单由 Schema 驱动渲染，新增节点类型不改 UI 代码」（功能文档 §14）
 * 的落点。UI 只认下面这几种 control，加节点类型只要写 Schema 与 describe。
 *
 * 约定：`.describe()` 的第一行是中文标签，其余行是字段提示。
 */

export type FieldControl =
  | 'text'
  | 'text-long'
  | 'number'
  | 'boolean'
  | 'enum'
  /** 字符串数组 → 图纸里的 chips。 */
  | 'list'
  /** Record<string, string> → 键值对表格。 */
  | 'key-value'
  /** 对象数组或任意 JSON → JSON 编辑框。 */
  | 'json';

export interface FieldDescriptor {
  key: string;
  label: string;
  hint?: string | undefined;
  control: FieldControl;
  required: boolean;
  /** enum 的可选值。 */
  options?: string[] | undefined;
  defaultValue?: unknown;
  /**
   * `z.string().meta({ reference: 'agentProfile' })` 带过来的：
   * 这个字段存的是库里某条记录的 id，表单该渲染成「从库里选」——
   * 自由文本要用户手打 `builtin:analyst` 这类内部 id，
   * 是三轮浏览器实测里最一致的阻断点。
   */
  reference?: 'agentProfile' | 'prompt' | undefined;
}

/**
 * 长文本由 Schema 自己声明：`z.string().meta({ long: true })`。
 *
 * 曾经是一张字段名白名单。同一个弹层里 `promptTemplate` 与 `script`
 * 的 Zod 类型完全一样（都是 `z.string()`），只因为名字不在表里，
 * 前者渲染成 34px 的单行 input —— 用户写不了多行提示词。
 *
 * 判据放回契约：谁定义字段，谁说清它要多大的框。
 */

interface JsonSchemaNode {
  type?: string | string[];
  /** `z.string().meta({ long: true })` 带过来的：这个框要多行。 */
  long?: boolean;
  /** `.meta({ reference })` 带过来的：这个字段引用库里的记录。 */
  reference?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

export function fieldDescriptors(type: NodeType): FieldDescriptor[] {
  // getNodeDefinition 对未登记类型会抛错，这里不做额外兜底
  const schema = getNodeDefinition(type).configSchema;
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchemaNode & { required?: string[] };

  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([key, node]) =>
    describeField(key, node, required.has(key)),
  );
}

function describeField(key: string, node: JsonSchemaNode, isRequired: boolean): FieldDescriptor {
  const [label = key, ...hintLines] = (node.description ?? key).split('\n');
  const hint = hintLines.join('\n').trim();

  const reference = node.reference ?? unwrap(node)?.reference;
  return {
    key,
    label,
    ...(hint ? { hint } : {}),
    control: controlFor(node),
    required: isRequired,
    ...(enumOptions(node) ? { options: enumOptions(node) } : {}),
    ...(node.default === undefined ? {} : { defaultValue: node.default }),
    ...(reference === 'agentProfile' || reference === 'prompt' ? { reference } : {}),
  };
}

function enumOptions(node: JsonSchemaNode): string[] | undefined {
  const values = node.enum ?? unwrap(node)?.enum;
  if (!values) return undefined;
  return values.filter((v): v is string => typeof v === 'string');
}

/** optional / default 会让 Zod 生成 anyOf；取出里面真正的类型节点。 */
function unwrap(node: JsonSchemaNode): JsonSchemaNode | undefined {
  const candidates = node.anyOf ?? node.oneOf;
  return candidates?.find((c) => c.type !== 'null');
}

/**
 * 这个字段该用哪种控件 —— **只看 Schema，不看字段名**。
 *
 * 参数里曾经有个 `key`，专门给长文本的字段名白名单用。
 * 去掉它是有意的：判据一旦沾上名字，改个字段名就会静默换控件。
 */
function controlFor(raw: JsonSchemaNode): FieldControl {
  const node = raw.type || raw.enum ? raw : (unwrap(raw) ?? raw);

  if (enumOptions(node)) return 'enum';

  const type = Array.isArray(node.type) ? node.type[0] : node.type;

  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'number':
      return 'number';
    case 'array': {
      const itemType = Array.isArray(node.items?.type) ? node.items?.type[0] : node.items?.type;
      // 标量数组用 chips（如成功退出码）；对象数组结构太自由，交给 JSON 编辑
      const scalar = itemType === 'string' || itemType === 'number' || itemType === 'integer';
      // 枚举数组（如严重度分级）也是一串短值，同样用 chips
      return scalar || node.items?.enum ? 'list' : 'json';
    }
    case 'object': {
      const additional = node.additionalProperties;
      if (additional && typeof additional === 'object') {
        const valueType = Array.isArray(additional.type) ? additional.type[0] : additional.type;
        if (valueType === 'string') return 'key-value';
      }
      return 'json';
    }
    case 'string':
      // meta({ long: true }) 会进 JSON Schema 的同名字段
      return node.long === true ? 'text-long' : 'text';
    default:
      // 没有 type 的（如 z.unknown()、union）一律 JSON 编辑，不猜
      return 'json';
  }
}
