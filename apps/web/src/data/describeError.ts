import { CoreApiError } from '@aiwf/contracts';

/**
 * 把任意抛出物变成能显示给用户的一句话。
 *
 * 抽出来是因为它被复制了七份，而第八处**忘了复制** ——
 * `describe(err)` 在那个文件里根本不存在，于是 catch 分支一执行就
 * 抛出「describe is not defined」，把原本要显示的错误吞掉了。
 * TypeScript 没拦住：`describe` 是 vitest 注入的全局名，类型上存在。
 *
 * 症状是「点了没反应」，而真正的原因（乐观锁冲突、数据库忙）
 * 一个字都没露出来 —— 比原始错误更难查。
 */
export function describeError(error: unknown): string {
  // hint 是 Core API 专门为「接下来该干什么」留的字段。
  // 九份复制里只有一份拼了它 —— 于是同一个错误在编辑器里能看到
  // 「先保存草稿再运行」，在别的七个屏只剩一句干巴巴的报错。
  if (error instanceof CoreApiError) {
    return error.hint ? `${error.message}（${error.hint}）` : error.message;
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
