import { describe as vitestDescribe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describeError } from '../src/data/describeError.js';

/**
 * `describe(error)` 这个名字是个陷阱。
 *
 * 它被复制了七份，而第八处忘了复制 —— TypeScript 没拦住，因为
 * `describe` 是 vitest 注入的全局名，类型上存在。于是 catch 分支
 * 一执行就抛「describe is not defined」，把原本要显示的错误吞掉：
 * 用户看到的是「点了没反应」，而真正的原因一个字都没露出来。
 *
 * 这条守卫盯着别再出现第二个同名的本地实现。
 */

const 源: { path: string; text: string }[] = [];
const 扫 = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) 扫(path);
    else if (/\.tsx?$/.test(entry.name)) 源.push({ path, text: readFileSync(path, 'utf8') });
  }
};
扫(join(import.meta.dirname, '../src'));

vitestDescribe('错误文案只有一份实现', () => {
  it('没有文件自己定义 describe() —— 那个名字与 vitest 的全局撞', () => {
    const 违规 = 源
      .filter(({ text }) => /^function describe\(/mu.test(text))
      .map(({ path }) => path);

    expect(违规, `这些文件自己定义了 describe()，改用 describeError()：${违规.join('、')}`).toEqual(
      [],
    );
  });

  it('调用 describe(err) 的地方都能解析到实现', () => {
    const 违规: string[] = [];
    for (const { path, text } of 源) {
      if (!/\bdescribe\((err|error)\b/u.test(text)) continue;
      // 调了就必须导入 describeError 或自己定义（后者上一条已经禁了）
      if (!text.includes('describeError')) 违规.push(path);
    }

    expect(违规, `这些文件调了 describe(err) 却没有对应实现：${违规.join('、')}`).toEqual([]);
  });

  it('describeError 能处理非 Error 抛出物', () => {
    expect(describeError(new Error('炸了'))).toBe('炸了');
    expect(describeError('字符串错误')).toBe('字符串错误');
    expect(describeError({ code: 1 })).toContain('object');
  });
});
