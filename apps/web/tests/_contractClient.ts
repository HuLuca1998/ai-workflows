import { type CoreApiMethod, getMethodSpec } from '@aiwf/contracts';

/**
 * 带契约校验的 coreClient 替身。
 *
 * 直接 mock `coreClient.call` 会把 Zod 校验一起绕过去，于是界面发出
 * 一个不合契约的 payload 时组件测试照样绿 —— 真实运行时它会被
 * Core API 挡在门口，症状只是「点了保存没反应」。这个坑踩过一次
 * （模型页的 runtime 用了自造的字符串，端到端测试才抓到）。
 *
 * 用法：
 * ```ts
 * const call = createContractCall({ 'model.list': () => ({ items: [] }) });
 * vi.mock('../src/data/workspace.js', () => ({ coreClient: { call } }));
 * ```
 */
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
      throw new Error(`${method} 的入参不合契约 —— ${issues}`);
    }

    const handler = handlers[method as CoreApiMethod];
    if (!handler) throw new Error(`测试没有为 ${method} 准备返回值`);
    return handler(parsed.data);
  };
}
