import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_TYPES,
  getNodeDefinition,
  resolveNodeOutputs,
  type NodeType,
} from '../src/nodes/index.js';

/**
 * 节点目录生成物。
 *
 * 存在的理由：**Rust 侧要能照着契约校验一张图**。
 * `workflow.patch` / `workflow.validate` 原先只有 TypeScript 一份实现，
 * 于是通过 MCP 连进来的 Agent 根本改不动工作流 —— 它只够得着
 * `workflow_save_draft`（整份回写），而那正是技术选型 §6 明令禁止的路径。
 *
 * 节点的**端口**是校验连线的前提，而端口只活在 `definitions.ts` 里。
 * 生成物把它带过语言边界；这份测试守住它与契约源一致。
 */

const catalog = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'generated', 'node-catalog.json'), 'utf8'),
) as Record<
  string,
  {
    title: string;
    group: string;
    summary: string;
    icon: string;
    ports: { inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[] };
    dynamicOutputs?: {
      casesField: string;
      portField: string;
      defaultPortField: string;
      fallbackPort: string;
    };
    defaultCapabilities: Record<string, unknown>;
    externalWrite: boolean;
    singleton: boolean;
    seed: Record<string, unknown> | null;
  }
>;

describe('节点目录生成物', () => {
  it('每种节点类型都在里面，没有多余的', () => {
    expect(Object.keys(catalog).sort()).toEqual([...NODE_TYPES].sort());
  });

  it('端口、图标、能力、externalWrite 与契约源逐字一致', () => {
    for (const type of NODE_TYPES) {
      const def = getNodeDefinition(type);
      const entry = catalog[type];
      expect(entry, `${type} 不在目录里`).toBeDefined();
      expect(entry!.title).toBe(def.title);
      expect(entry!.group).toBe(def.group);
      expect(entry!.summary).toBe(def.summary);
      expect(entry!.icon).toBe(def.icon);
      expect(entry!.ports).toEqual(def.ports);
      expect(entry!.defaultCapabilities).toEqual(def.defaultCapabilities);
      expect(entry!.externalWrite).toBe(def.externalWrite);
      expect(entry!.singleton).toBe(def.singleton ?? false);
      expect(entry!.seed ?? undefined).toEqual(def.seed);
    }
  });

  it('入口节点是全图唯一的那个', () => {
    const singletons = NODE_TYPES.filter((type) => catalog[type]?.singleton);
    expect(singletons).toEqual(['entry']);
  });
});

describe('动态输出端口是声明，不是闭包', () => {
  /**
   * 按目录里的声明推导端口 —— 这段就是 Rust 侧会写的那段逻辑。
   * 它与 `resolveNodeOutputs` 必须给出同一个答案，否则 Rust 校验出的
   * 「没有这个输出端口」在界面上根本复现不了。
   */
  const 照声明推导 = (type: NodeType, config: unknown) => {
    const entry = catalog[type];
    const rule = entry?.dynamicOutputs;
    if (!rule) return entry?.ports.outputs ?? [];

    const record = (config ?? {}) as Record<string, unknown>;
    const cases = Array.isArray(record[rule.casesField]) ? record[rule.casesField] : [];
    const ports = (cases as Record<string, unknown>[])
      .map((item) => item?.[rule.portField])
      .filter((port): port is string => typeof port === 'string' && port.length > 0)
      .map((port) => ({ id: port, label: port }));

    const fallback = record[rule.defaultPortField];
    const defaultPort =
      typeof fallback === 'string' && fallback.length > 0 ? fallback : rule.fallbackPort;
    return [...ports, { id: defaultPort, label: defaultPort }];
  };

  it('只有条件分支是动态的', () => {
    const dynamic = NODE_TYPES.filter((type) => catalog[type]?.dynamicOutputs);
    expect(dynamic).toEqual(['branch']);
  });

  const 样本: unknown[] = [
    {},
    { cases: [] },
    { cases: [{ port: 'high', when: 'x' }] },
    {
      cases: [
        { port: 'high', when: 'x' },
        { port: 'low', when: 'y' },
      ],
    },
    { cases: [{ port: 'high', when: 'x' }], defaultPort: '兜底' },
    // 配置写坏的形态也要对齐：模型提议的配置常常是半成品，
    // 两侧在这里分叉的话，界面说「可以」而 Rust 说「不行」
    { cases: 'not-an-array' },
    { cases: [{ when: '缺 port' }] },
    { defaultPort: '' },
  ];

  it.each(样本)('与 resolveNodeOutputs 对同一份配置给出同一组端口：%j', (config) => {
    expect(照声明推导('branch', config)).toEqual(resolveNodeOutputs('branch', config));
  });

  it('静态端口的节点两边也一致', () => {
    for (const type of NODE_TYPES) {
      if (catalog[type]?.dynamicOutputs) continue;
      expect(照声明推导(type, {}), type).toEqual(resolveNodeOutputs(type, {}));
    }
  });
});
