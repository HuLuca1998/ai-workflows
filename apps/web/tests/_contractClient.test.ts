import { describe, expect, it } from 'vitest';
import { VIOLATIONS, createContractCall } from './_contractClient.js';

/**
 * 契约替身自己的守卫。
 *
 * 它拦的两类失败长得很不一样：
 * - **响亮的**：字段类型不对，Zod 直接拒，测试当场红
 * - **安静的**：键名打错，Zod strip 掉再填默认值，**校验一路绿灯**
 *
 * 后一类是这个文件存在的理由。真实发生过：新建 Agent 角色发的是
 * `{fileRead, fileWrite}`，契约要的是 `{file, command, network, memory, secret}`，
 * 校验通过，而到引擎那边成了一份全 `none` 的权限 ——
 * 用户建完角色挂到脚本节点上必然失败，中间没有任何一处会报。
 *
 * 门禁证明不了自己会红就不是门禁。
 */
describe('契约替身', () => {
  const 建一个 = () => createContractCall({ 'agent.create': () => ({ id: 'agent_new' }) });

  const 合法入参 = {
    name: 'A',
    role: '分析',
    goal: '',
    persona: '',
    runtime: 'acp.codex' as const,
    modelRef: 'model_1',
    tools: [],
    capabilities: {
      file: 'read' as const,
      command: 'none' as const,
      network: 'none' as const,
      memory: 'read' as const,
      secret: [],
    },
    outputContract: '',
    turnLimit: 12,
    timeoutMs: 900_000,
  };

  it('合法入参照常放行', async () => {
    await expect(建一个()('agent.create', 合法入参)).resolves.toEqual({ id: 'agent_new' });
  });

  it('键名打错时拦下来 —— 那种键不会报错，只会让值变成默认值', async () => {
    const before = VIOLATIONS.length;
    const 打错了 = {
      ...合法入参,
      capabilities: { fileRead: true, fileWrite: false, network: 'none' as const },
    };

    await expect(建一个()('agent.create', 打错了)).rejects.toThrow(/悄悄丢掉/u);
    expect(VIOLATIONS.length).toBeGreaterThan(before);
    expect(VIOLATIONS.at(-1)).toContain('capabilities.fileRead');

    // 这条用例是故意制造违规的，清掉免得 setup.ts 的 afterEach 判它失败
    VIOLATIONS.length = before;
  });

  it('嵌套层里的错键也认得出', async () => {
    const before = VIOLATIONS.length;
    const 打错了 = {
      ...合法入参,
      capabilities: { ...合法入参.capabilities, 拼错的键: 1 },
    };

    await expect(建一个()('agent.create', 打错了)).rejects.toThrow(/capabilities\.拼错的键/u);
    VIOLATIONS.length = before;
  });

  it('Zod 的正常转换不算被吃掉', async () => {
    // 缺失字段填默认值、数字字符串转数字都是有意的 ——
    // 把这些也报出来的话，这条守卫会吵到没人看
    const before = VIOLATIONS.length;
    const { turnLimit: _省略, ...少一个字段 } = 合法入参;

    await expect(建一个()('agent.create', 少一个字段)).resolves.toBeTruthy();
    expect(VIOLATIONS.length).toBe(before);
  });
});
