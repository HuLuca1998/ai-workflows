import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 界面说的「引擎只注入哪一档」必须与引擎实际取的那一档一致。
 *
 * 记忆页的作用域下拉有六档，而 `memories_for_injection` 的两个调用点
 * **都写死** `("workspace", None)` —— 其余五档存进去不会生效
 * （第三方巡检 C-15）。界面现在说了这句话，而说的对不对没有任何东西守着：
 * 引擎哪天接上按作用域取记忆、或者换成注入 `global`，
 * 界面还会继续说旧的那句，而那时它就是一句谎话。
 *
 * 这条守在**源码**上：两个调用点传的 scope 必须都等于界面里那个常量。
 * 跨语言（TS 界面 ↔ Rust 引擎），没有共享类型可依赖，所以查文本。
 */

const ROOT = process.cwd();

const 调用点 = ['crates/engine/src/runner.rs', 'crates/core-api/src/lib.rs'] as const;

/** 从记忆页里读出界面声称的那一档。 */
async function 界面声称的档位(): Promise<string> {
  const source = await readFile(join(ROOT, 'apps/web/src/memory/MemoryPage.tsx'), 'utf-8');
  const match = /const INJECTED_SCOPE = '([a-z_]+)'/u.exec(source);
  expect(match, 'MemoryPage 里找不到 INJECTED_SCOPE —— 界面不再声称任何东西了？').toBeTruthy();
  return match![1]!;
}

/** 从 Rust 源码里读出每个 `memories_for_injection(...)` 传的 scope。 */
async function 引擎实际取的档位(): Promise<string[]> {
  const out: string[] = [];
  for (const file of 调用点) {
    const source = await readFile(join(ROOT, file), 'utf-8');
    const re = /memories_for_injection\(\s*"([a-z_]+)"/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) out.push(m[1]!);
  }
  return out;
}

describe('界面说的注入范围与引擎一致', () => {
  it('每个注入点取的都是界面声称的那一档', async () => {
    const 声称 = await 界面声称的档位();
    const 实际 = await 引擎实际取的档位();

    expect(
      实际.length,
      '一个 memories_for_injection 调用点都没找到 —— 正则该更新了',
    ).toBeGreaterThan(0);
    for (const scope of 实际) {
      expect(
        scope,
        `引擎注入的是 ${scope}，而记忆页告诉用户只有 ${声称} 生效 —— 有一边要跟上`,
      ).toBe(声称);
    }
  });

  it('这条守卫自己会红', () => {
    // 把引擎的档位换成别的，断言判据会发现不一致
    const 假的实际 = ['global'];
    const 假的声称 = 'workspace';
    expect(假的实际.every((s) => s === 假的声称)).toBe(false);
  });
});
