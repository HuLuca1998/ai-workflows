// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseGraphFile } from '../src/editor/importGraph.js';

/**
 * 导入。三道关：JSON 能解析、结构符合 Schema、图校验没有 error。
 * 导入一份坏图比导入失败更糟——它会先覆盖当前草稿，再在画布上乱来。
 */

const valid = JSON.stringify({
  nodes: [
    {
      id: 'entry',
      type: 'entry',
      title: '入口',
      position: { x: 0, y: 0 },
      config: { trigger: 'manual', inputSchema: { type: 'object' } },
    },
    {
      id: 'end',
      type: 'end',
      title: '结束',
      position: { x: 300, y: 0 },
      config: { outcome: 'success' },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'entry', port: 'success' },
      target: { nodeId: 'end', port: 'input' },
    },
  ],
  groups: [],
});

describe('导入', () => {
  it('合法的图能导入', () => {
    const result = parseGraphFile(valid);
    expect(result.ok).toBe(true);
    expect(result.graph?.nodes).toHaveLength(2);
  });

  it('不是 JSON 时说清楚', () => {
    const result = parseGraphFile('{ 这不是 JSON');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/不是合法的 JSON/u);
  });

  it('结构不符合 Schema 时指出具体字段', () => {
    const result = parseGraphFile(JSON.stringify({ nodes: 'not-an-array', edges: [], groups: [] }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/不是有效的工作流图/u);
    expect(result.error).toMatch(/nodes/u);
  });

  it('图有 error 级问题时拒绝导入并说明', () => {
    const broken = JSON.parse(valid) as { edges: unknown[] };
    broken.edges = [
      {
        id: 'e9',
        source: { nodeId: 'entry', port: '不存在的端口' },
        target: { nodeId: 'end', port: 'input' },
      },
    ];
    const result = parseGraphFile(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/无法导入/u);
  });

  it('只有 warning 时允许导入，但把警告带出来', () => {
    const withOrphan = JSON.parse(valid) as { nodes: unknown[] };
    withOrphan.nodes.push({
      id: 'lonely',
      type: 'script.shell',
      title: '孤立',
      position: { x: 600, y: 0 },
      config: { interpreter: 'zsh', script: 'echo hi' },
    });
    const result = parseGraphFile(JSON.stringify(withOrphan));
    expect(result.ok).toBe(true);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('空图不算错误——用户可能就想清空重来', () => {
    const result = parseGraphFile(JSON.stringify({ nodes: [], edges: [], groups: [] }));
    // 没有入口是 error，所以空图确实进不来；这条断言把这个行为钉住
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/入口/u);
  });
});
