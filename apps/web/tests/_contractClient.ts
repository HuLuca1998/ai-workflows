import { type CoreApiMethod, getMethodSpec } from '@aiwf/contracts';

/**
 * 带契约校验的 coreClient 替身。
 *
 * 直接 mock `coreClient.call` 会把 Zod 校验一起绕过去，于是界面发出
 * 一个不合契约的 payload 时组件测试照样绿 —— 真实运行时它会被
 * Core API 挡在门口，症状只是「点了保存没反应」。这个坑踩过一次
 * （模型页的 runtime 用了自造的字符串，端到端测试才抓到）。
 *
 * 光抛错还不够 —— 组件通常会把错误 catch 进 setError，于是
 * 「点了保存没反应」的测试仍然绿（它只断言 call 被调用过，
 * 而 call 确实被调用了，只是抛了）。所以违规同时记进 VIOLATIONS，
 * 由 setup.ts 的 afterEach 兜底：本轮有违规就直接判这条用例失败。
 * 这个盲点是提示词页少发 ver 时暴露的。
 *
 * 用法：
 * ```ts
 * const call = createContractCall({ 'model.list': () => ({ items: [], total: 0 }) });
 * vi.mock('../src/data/workspace.js', () => ({ coreClient: { call } }));
 * ```
 */
export const VIOLATIONS: string[] = [];
export function createContractCall(
  handlers: Partial<Record<CoreApiMethod, (input: unknown) => unknown>>,
) {
  return async (method: string, input: unknown) => {
    const spec = getMethodSpec(method as CoreApiMethod);

    const parsed = spec.input.safeParse(input);
    if (!parsed.success) {
      // 把具体哪个字段不对说出来，否则测试失败时还得自己去翻
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('; ');
      const message = `${method} 的入参不合契约 —— ${issues}`;
      VIOLATIONS.push(message);
      throw new Error(message);
    }

    // 校验通过还不够：Zod 对未知键是 **strip**，对缺失键是**填默认值**。
    // 于是界面把 `capabilities` 的键打成 `{fileRead, fileWrite}` 时，
    // 校验一路绿灯，而发到引擎的是一份全 `none` 的权限 ——
    // 用户新建的角色挂到脚本节点上必然失败，没有任何一处会报。
    //
    // 这类漂移只有比对「校验前后」才看得见：抛错的那种是响亮的失败，
    // 被悄悄吃掉的这种才是要守的。
    const 被吃掉的 = strippedKeys(input, parsed.data);
    if (被吃掉的.length > 0) {
      const message =
        `${method} 的入参里这些键被契约悄悄丢掉了：${被吃掉的.join('、')}。` +
        `多半是键名打错了 —— 它们不会报错，只会让对应的值变成默认值`;
      VIOLATIONS.push(message);
      throw new Error(message);
    }

    const handler = handlers[method as CoreApiMethod];
    if (!handler) throw new Error(`测试没有为 ${method} 准备返回值`);
    return handler(parsed.data);
  };
}

/**
 * 找出 `原始` 里有、而 `校验后` 没有的键（递归）。
 *
 * 只看键在不在，不比值：Zod 会把 `"12"` 强制成 `12`、给缺失字段填默认，
 * 那些都是有意的转换。被整个丢掉的键才是打错字的信号。
 */
function strippedKeys(原始: unknown, 校验后: unknown, 前缀 = ''): string[] {
  if (!isPlainObject(原始) || !isPlainObject(校验后)) return [];

  const 丢了: string[] = [];
  for (const [key, value] of Object.entries(原始)) {
    const 路径 = 前缀 ? `${前缀}.${key}` : key;
    if (!(key in 校验后)) {
      丢了.push(路径);
      continue;
    }
    丢了.push(...strippedKeys(value, 校验后[key], 路径));
  }
  return 丢了;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
