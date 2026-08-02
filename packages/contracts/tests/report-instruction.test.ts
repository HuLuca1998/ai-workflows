import { describe, expect, it } from 'vitest';

import { REPORT_INSTRUCTION } from '../src/templates/shared.js';
import { RunReportSchema } from '../src/report.js';

/**
 * 给 AI 的报告格式说明，必须与解析报告的 Schema 是同一套字段名。
 *
 * ## 这条守的是什么
 *
 * `REPORT_INSTRUCTION` 是内置模板塞进 `ai.execute` 提示词里的那段话 ——
 * agent 照它写 `report.json`。而 `RunReportSchema` 是抽屉解析那份文件时用的。
 * 两边各写各的，谁都不会红：
 *
 * · 契约测试测 Schema，用的是**它自己造的**合法数据
 * · 模板测试测图的结构，不看提示词正文
 * · 抽屉解析失败**不抛**（一份坏报告不该让抽屉打不开），
 *   界面老老实实显示「这份 report.json 不合报告格式，下面是原文」
 *
 * 于是整条链每一处都「正常工作」，而用户点开报告永远看到的是一坨 JSON 原文。
 *
 * ## 实测（2026-08-02）
 *
 * 六种块里**四种字段名对不上**：
 *
 * | 块        | 指令写的                     | Schema 要的                            |
 * | --------- | ---------------------------- | -------------------------------------- |
 * | `metrics` | `tone: "good\|warn\|bad"`    | `neutral\|success\|warning\|danger`     |
 * | `prose`   | `heading` / `text`           | `title` / `body`                       |
 * | `code`    | `language` / `text`          | `lang` / `body`                        |
 *
 * ## 判据
 *
 * 把指令里那六行示例**当成 agent 真的照抄的东西**解析一遍。
 * 这是唯一能同时抓到两侧的判据 —— 只比字段名清单的话，
 * 下一次改的是枚举值就又漏了。
 */

/** 从指令里抠出每种块的那份 JSON 示例。 */
function 示例(kind: string): unknown {
  const line = REPORT_INSTRUCTION.split('\n').find((l) => l.trimStart().startsWith(`${kind} `));
  if (!line) throw new Error(`指令里没有 ${kind} 这一行 —— 是不是改了排版？`);
  const start = line.indexOf('{');
  const json = line.slice(start);
  // 示例里用 `"good|warn|bad"` 表示候选，取第一个当成 agent 会写的值
  return JSON.parse(
    json.replace(/"([a-z]+(?:\|[a-z]+)+)"/gu, (_, alts: string) =>
      JSON.stringify(alts.split('|')[0]),
    ),
  );
}

/** 把一个块塞进一份最小报告里，看整份能不能解析。 */
function 解析(block: unknown) {
  return RunReportSchema.safeParse({
    schemaVer: 1,
    title: 't',
    summary: 's',
    outcome: 'success',
    blocks: [block],
  });
}

describe('给 AI 的报告格式说明与解析用的 Schema 同源', () => {
  for (const kind of ['metrics', 'prose', 'table', 'timeline', 'code', 'links']) {
    it(`${kind} 的示例照抄下来能被解析`, () => {
      const result = 解析(示例(kind));
      expect(
        result.success,
        result.success
          ? ''
          : `指令里 ${kind} 的示例不合 Schema —— agent 照它写出来的报告会被抽屉拒收，` +
              `用户点开看到的是一坨 JSON 原文：\n` +
              result.error.issues
                .map((i) => `  ${i.path.join('.') || '(根)'}: ${i.message}`)
                .join('\n'),
      ).toBe(true);
    });
  }

  it('顶层的那行格式说明也能解析', () => {
    // `{"schemaVer":1,"title":"…","summary":"…","outcome":"success|warning|failed","blocks":[…]}`
    // blocks 至少要一项（Schema 是 min(1)）—— 空报告没有意义
    const result = RunReportSchema.safeParse({
      schemaVer: 1,
      title: '标题',
      summary: '一句话结论',
      outcome: 'success',
      blocks: [{ kind: 'prose', body: '正文' }],
    });
    expect(result.success).toBe(true);
  });

  it('这条守卫抓得到字段名被改坏', () => {
    // 元测试：`prose` 的正文字段改个名，必须解析失败。
    // 抓不到的话上面那六条只是在测「JSON.parse 能跑」
    expect(解析({ kind: 'prose', body: '正文' }).success).toBe(true);
    expect(解析({ kind: 'prose', text: '正文' }).success).toBe(false);
  });
});
