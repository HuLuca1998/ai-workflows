import { describe, expect, it } from 'vitest';
import { applyPatch } from '../src/patch.js';
import { WORKFLOW_TEMPLATES } from '../src/templates/index.js';
import type { WorkflowGraph } from '../src/graph.js';

/**
 * 模板 shell 脚本里几种「本地语法检查看不见」的写法。
 *
 * `zsh -n` 只检查**本地这一份**。发给远端执行的字符串、
 * 拼进变量再 eval 的片段，语法错在本地一律看不出来 ——
 * 而它们照样让节点绿灯、JSON 合法、运行成功。
 *
 * 真发生过（独立复核实测）：`server-log-triage` 把管道符放在续行
 * **行首**，远端 bash 报 `syntax error near unexpected token '|'`。
 * `grep` 先跑完才炸，所以有输出；而 `sed` 归一化、`uniq -c` 计数、
 * `head -20` 截断三样一次都没执行。AI 拿到的是未去重的原始日志，
 * 而它的指令里写着「计数是归一化之后的」。
 */

function 全部脚本(): { 模板: string; 节点: string; 脚本: string }[] {
  const out: { 模板: string; 节点: string; 脚本: string }[] = [];
  const empty: WorkflowGraph = { nodes: [], edges: [], groups: [] };
  for (const template of WORKFLOW_TEMPLATES) {
    const { graph } = applyPatch(empty, 0, {
      baseRevision: 0,
      operations: template.operations,
    });
    for (const node of graph.nodes) {
      const script = (node.config as Record<string, unknown>)['script'];
      if (typeof script === 'string') {
        out.push({ 模板: template.id, 节点: node.id, 脚本: script });
      }
    }
  }
  return out;
}

/** 以管道符开头的行 —— 上一行的换行已经把命令终止了。 */
function 行首管道(script: string): number[] {
  return script
    .split('\n')
    .map((line, index) => ({ line: line.trimStart(), no: index + 1 }))
    .filter((entry) => entry.line.startsWith('|') && !entry.line.startsWith('||'))
    .map((entry) => entry.no);
}

describe('模板 shell 脚本的形状', () => {
  it('没有以管道符开头的续行', () => {
    const 坏的 = 全部脚本().flatMap(({ 模板, 节点, 脚本 }) =>
      行首管道(脚本).map((no) => `${模板}/${节点} 第 ${no} 行`),
    );
    expect(
      坏的,
      '管道符要放在**上一行行尾**。放行首的话换行已经终止了命令，' +
        'bash/sh/zsh 三个都报 parse error —— 而这段如果是发给远端的字符串，' +
        '本地 `zsh -n` 一个字都看不出来',
    ).toEqual([]);
  });

  it('这条守卫自己会红', () => {
    const 假脚本 = ['grep foo bar', '  | sort', '  | uniq -c'].join('\n');
    expect(行首管道(假脚本)).toEqual([2, 3]);
    // `||` 是逻辑或，不是管道 —— 不能误伤
    expect(行首管道(['cmd', '  || echo fallback'].join('\n'))).toEqual([]);
  });

  it('每条脚本都以 set 开头 —— 未定义变量与失败要能被发现', () => {
    // `set -u` 少了的话，拼错的变量名会静默展开成空串
    const 缺的 = 全部脚本()
      .filter(({ 脚本 }) => !/^set -[eu]/mu.test(脚本))
      .map(({ 模板, 节点 }) => `${模板}/${节点}`);
    expect(缺的).toEqual([]);
  });
});
