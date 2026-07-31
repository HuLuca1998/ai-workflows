import { useEffect, useRef, useState } from 'react';
import { coreClient } from '../data/workspace.js';
import { AskCard } from './AskCard.js';
import type { AskSpec } from '@aiwf/contracts';

/**
 * MCP 写操作的确认卡。
 *
 * 「AI 的改动一律先出 Diff，用户确认才落草稿」是这个产品的核心规则。
 * 主管 AI 遵守了（提议 → Diff → 确认），MCP 之前不能 ——
 * 那个进程弹不出应用里的对话框，于是写工具只能整体关掉。
 *
 * 现在它把待确认放进信箱，这里轮询到之后显示。用户决定后 MCP 那边
 * 的轮询读到结果。**没人理会超时，而超时等于拒绝** ——
 * 一条写操作在几小时后突然生效，比它没生效糟得多。
 *
 * 这张卡不在图纸里：图纸画的是 M1 的形态，那时 MCP 还没有写工具。
 */

interface Pending {
  id: string;
  tool: string;
  inputJson: string;
  createdAt: string;
  /**
   * 这是一次「agent 在问你」而不是「写操作待确认」。
   *
   * 两者共用同一条队列（机制一样：TTL、过期、轮询），
   * 但要渲染成两种卡 —— 确认给的是批准/拒绝，提问给的是选项或输入框。
   */
  ask?: AskSpec;
}

/** 多久看一眼信箱。用户按下批准到 MCP 那边生效，最坏是这个数 + 它的轮询间隔。 */
const POLL_MS = 1200;

export function McpConfirmCard() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [deciding, setDeciding] = useState(false);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const result = (await coreClient.call('mcp.pendingConfirms', {})) as { items: Pending[] };
        if (!stopped) setPending(result.items[0] ?? null);
      } catch {
        // 查不到就不显示。这条报错帮不上用户 ——
        // 他此刻在做的是别的事，而 MCP 那边会自己超时
      }
    };

    /*
     * 先问一句 MCP 起没起。
     *
     * 没起就不轮询：一台没接过任何 MCP 客户端的机器上，
     * 这条定时器每 1.2 秒发一次请求、永远不停，而信箱永远是空的。
     */
    void (async () => {
      try {
        const status = (await coreClient.call('mcp.status', {})) as { running: boolean };
        if (stopped || !status.running) return;
      } catch {
        // 问不到状态时按「起着」处理：宁可多轮询，也不能漏掉一次待确认 ——
        // 漏掉的那次会在 MCP 那边超时，表现成「AI 说改了但什么都没变」
      }
      if (stopped) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    })();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  /*
   * alertdialog 的含义是「打断你，等你决定」。
   *
   * 此前它从不接管焦点：卡片出现在屏幕角落，键盘用户要 Tab 过整屏才够得着，
   * 读屏用户完全不知道它出现了 —— 一个不打断的 alertdialog 是在说假话。
   * 焦点给「拒绝」而不是「批准」：默认动作应该是不批准。
   */
  const pendingId = pending?.id ?? null;
  useEffect(() => {
    if (!pendingId) return;
    cardRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    // 只跟 id 走：同一条待确认重渲染时不该把焦点从用户手上抢回来
  }, [pendingId]);

  if (!pending) return null;

  const decide = async (approved: boolean) => {
    setDeciding(true);
    try {
      await coreClient.call('mcp.decideConfirm', { id: pending.id, approved });
      setPending(null);
    } catch {
      // 决定没发出去：留着卡片，用户能再按一次。
      // 静默消失的话他会以为已经批准了
    } finally {
      setDeciding(false);
    }
  };

  /*
   * 用户回答了提问。
   *
   * 与 `decide` 分开是因为**回答的形状不同**：那条只有是/否，
   * 而这条要把用户选的东西带回给 agent —— agent 的那次工具调用
   * 一直挂着等它，拿到之后接着往下做，不需要用户再复述一遍。
   */
  const answer = async (value: {
    selected?: string;
    selectedMany: string[];
    fields: Record<string, string>;
  }) => {
    setDeciding(true);
    try {
      await coreClient.call('mcp.answerAsk', { id: pending.id, answer: value });
      setPending(null);
    } catch {
      // 与 decide 同一条：留着卡片，用户能再按一次。
      // 静默消失的话他会以为已经答过了
    } finally {
      setDeciding(false);
    }
  };

  if (pending.ask) {
    return (
      <aside className="mcp-confirm" role="alertdialog" aria-label="AI 提问" ref={cardRef}>
        <AskCard
          spec={pending.ask}
          raw={prettify(pending.inputJson)}
          busy={deciding}
          onAnswer={(value) => void answer(value)}
          // 「不回答」走同一条 decideConfirm(false)：agent 拿到「被拒绝」，
          // 而不是一个空答案 —— 空答案会被它当成「用户什么都没选」
          onDecline={() => void decide(false)}
        />
      </aside>
    );
  }

  return (
    <aside className="mcp-confirm" role="alertdialog" aria-label="MCP 写入确认" ref={cardRef}>
      <p className="mcp-confirm__head">
        <i className="ph-fill ph-plugs-connected" aria-hidden="true" />
        <span>
          MCP 客户端要写入：<code>{pending.tool}</code>
        </span>
      </p>

      {/* 入参原样摊开：用户得看清它到底要改什么，
          而不是只看到一个工具名就决定 */}
      <pre className="mcp-confirm__input">{prettify(pending.inputJson)}</pre>

      <p className="mcp-confirm__note">
        批准后这次写入会走 Core API 的版本守卫与审计，改的是草稿而不是已发布版本。
        不理它的话会自动拒绝。
      </p>

      <div className="mcp-confirm__actions">
        <button
          type="button"
          className="runs__action"
          disabled={deciding}
          onClick={() => void decide(false)}
        >
          拒绝
        </button>
        <button
          type="button"
          className="runs__action runs__action--primary"
          disabled={deciding}
          onClick={() => void decide(true)}
        >
          批准这次写入
        </button>
      </div>
    </aside>
  );
}

/** 入参排版成人能读的样子。坏了就原样显示 —— 那本身也是有用的信息。 */
function prettify(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
