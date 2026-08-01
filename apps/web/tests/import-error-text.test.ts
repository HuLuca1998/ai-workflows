import { describe, expect, it } from 'vitest';
import { parseGraphFile } from '../src/editor/importGraph.js';

/**
 * 导入失败时说人话。
 *
 * 第三方巡检 A-07 实测，中文界面里夹着裸的英文校验器输出：
 *
 * - 非 JSON → `不是合法的 JSON：Unexpected token 'h', "this is not"... is not valid JSON`
 * - 结构不对 → `不是有效的工作流图 —— nodes: Invalid input: expected array, received undefined；…`
 *
 * 对照组就在同一条链路的下一层，写得很好：
 * 「图存在 1 个错误，无法导入：工作流缺少入口节点，启动表单无从生成」。
 * 只有最外两层漏了。
 */

describe('导入失败的文案是中文的', () => {
  it('不是 JSON 时不甩 V8 的原文', () => {
    const result = parseGraphFile('this is not json');
    expect(result.ok).toBe(false);
    expect(result.error, '英文原文进了中文界面').not.toMatch(/Unexpected token|is not valid JSON/u);
    expect(result.error).toMatch(/JSON/u);
  });

  it('不是 JSON 时说清该怎么办', () => {
    const result = parseGraphFile('{ 半个');
    // 用户手上多半是个从别处拷来的文件，要告诉他该拿什么样的文件
    expect(result.error).toMatch(/导出|工作流/u);
  });

  it('结构不对时不甩 Zod 的英文', () => {
    const result = parseGraphFile('{"hello":"world"}');
    expect(result.ok).toBe(false);
    expect(result.error, 'Zod 的英文原文进了中文界面').not.toMatch(
      /Invalid input|expected array|received undefined/u,
    );
  });

  it('结构不对时点名缺了哪个字段', () => {
    const result = parseGraphFile('{"hello":"world"}');
    expect(result.error).toMatch(/nodes|节点/u);
  });

  it('图有错时那层文案原样保留 —— 它本来就写得好', () => {
    const 空图 = JSON.stringify({ nodes: [], edges: [], groups: [] });
    const result = parseGraphFile(空图);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/入口节点/u);
  });

  it('正常的图照常导入', () => {
    const 图 = {
      nodes: [
        {
          id: 'n1',
          type: 'entry',
          title: '入口设置',
          position: { x: 0, y: 0 },
          config: { trigger: 'manual', inputSchema: { type: 'object' } },
        },
        {
          id: 'n2',
          type: 'end',
          title: '结束',
          position: { x: 300, y: 0 },
          config: { outcome: 'success' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', port: 'success' },
          target: { nodeId: 'n2', port: 'input' },
        },
      ],
      groups: [],
    };
    const result = parseGraphFile(JSON.stringify(图));
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
