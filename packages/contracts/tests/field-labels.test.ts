import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NODE_TYPES, fieldDescriptors, getNodeDefinition } from '../src/nodes/index.js';

/**
 * 配置表单由 Schema 驱动渲染，新增节点类型不改 UI 代码（功能文档 §14）。
 *
 * 要做到这一点，**中文标签必须来自 Schema 本身**——放在 UI 侧的映射表里，
 * 加一种节点类型就得改 UI，那条约束立刻失效。
 * 约定：`.describe()` 的第一行是标签，其余行是字段提示。
 */

describe('字段描述符', () => {
  it('16 种节点的每个顶层字段都有可读标签', () => {
    for (const type of NODE_TYPES) {
      const fields = fieldDescriptors(type);
      expect(fields.length, `${type} 没有可渲染的字段`).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.label, `${type}.${field.key} 缺标签`).toBeTruthy();
        // 标签等于字段名说明漏写了 describe，界面上会露出 camelCase 键名。
        // 不强制中文：MCP Server、Token 这类产品术语本来就是英文。
        expect(field.label, `${type}.${field.key} 的标签还是字段名`).not.toBe(field.key);
      }
    }
  });

  it('标签取 describe 的第一行，其余作为提示', () => {
    const fields = fieldDescriptors('ai.execute');
    const workdir = fields.find((f) => f.key === 'workdirSource');
    expect(workdir?.label).toBe('工作目录来源');
    // 这条提示是产品原则的一部分，必须能出现在界面上
    expect(workdir?.hint).toMatch(/引擎/u);
  });

  it('必填字段被标出来——刚拖进来的节点要能提示补哪些', () => {
    const fields = fieldDescriptors('ai.analyze');
    expect(fields.find((f) => f.key === 'agentProfileId')?.required).toBe(true);
    expect(fields.find((f) => f.key === 'promptId')?.required).toBe(false);
  });

  it('枚举字段带上可选值，渲染成下拉而不是文本框', () => {
    const interpreter = fieldDescriptors('script.shell').find((f) => f.key === 'interpreter');
    expect(interpreter?.control).toBe('enum');
    expect(interpreter?.options).toEqual(['zsh', 'bash', 'sh']);
  });

  it('控件类型覆盖 Schema 里出现的各种形状', () => {
    const shell = fieldDescriptors('script.shell');
    expect(shell.find((f) => f.key === 'script')?.control).toBe('text-long');
    expect(shell.find((f) => f.key === 'outputLimitBytes')?.control).toBe('number');
    expect(shell.find((f) => f.key === 'env')?.control).toBe('key-value');
    expect(shell.find((f) => f.key === 'successExitCodes')?.control).toBe('list');

    expect(fieldDescriptors('git.worktree').find((f) => f.key === 'fetch')?.control).toBe(
      'boolean',
    );
    expect(fieldDescriptors('entry').find((f) => f.key === 'inputSchema')?.control).toBe('json');
  });

  it('默认值一并给出，表单能显示「留空即用默认」', () => {
    const cleanup = fieldDescriptors('git.worktree').find((f) => f.key === 'cleanupPolicy');
    expect(cleanup?.defaultValue).toBe('on_success');
  });

  it('未登记的类型取描述符时报错，不返回空数组糊过去', () => {
    expect(() => fieldDescriptors('ai.imagine' as never)).toThrow(/未登记/u);
  });
});

describe('与实际 Schema 一致', () => {
  it('描述符里的字段与 Schema 的键完全对应，不多不少', () => {
    for (const type of NODE_TYPES) {
      const schema = getNodeDefinition(type).configSchema;
      const jsonSchema = z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'input',
        unrepresentable: 'any',
      }) as { properties?: Record<string, unknown> };
      const schemaKeys = Object.keys(jsonSchema.properties ?? {}).sort();
      const descriptorKeys = fieldDescriptors(type)
        .map((f) => f.key)
        .sort();
      expect(descriptorKeys, `${type} 的字段对不上`).toEqual(schemaKeys);
    }
  });
});
