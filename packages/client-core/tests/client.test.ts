import { describe, expect, it, vi } from 'vitest';
import { CoreApiError } from '@aiwf/contracts';
import { CoreApiClient } from '../src/client.js';
import { MemoryTransport } from '../src/transport.js';

/**
 * 客户端是 UI 与 Core API 之间唯一的通道。它承担三件事：
 * 入参先按契约校验（不合法的请求不该浪费一次往返）、
 * 错误统一成 CoreApiError、Scope 不足时本地直接拒绝。
 */

const client = (handlers: Record<string, (input: unknown) => unknown> = {}) =>
  new CoreApiClient(new MemoryTransport(handlers));

describe('入参与出参校验', () => {
  it('入参不合契约时本地就报 VALIDATION，不发请求', async () => {
    const call = vi.fn();
    const c = new CoreApiClient(new MemoryTransport({}, call));

    await expect(c.call('workflow.patch', { id: 'wf_1' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('合法入参会带着 Schema 补齐的默认值发出去', async () => {
    const seen: unknown[] = [];
    const c = new CoreApiClient(
      new MemoryTransport({
        'run.events': (input) => {
          seen.push(input);
          return { events: [], nextSeq: 0, hasMore: false };
        },
      }),
    );

    await c.call('run.events', { runId: 'run_1' });
    // limit 与 fromSeq 有默认值，调用方不必每次都写
    expect(seen[0]).toMatchObject({ runId: 'run_1', fromSeq: 0, limit: 200 });
  });

  it('引擎返回不合契约时报 INTERNAL——这是实现 bug，不该让界面自己猜', async () => {
    const c = client({ 'workflow.validate': () => ({ 完全不对: true }) });
    await expect(c.call('workflow.validate', { id: 'wf_1' })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});

describe('错误规范化', () => {
  it('传输层抛出的纯对象被还原成 CoreApiError', async () => {
    const c = client({
      'workflow.patch': () => {
        throw { code: 'REVISION_CONFLICT', message: '草稿已变化', retriable: true };
      },
    });

    const error = await c
      .call('workflow.patch', {
        id: 'wf_1',
        baseRevision: 18,
        operations: [{ op: 'renameNode', nodeId: 'n1', title: 'x' }],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CoreApiError);
    expect((error as CoreApiError).code).toBe('REVISION_CONFLICT');
    expect((error as CoreApiError).retriable).toBe(true);
  });

  it('未知异常兜底成 INTERNAL，并保留原始信息供诊断', async () => {
    const c = client({
      'workflow.list': () => {
        throw new Error('socket hang up');
      },
    });
    const error = (await c.call('workflow.list', {}).catch((e: unknown) => e)) as CoreApiError;
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('socket hang up');
  });
});

describe('Scope 守卫', () => {
  it('会话未授予的 Scope 直接拒绝，不做无效往返', async () => {
    const call = vi.fn();
    const c = new CoreApiClient(new MemoryTransport({}, call), {
      grantedScopes: ['workflow:read', 'workflow:write-draft'],
    });

    await expect(c.call('workflow.publish', { id: 'wf_1', rev: 19 })).rejects.toMatchObject({
      code: 'PERMISSION',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('不限制 Scope 时（本地 UI）一切方法可用', async () => {
    const c = client({ 'env.install': () => ({ started: true }) });
    await expect(c.call('env.install', { tools: ['node'] })).resolves.toEqual({ started: true });
  });

  it('本地专属方法即使授予了全部 Scope 也不能被远端调用方使用', async () => {
    const c = new CoreApiClient(new MemoryTransport({}), {
      grantedScopes: ['workflow:read', 'workflow:write-draft', 'workflow:publish', 'workflow:run'],
    });
    await expect(c.call('env.install', { tools: ['node'] })).rejects.toMatchObject({
      code: 'PERMISSION',
    });
  });
});
