import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * 契约声明的节点配置字段，引擎有没有真的读。
 *
 * 这是 CLAUDE.md 三条接缝守卫里的第二条。它防的是这一种：
 * **配置字段能填能存能校验，而引擎从不读它** —— 填了不生效比报错更糟，
 * 因为没有任何一处会告诉用户它没生效。
 *
 * 真实发生过：`ai.analyze` 的 `target`（契约里是必填的「分析对象」）
 * 从来没被 executor 读过。内置模板用 `target: "${read_issue.success}"`
 * 把 issue 正文交给分析师，agent 收到的却只有角色和记忆，
 * 于是回了一句「请提供要分析的具体问题和现有证据」——
 * 而界面、契约、校验三处都显示一切正常。
 *
 * 判据只看**引擎**读没读：节点配置表单是 schema 驱动自动渲染的，
 * 所有字段都会显示在界面上，所以「前端出现过这个字符串」证明不了任何事。
 */

const 仓库根 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 节点执行会碰到的引擎源码。 */
const 引擎执行源码 = [
  'executor.rs',
  'exec.rs',
  'worktree.rs',
  'runner.rs',
  'acp.rs',
  'preflight.rs',
  'interp.rs',
]
  .map((name) => readFileSync(resolve(仓库根, 'crates/engine/src', name), 'utf8'))
  .join('\n');

const 配置_SCHEMA = JSON.parse(
  readFileSync(resolve(仓库根, 'packages/contracts/generated/node-configs.schema.json'), 'utf8'),
) as Record<string, { properties?: Record<string, unknown> }>;

/**
 * 算出「契约声明了、引擎源码里连字符串都没出现过」的字段。
 *
 * 抽成函数是为了能喂假数据 —— 门禁证明不了自己会红就不是门禁。
 */
export function 找漂移(
  schema: Record<string, { properties?: Record<string, unknown> }>,
  源码: string,
): string[] {
  const 漂移: string[] = [];
  for (const [类型, 定义] of Object.entries(schema)) {
    for (const 字段 of Object.keys(定义.properties ?? {})) {
      // 只认带引号的完整字段名：`node.config.get("target")` 算读过，
      // 而注释里提到 target 不算
      if (!new RegExp(`"${字段}"`).test(源码)) 漂移.push(`${类型}.${字段}`);
    }
  }
  return 漂移;
}

/**
 * 引擎眼下不消费的配置字段，**每一条都要写明为什么**。
 *
 * 三类：
 * - `界面`：这个字段的消费者本来就不是引擎
 * - `未实现`：整个节点类型还没实现，executor 会明确报「尚未实现」
 * - `欠账`：节点实现了，而这个字段没接上 —— 用户填了不生效
 *
 * 「欠账」那一档不是可以一直躺着的：它就是 `target` 那类问题的存量。
 * 接上一个就从这里删一行，删不动就说明它还欠着。
 */
const 引擎不消费: Record<string, string> = {
  // ── 界面：消费者不是引擎 ────────────────────────────────────────────────
  'entry.inputSchema': '界面：启动表单按它生成字段（LaunchDialog），引擎只收运行时传进来的 inputs',
  'entry.trigger': '界面：触发方式决定「什么时候发起运行」，那是发起方的事，不是执行的事',

  // ── 未实现：整个节点类型都还没有 ────────────────────────────────────────
  // executor 的兜底分支会明确报「节点类型 X 尚未实现。这个节点不会被执行，
  // 运行到此为止」，Dry Run 也会先拦一次 —— 这一档不算「假装成功」
  'subworkflow.workflowId': '未实现：subworkflow 节点',
  'subworkflow.versionRef': '未实现：subworkflow 节点',
  'subworkflow.inputMapping': '未实现：subworkflow 节点',
  'subworkflow.outputMapping': '未实现：subworkflow 节点',
  'subworkflow.concurrencyLimit': '未实现：subworkflow 节点',
  'subworkflow.onFailure': '未实现：subworkflow 节点',
  'subworkflow.approvalInheritance': '未实现：subworkflow 节点',
  'branch.cases': '未实现：branch 节点',
  'branch.defaultPort': '未实现：branch 节点',
  'transform.mappings': '未实现：transform 节点',
  'transform.outputSchema': '未实现：transform 节点',
  'env.operations': '未实现：env 节点',
  'env.exportDotenv': '未实现：env 节点',
  'mcp.tool.serverId': '未实现：mcp.tool 节点',
  'mcp.tool.toolAllowlist': '未实现：mcp.tool 节点',
  'mcp.tool.args': '未实现：mcp.tool 节点',
  'mcp.tool.scopes': '未实现：mcp.tool 节点',
  'script.python.env': '未实现：script.python 节点',
  'script.python.secretEnv': '未实现：script.python 节点',
  'script.python.successExitCodes': '未实现：script.python 节点',
  'script.python.outputLimitBytes': '未实现：script.python 节点',

  // ── 欠账：节点跑得起来，这些字段填了不生效 ──────────────────────────────
  //
  // AI 四类共通的两条。promptId 那条是 DEBT B-3「提示词库与执行路径断开」：
  // 整屏提示词库做完了，而拼提示词的地方从不读 prompt 表
  'ai.analyze.promptId': '欠账：提示词库没接执行路径（DEBT B-3）',
  'ai.review.promptId': '欠账：提示词库没接执行路径（DEBT B-3）',
  'ai.decide.promptId': '欠账：提示词库没接执行路径（DEBT B-3）',
  'ai.execute.promptId': '欠账：提示词库没接执行路径（DEBT B-3）',
  'ai.analyze.modelPolicy': '欠账：降级策略没实现，runtime 只按角色/节点选，不看这里',
  'ai.review.modelPolicy': '欠账：降级策略没实现',
  'ai.decide.modelPolicy': '欠账：降级策略没实现',
  'ai.execute.modelPolicy': '欠账：降级策略没实现',
  'ai.analyze.turnLimit': '欠账：Turn 上限不被强制，agent 想跑多少轮就多少轮',
  'ai.review.turnLimit': '欠账：Turn 上限不被强制',
  'ai.decide.turnLimit': '欠账：Turn 上限不被强制',
  'ai.execute.turnLimit': '欠账：Turn 上限不被强制',
  'ai.analyze.outputContract': '欠账：输出契约不校验，agent 返回什么形状就是什么形状',
  'ai.review.outputContract': '欠账：输出契约不校验',
  'ai.decide.outputContract': '欠账：输出契约不校验',
  'ai.execute.outputContract': '欠账：输出契约不校验',
  'ai.review.checklist': '欠账：审查清单没进提示词 —— 与 target 同一类问题',
  'ai.review.severities': '欠账：严重度分级没进提示词，也不校验输出',
  'ai.decide.rules': '欠账：L1–L3 规则没进提示词，分级全靠 agent 自己发挥',
  'ai.decide.autoDecideUpTo': '欠账：自动决策层级不生效，决策结果不会按它转人工',
  'ai.decide.onTimeout': '欠账：超时策略没实现',
  'ai.decide.decisionSchema': '欠账：决策结构不校验',
  'ai.execute.verifyCommands': '欠账：验证命令一条都不会跑',

  'entry.injectedFields': '欠账：系统注入字段没实现，run.id / run.startedAt 不会自动进 inputs',
  'end.artifacts': '欠账：最终产物清单不生效，产物由各节点自己写，末尾不做汇总',

  // approval.bodyMarkdown 接上了：AI 审批者的提示词里带着它
  // （`executor.rs` 的 审批提示词）—— 门守的是什么，批的那位要知道
  'approval.interaction': '欠账：交互类型（单选/多选）不生效',
  'approval.waitStrategy': '欠账：等待策略不生效，一律等到底',
  'approval.reminderAfterMs': '欠账：提醒没实现',

  // notify 的 title / subtitle / body / clickAction / onFailure 都接上了
  // （`executor.rs` 的 run_notify + 桌面壳的 DesktopNotifier），从这里删掉。
  // 留下的只有 `on` 一条
  'notify.on':
    '欠账：说的是「运行到什么状态时才发」，而节点执行时运行还没有终态 —— ' +
    '要按运行状态发通知得由调度器在收尾时统一做。字段描述里已直说不生效',

  'script.shell.env': '欠账：环境变量只给 scope.env_vars()，这里填的进不去',
  'script.shell.secretEnv': '欠账：**这是安全承诺**，契约写着用 keychain:// 引用，而实现为零',
  'script.shell.successExitCodes': '欠账：退出码硬编码 !=0 判失败',
  'script.shell.outputLimitBytes': '欠账：输出上限硬编码',

  'git.worktree.parentDir': '欠账：worktree 位置固定在运行目录下',
  'git.worktree.fetch': '欠账：创建前不 fetch',
  'git.worktree.conflictPolicy': '欠账：冲突策略不生效',
  'git.worktree.cleanupPolicy': '欠账：worktree 不清理，会在用户磁盘上一直堆着',
};

describe('节点配置字段的接缝', () => {
  it('契约声明的字段，引擎要么读、要么在白名单里写明为什么', () => {
    const 漂移 = 找漂移(配置_SCHEMA, 引擎执行源码);
    const 没登记 = 漂移.filter((字段) => !(字段 in 引擎不消费));

    expect(
      没登记,
      `这些配置字段契约里声明了，引擎却不读 —— 用户填了不会生效，而没有任何一处会告诉他。\n` +
        `要么在引擎里接上，要么加进 node-config-drift.test.ts 的白名单并写明理由：\n${没登记.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * 字段名与别的节点类型撞车，守卫区分不了的那几条。
   *
   * `找漂移` 按**字段名**在源码里全局匹配（`node.config.get("onFailure")`
   * 里没有节点类型的信息）。于是 notify 接上 `onFailure` 之后，
   * subworkflow 那条同名的也被判成「已接上」—— 而 subworkflow
   * 整个节点类型都还没实现。
   *
   * 放宽守卫（比如按类型加前缀匹配）做不到：源码里根本没有那个信息。
   * 所以显式列出来，每条写清撞的是谁 —— 列表短、变化少，
   * 而含糊地放宽会让守卫失去意义。
   */
  const 名字撞车: Record<string, string> = {
    'subworkflow.onFailure': '与 notify.onFailure 同名；subworkflow 整个类型未实现',
  };

  it('白名单里不留已经接上的字段', () => {
    // 接上了却还挂在白名单里的话，这份清单会慢慢变成一堆没人敢删的死条目 ——
    // 而它的价值全在于「上面每一条都还欠着」
    const 漂移 = new Set(找漂移(配置_SCHEMA, 引擎执行源码));
    const 已经接上 = Object.keys(引擎不消费).filter(
      (字段) => !漂移.has(字段) && !(字段 in 名字撞车),
    );

    expect(
      已经接上,
      `这些字段引擎已经在读了，把它们从白名单里删掉：\n${已经接上.join('\n')}`,
    ).toEqual([]);
  });

  it('白名单每条都说明了理由', () => {
    const 没理由 = Object.entries(引擎不消费)
      .filter(([, 理由]) => 理由.trim().length < 6)
      .map(([字段]) => 字段);
    expect(没理由, '白名单是用来记账的，一句「暂不实现」等于没记').toEqual([]);
  });

  it('守卫认得出新加的字段', () => {
    // 门禁证明不了自己会红就不是门禁。
    // 给一个引擎里根本不存在的字段，它必须被抓出来
    const 假schema = { 'ai.analyze': { properties: { 完全不存在的字段: {} } } };
    expect(找漂移(假schema, 引擎执行源码)).toEqual(['ai.analyze.完全不存在的字段']);
  });

  it('守卫不会把读过的字段误报成漂移', () => {
    const 假schema = { 'ai.analyze': { properties: { instruction: {} } } };
    expect(找漂移(假schema, 'let x = node.config.get("instruction");')).toEqual([]);
  });
});
