import { useEffect, useState } from 'react';
import { coreClient } from '../data/workspace.js';

/**
 * MCP 与集成 —— 图纸「05 设置与环境」左栏第五档。
 *
 * 图纸把左栏画成一个 `sc-for`（八项占位），没有逐档画内容，
 * 只画了「运行环境与工具」那一档。这一档沿用同一套结构：
 * 标题 + 一句说明 + 摘要条 + 表格。
 *
 * 这一屏回答两个问题：
 * 1. 系统 MCP 现在跑没跑、在哪个端口
 * 2. 本地的 Claude Code / Codex 接进来没有，一键接
 *
 * **地址默认打码**：它带着令牌，而令牌等于这台机器上这个应用的全部能力。
 * 用户要复制时点一下才显示 —— 录屏与截图是最常见的泄漏路径。
 */

interface ClientState {
  id: 'claude' | 'codex';
  label: string;
  cliInstalled: boolean;
  connected: boolean;
}

interface Status {
  running: boolean;
  url: string;
  endpoint: string;
  port: number;
  toolCount: number;
  resourceCount: number;
  clients: ClientState[];
}

interface ConnectResult {
  ok: boolean;
  detail: string;
  command: string;
}

export function McpIntegration() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [outcome, setOutcome] = useState<ConnectResult | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      setStatus((await coreClient.call('mcp.status', {})) as Status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const wire = async (client: string, disconnect: boolean) => {
    setBusy(client);
    setOutcome(null);
    try {
      const result = (await coreClient.call('mcp.connect', {
        client,
        disconnect,
      })) as ConnectResult;
      setOutcome(result);
      // 接完立刻重读一次：不刷新的话「已接入」那一列还是旧的，
      // 用户会以为没生效然后再点一次
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const url = status?.url ?? '';
  const masked = url.replace(/\/mcp\/[0-9a-f]+$/u, '/mcp/••••••••');

  return (
    <section className="env">
      <h4>MCP 与集成</h4>
      <p className="env__note">
        把这个应用的全部能力与知识开给本地的 AI 客户端。接进去之后，Claude Code 与 Codex
        就能读懂这个系统、设计工作流、发起运行、回头分析执行数据。
      </p>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      {status ? (
        <div className="env__summary" data-ready={status.running}>
          <i
            className={status.running ? 'ph-fill ph-check-circle' : 'ph-fill ph-warning-circle'}
            aria-hidden="true"
          />
          <div>
            <p className="env__summary-title">
              {status.running
                ? `运行中 · ${status.toolCount} 个工具 · ${status.resourceCount} 份系统知识`
                : '没有在跑'}
            </p>
            <p className="env__summary-sub">
              {status.running
                ? `本机 127.0.0.1:${status.port}，只监听回环地址，需要访问令牌`
                : '端口可能被占用了。重启应用会自动往后挪一个端口再试。'}
            </p>
          </div>
          <span className="runs__grow" />
          <button type="button" className="runs__action" onClick={() => void refresh()}>
            重新检查
          </button>
        </div>
      ) : null}

      {status ? (
        <p className="env__script">
          <i className="ph ph-link" aria-hidden="true" />
          <span>
            接入地址 <code>{revealed ? url : masked}</code>{' '}
            <button
              type="button"
              className="env__copy"
              onClick={() => setRevealed((on) => !on)}
              aria-label={revealed ? '隐藏访问令牌' : '显示访问令牌'}
            >
              <i className={revealed ? 'ph ph-eye-slash' : 'ph ph-eye'} aria-hidden="true" />
              {revealed ? '隐藏' : '显示'}
            </button>
            <button
              type="button"
              className="env__copy"
              onClick={() => void navigator.clipboard?.writeText(url)}
              aria-label="复制接入地址"
            >
              <i className="ph ph-copy" aria-hidden="true" />
              复制
            </button>
            <span className="env__hint-source">
              地址里带着访问令牌 —— 它等于这台机器上这个应用的全部能力，别贴进截图或工单。
            </span>
          </span>
        </p>
      ) : null}

      <table className="env__table" aria-label="MCP 客户端接入">
        <thead>
          <tr>
            <th scope="col">客户端</th>
            <th scope="col">命令行</th>
            <th scope="col">令牌怎么带</th>
            <th scope="col">状态</th>
            <th scope="col">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(status?.clients ?? []).map((client) => (
            <tr key={client.id} data-capability={client.id} data-connected={client.connected}>
              <td>{client.label}</td>
              <td className="env__mono">
                {client.cliInstalled ? `${client.id} · 已安装` : '未安装'}
              </td>
              <td className="env__mono">
                {client.id === 'claude' ? 'Authorization 请求头' : 'URL 路径'}
              </td>
              <td>
                <span className="env__status">
                  <i
                    className={
                      client.connected
                        ? 'ph-fill ph-check-circle'
                        : client.cliInstalled
                          ? 'ph ph-minus-circle'
                          : 'ph-fill ph-x-circle'
                    }
                    aria-hidden="true"
                  />
                  {client.connected ? '已接入' : client.cliInstalled ? '未接入' : '未安装'}
                </span>
                {!client.cliInstalled ? (
                  <span className="env__detail">命令行工具不在 PATH 里，装好之后回来点一次</span>
                ) : null}
              </td>
              <td>
                <button
                  type="button"
                  className="env__copy"
                  disabled={!client.cliInstalled || !status?.running || busy === client.id}
                  onClick={() => void wire(client.id, client.connected)}
                >
                  <i
                    className={client.connected ? 'ph ph-plug-x' : 'ph ph-plugs-connected'}
                    aria-hidden="true"
                  />
                  {busy === client.id ? '处理中' : client.connected ? '断开' : '一键接入'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {outcome ? (
        // 成功也要说一句：只把按钮变灰的话，用户不知道接下来去哪确认
        <p className={outcome.ok ? 'env__script' : 'runs__error'} role="status">
          <i className={outcome.ok ? 'ph ph-check' : 'ph ph-warning'} aria-hidden="true" />
          <span>
            {outcome.detail}
            {outcome.ok ? null : (
              <>
                {' '}
                <code>{outcome.command}</code>
              </>
            )}
          </span>
        </p>
      ) : null}
    </section>
  );
}
