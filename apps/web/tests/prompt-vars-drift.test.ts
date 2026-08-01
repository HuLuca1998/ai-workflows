import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 界面说「引擎目前不读它们」，这句话得跟着引擎走。
 *
 * 提示词的 `onMissing`（缺失时怎么办）在引擎生产代码里零消费 ——
 * 只有种子 SQL 与测试提到它。变量页签因此加了一句「引擎目前不读」
 * （第三方巡检 C-07）。
 *
 * 而这句话没有任何东西守着：引擎哪天接上了缺失策略，界面还会继续
 * 说它不读 —— 那时它就是一句谎话，用户配了却以为不生效。
 *
 * 这条守在**源码**上：引擎生产代码里出现 onMissing 的消费点时，
 * 界面那句话就该改。跨语言，没有共享类型可依赖，所以查文本。
 * `node-config-drift.test.ts` 只覆盖节点配置字段，管不到这里。
 */

const ROOT = process.cwd();

/** 引擎生产代码里读 onMissing 的地方。测试与种子不算。 */
async function 引擎读它吗(): Promise<boolean> {
  const files = [
    'crates/engine/src/executor.rs',
    'crates/engine/src/interp.rs',
    'crates/engine/src/runner.rs',
  ];
  for (const file of files) {
    const source = await readFile(join(ROOT, file), 'utf-8');
    // 注释里提到不算 —— 查的是真的取那个字段
    const withoutComments = source.replace(/\/\/[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '');
    if (/on_missing|onMissing/u.test(withoutComments)) return true;
  }
  return false;
}

describe('变量表那句「引擎目前不读」要跟着引擎走', () => {
  it('引擎不读时界面才说这句话', async () => {
    const 界面 = await readFile(join(ROOT, 'apps/web/src/prompts/PromptsPage.tsx'), 'utf-8');
    const 说了不读 = /引擎目前不读它们/u.test(界面);
    const 读了 = await 引擎读它吗();

    if (读了) {
      expect(
        说了不读,
        '引擎已经读 onMissing 了，而变量页签还写着「引擎目前不读它们」—— ' +
          '用户配了缺失策略却以为不生效',
      ).toBe(false);
    } else {
      expect(
        说了不读,
        'onMissing 在引擎里零消费，而变量表摆着三档策略的文案却不声明 —— ' +
          '那是一张等着被填的假配置表',
      ).toBe(true);
    }
  });

  it('这条守卫自己会红', () => {
    // 两种不一致各构造一次
    expect(检查(true, true)).toBe(false); // 引擎读了，界面还说不读
    expect(检查(false, false)).toBe(false); // 引擎不读，界面不声明
    expect(检查(true, false)).toBe(true);
    expect(检查(false, true)).toBe(true);
  });
});

/** 一致性判据抽出来，元测试才喂得进假输入。 */
function 检查(引擎读了: boolean, 界面说了不读: boolean): boolean {
  return 引擎读了 ? !界面说了不读 : 界面说了不读;
}
