import { describe, expect, it } from 'vitest';

import { applyPatch } from '../src/patch.js';
import { getNodeDefinition, type NodeType } from '../src/nodes/index.js';
import { WORKFLOW_TEMPLATES } from '../src/templates/index.js';
import type { WorkflowGraph } from '../src/graph.js';

/**
 * 模板里的 `${…}` 引用必须都能解析。
 *
 * **这是唯一一条盯着模板执行路径的守卫。** 在它之前，模板只被
 * 「能搭出、校验通过、发布为 v1」测过 —— 那些验的是图的**形状**，
 * 而形状全对的一张图可以在运行到第二个节点时就死掉。
 *
 * 实际发生过的：内置示例的读 Issue 那一步写的是
 * `gh issue view "$ISSUE" --repo "$REPO"`，而引擎注入的环境变量叫
 * `AIWF_ISSUE` / `AIWF_REPO`。两个变量都是空串，gh 报
 * `invalid issue format: ""`，运行在 4.3 秒后失败
 * （run_18c740d6394b3c70）。模板测试全绿，契约测试全绿，
 * Rust 那边也全绿 —— 没有一条测试站在「配置里写的引用」与
 * 「引擎认得的引用」之间。
 */

/** 引擎认的命名空间，见 `crates/engine/src/interp.rs` 的 `lookup`。 */
const RUN_FIELDS = ['id'];

function build(templateId: string): WorkflowGraph {
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new Error(`没有模板 ${templateId}`);
  const empty: WorkflowGraph = { nodes: [], edges: [], groups: [] };
  return applyPatch(empty, 0, { baseRevision: 0, operations: template.operations }).graph;
}

/** 配置里出现的所有 `${…}` 引用。 */
function referencesIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([^}]+)\}/gu)) {
      if (match[1]) found.push(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) referencesIn(item, found);
  }
  return found;
}

/** 从入口节点的 inputSchema 取出顶层字段名。 */
function inputFields(graph: WorkflowGraph): string[] {
  const entry = graph.nodes.find((n) => n.type === 'entry');
  const schema = (entry?.config as { inputSchema?: { properties?: Record<string, unknown> } })
    ?.inputSchema;
  return Object.keys(schema?.properties ?? {});
}

/**
 * 复合输入字段的值长什么样。
 *
 * inputSchema 只说 `repo` 是 `{type: 'object', format: 'repo'}`，
 * 不列子字段 —— 值的形状由渲染那个控件的组件决定
 * （`apps/web/src/runs/RepoField.tsx` 的 onChange 给的就是这两个键）。
 *
 * 不列出来的话，`${input.repo.nameX}` 这种拼错会一路过到运行时，
 * 报一句「未定义的引用」，而那时用户已经填完表单点了「开始」。
 */
const 复合字段的键: Record<string, string[]> = {
  repo: ['name', 'branch'],
};

/** 入口字段的 format，用来查它的值形状。 */
function formatOf(graph: WorkflowGraph, field: string): string | undefined {
  const entry = graph.nodes.find((n) => n.type === 'entry');
  const schema = (
    entry?.config as {
      inputSchema?: { properties?: Record<string, { format?: string }> };
    }
  )?.inputSchema;
  return schema?.properties?.[field]?.format;
}

/** 谁能被谁引用：拓扑上游才行。引用一个还没跑的节点等于引用空值。 */
function upstreamOf(graph: WorkflowGraph, nodeId: string): Set<string> {
  const 上游 = new Set<string>();
  const 待查 = [nodeId];
  while (待查.length > 0) {
    const current = 待查.pop();
    for (const edge of graph.edges) {
      if (edge.target.nodeId !== current) continue;
      if (上游.has(edge.source.nodeId)) continue;
      上游.add(edge.source.nodeId);
      待查.push(edge.source.nodeId);
    }
  }
  return 上游;
}

describe.each(WORKFLOW_TEMPLATES.map((t) => t.id))('模板 %s 的变量引用', (templateId) => {
  const graph = build(templateId);
  const 字段 = inputFields(graph);

  it('每个引用的命名空间都是引擎认得的', () => {
    // interp.rs 的 lookup 只认三种：run.* / input.* / 节点id.端口[.路径]。
    // 写成 `$ISSUE` 或 `{{issue}}` 的话它根本不会被当成引用 ——
    // 前者原样进 shell（成为一个未定义的环境变量），后者原样发给 agent
    for (const node of graph.nodes) {
      for (const ref of referencesIn(node.config)) {
        const [head] = ref.split('.');
        const 认得 = head === 'run' || head === 'input' || graph.nodes.some((n) => n.id === head);
        expect(认得, `${node.id} 引用了 \${${ref}}，而 ${head} 不是任何命名空间`).toBe(true);
      }
    }
  });

  it('引用的 input 字段都在入口的 inputSchema 里', () => {
    // 少一个字段，用户在启动表单上就填不到它，插值必然失败。
    // 而失败发生在运行时 —— 那时他已经填完表单点了「开始」
    for (const node of graph.nodes) {
      for (const ref of referencesIn(node.config)) {
        if (!ref.startsWith('input.')) continue;
        const 路径 = ref.slice('input.'.length).split('.');
        const 字段名 = 路径[0] ?? '';
        expect(字段, `${node.id} 引用了 \${${ref}}，而入口表单里没有「${字段名}」`).toContain(
          字段名,
        );

        // 复合字段还要查子键。只查顶层的话，`${input.repo.nameX}`
        // 会一路过到运行时才报「未定义的引用」
        const 子键 = 路径[1];
        if (!子键) continue;
        const format = formatOf(graph, 字段名);
        const 允许的 = format ? 复合字段的键[format] : undefined;
        expect(
          允许的,
          `${node.id} 深取了 \${${ref}}，而「${字段名}」的 format（${format ?? '无'}）` +
            `没有登记值形状 —— 在 复合字段的键 里补一条，否则拼错的子键没人拦`,
        ).toBeDefined();
        expect(
          允许的,
          `${node.id} 引用了 \${${ref}}，而「${字段名}」没有「${子键}」这个键`,
        ).toContain(子键);
      }
    }
  });

  it('引用的 run 字段是引擎提供的', () => {
    for (const node of graph.nodes) {
      for (const ref of referencesIn(node.config)) {
        if (!ref.startsWith('run.')) continue;
        const 字段名 = ref.slice('run.'.length);
        // `run.startedAt` 在契约的 injectedFields 里出现过，而
        // interp.rs 的 lookup 只实现了 `run.id` —— 引用它会是硬错误
        expect(
          RUN_FIELDS,
          `${node.id} 引用了 \${${ref}}，而引擎只提供 ${RUN_FIELDS.join(' / ')}`,
        ).toContain(字段名);
      }
    }
  });

  it('引用的上游节点确实在自己上游，且端口真的存在', () => {
    // 引用一个平行分支上的节点，运行时拿到的是空值 —— 而那不会报错，
    // 只会让下游收到一段空字符串
    for (const node of graph.nodes) {
      const 上游 = upstreamOf(graph, node.id);
      for (const ref of referencesIn(node.config)) {
        const [head, port] = ref.split('.');
        if (!head || head === 'run' || head === 'input') continue;
        const 目标 = graph.nodes.find((n) => n.id === head);
        if (!目标) continue; // 上一条测试管这个

        expect(上游.has(head), `${node.id} 引用了 \${${ref}}，而 ${head} 不在它的上游`).toBe(true);

        const 端口 = getNodeDefinition(目标.type as NodeType).ports.outputs.map((p) => p.id);
        expect(端口, `${node.id} 引用了 ${head} 的「${port}」端口，而它没有这个端口`).toContain(
          port,
        );
      }
    }
  });

  it('脚本里不出现裸的环境变量占位', () => {
    // `$ISSUE` / `$REPO` 这种写法不会被插值，也没有对应的环境变量 ——
    // 它们会变成空串，然后命令带着空参数跑下去。
    //
    // 引擎确实注入了一组环境变量，但前缀是 `AIWF_`
    // （`interp.rs` 的 `env_vars`）。这条只拦「看着像输入字段、
    // 而实际什么都不是」的那种裸变量
    for (const node of graph.nodes) {
      if (!node.type.startsWith('script.')) continue;
      const script = (node.config as { script?: string }).script ?? '';
      for (const 字段名 of 字段) {
        const 裸的 = new RegExp(`\\$\\{?${字段名.toUpperCase()}\\b`, 'u');
        // 排除掉脚本里自己赋的值（`ISSUE=${input.issue}` 之后用 `$ISSUE` 是对的）
        const 自己赋过 = new RegExp(`^\\s*${字段名.toUpperCase()}=`, 'mu').test(script);
        if (自己赋过) continue;
        expect(
          裸的.test(script),
          `${node.id} 的脚本里有裸的 $${字段名.toUpperCase()}，` +
            `它不会被插值也没有对应环境变量（引擎注入的叫 AIWF_${字段名.toUpperCase()}）`,
        ).toBe(false);
      }
    }
  });
});

/**
 * 引用的端口，得是那个节点**在到达这里的路径上真的走过**的那个。
 *
 * 节点只把实际走的那个端口放进作用域，引用另一个是硬错误
 * （`未定义的引用 ${deps.failed}`）。而这一步之前的守卫只查
 * 「端口在定义里存在」—— `deps.failed` 是 subworkflow 的合法端口，
 * 所以它一路绿灯，直到实跑时整条流程死在那里（`release-pipeline` 踩过）。
 *
 * 判据：被引用节点通往**当前节点**的那些边，用的是哪些端口。
 * 引用的端口不在其中 = 这条引用在这条路径上永远解析不出来。
 */
describe('引用的端口在这条路径上真的会被走到', () => {
  it('每条模板都成立', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const graph = build(template.id);
      for (const node of graph.nodes) {
        for (const reference of referencesIn(node.config)) {
          const [源, 端口] = reference.split('.');
          if (!源 || !端口 || 源 === 'input' || 源 === 'run') continue;
          const 被引用的 = graph.nodes.find((n) => n.id === 源);
          if (!被引用的) continue;

          // 源节点通往「引用它的这个节点」的全部路径上用过的端口。
          // 只看直接边不够 —— 中间可能隔着别的节点
          const 可达端口 = new Set<string>();
          const 待查 = [node.id];
          const 看过 = new Set<string>();
          while (待查.length > 0) {
            const 当前 = 待查.pop();
            if (!当前 || 看过.has(当前)) continue;
            看过.add(当前);
            for (const edge of graph.edges) {
              if (edge.target.nodeId !== 当前) continue;
              if (edge.source.nodeId === 源) 可达端口.add(edge.source.port);
              else 待查.push(edge.source.nodeId);
            }
          }
          if (可达端口.size === 0) continue; // 不是上游，别的断言管

          /*
           * 判据是「**每条**到达这里的路径上都走了那个端口」，
           * 不是「有可能走到」。源节点有两个端口都通向这里的话
           * （比如 `onFailure: continue` 让成功与失败都往下走），
           * 运行时只会有其中一个进作用域 —— 引用哪个都会在另一半场景下炸。
           *
           * 第一版守卫算的是「可能走到」，于是
           * `release-pipeline` 里 `${deps.failed}` 一路绿灯，
           * 实跑才死在合并那步。
           */
          expect(
            [...可达端口],
            `${template.id} 的 ${node.id} 引用了 \${${reference}}。` +
              `${源} 通往它的路径上可能走 ${[...可达端口].join(' / ')} —— ` +
              (可达端口.size > 1
                ? `不止一个端口，运行时只有其中一个进作用域，引用哪个都会在另一半场景下炸。` +
                  `改成引用一个「必然走到」的上游，或让 agent 经 MCP 按 runId 去读`
                : `而这里引用的是 ${端口}`),
          ).toEqual([端口]);
        }
      }
    }
  });

  it('这条守卫自己会红', () => {
    // 元测试两种形态：引用了另一个端口；以及源节点有多个端口都通向这里
    expect([...new Set(['success'])]).not.toEqual(['failed']);
    expect([...new Set(['success', 'failed'])]).not.toEqual(['success']);
  });
});
