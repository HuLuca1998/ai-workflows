import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../data/describeError.js';
import { ChatInput } from '../chat/ChatInput.js';
import {
  applyPatch,
  migrateApprovalMode,
  AGENT_RUNTIMES,
  LIST_PAGE_LIMIT_MAX,
  type PatchOperation,
  type WorkflowDiff,
  type WorkflowGraph,
} from '@aiwf/contracts';
import { coreClient } from '../data/workspace.js';
import { useStreamChunks, type StreamChunk } from './useStreamChunks.js';
import { DiffLines } from '../editor/DiffLines.js';

/**
 * 主管 AI 抽屉 —— 严格照图纸：468px 从右侧滑入。
 *
 * 「掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置」——
 * 它与工作流里的 AI 节点是两回事：节点在**运行中**做一件具体的事，
 * 主管 AI 在**编辑时**帮你操作这个应用本身。
 *
 * 两条界限：
 *
 * 1. **上下文是显式的**。头部那排 chips 就是「这次对话它能看到什么」。
 *    不显式列出来的话，用户无法判断它的回答基于什么 ——
 *    而可解释性是这个产品的核心。
 * 2. **改动先出 Diff**。AI 的任何修改都走 propose，用户确认才落草稿
 *    （图纸：「不会发布，也不会改动运行中的 v7」）。
 * 3. **底部常驻本次会话的 Scope**。用户随时看得到 AI 现在能做什么、
 *    不能做什么 —— 这是「AI 建议 ≠ 执行」在界面上的兜底。
 */

interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** agent 消息在流式过程中为 true。 */
  streaming?: boolean;
  /** 系统回执（取消、超时）。它不是模型说的话，样式上要区分开。 */
  system?: boolean;
  /**
   * 这一轮用掉的工具调用次数。
   *
   * 契约一直给着它，界面从来不读 —— 于是「它到底做了什么」在整个抽屉里
   * 没有任何线索：一次读了 12 个文件的回答与一次纯聊天的回答长得一样。
   */
  toolCalls?: number;
}

/** 头部那排上下文 chips。图标与文案照图纸。 */
export interface SupervisorContext {
  /** 当前草稿修订号，在编辑器里才有。 */
  draftRev?: number;
  /** 选中的节点数。 */
  selectedNodes?: number;
  /** 正在看的运行。运行页把当前选中那条传进来，AI 才答得了「上次为什么失败」。 */
  runId?: string;
  /** 当前工作流。后端靠它读草稿的图，AI 才提得出能落地的操作。 */
  workflowId?: string;
}

export interface SupervisorDrawerProps {
  open: boolean;
  context: SupervisorContext;
  /** 当前草稿的图。有它才算得出 Diff —— 没有就只能问答。 */
  graph?: WorkflowGraph;
  /** 用户确认后把操作交给编辑器落草稿（那里有 baseRevision 守卫）。 */
  onApply?: (operations: PatchOperation[]) => void;
  onClose: () => void;
}

/**
 * 可增删的上下文项。
 *
 * 「草稿」是 workflowId 与 draftRev 一组 —— 后端靠 workflowId 读草稿的图，
 * 只留 rev 不留 id 的话它无从解析，AI 提出的操作会引用编出来的 nodeId。
 */
type ContextKey = 'draft' | 'run';

/** 历史会话列表里的一条。 */
interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  workflowId?: string;
  runId?: string;
}

/** 待确认的提议：AI 说了什么、会变成什么样。 */
interface Proposal {
  /**
   * 这组操作是对哪条工作流算出来的。
   *
   * 不记的话它跨工作流存活：在 A 里让 AI 提了一组改动，切到 B，
   * 提议还挂在抽屉里，点「应用到草稿」就把 A 的操作落到了 B 上 ——
   * nodeId 在 B 里要么不存在（报错），要么**碰巧存在**（改错东西）。
   */
  workflowId: string | undefined;
  summary: string;
  operations: PatchOperation[];
  /** 没有当前草稿图时算不出 Diff —— 那时只报提议本身，不假装有 Diff。 */
  diff: WorkflowDiff | null;
}

/**
 * 推理深度候选的模块级缓存。
 *
 * `model.sync` 会起一个 adapter 进程（实测约 300ms）。抽屉每开一次
 * 同步一次的话，用户开关三下就起了三个进程 —— 而这份清单在一次
 * 应用会话里几乎不会变（变了就去模型页点同步）。
 */
let cachedEfforts: string[] = [];

interface ModelOption {
  id: string;
  name: string;
}

/**
 * 这一档权限下主管 AI 拿得到哪些 Scope。
 *
 * 与 `crates/mcp/src/catalog.rs` 的 `gate_for` 是同一套规则 ——
 * 那边是真的拦截，这边只是把它说出来。两边分叉的话，
 * 界面会承诺一个引擎不认的权限，而那比不显示更糟。
 */
function grantedScopes(preset: string | null): string[] {
  const readOnly = ['workflow:read', 'memory:read'];
  // 库里可能躺着上一版的档位名。不迁移的话它落到 default 那一支，
  // 抽屉里说「任何写操作都需逐项确认」而 MCP 那边其实放行 —— 界面说得比实际严
  switch (migrateApprovalMode(preset)) {
    case 'unattended':
      return [
        ...readOnly,
        'workflow:write-draft',
        'workflow:publish',
        'workflow:run',
        'memory:write',
      ];
    case 'ai_assisted':
      return [...readOnly, 'workflow:write-draft', 'memory:write'];
    default:
      // 认不出来的档位按最严说 —— 与引擎那边一致
      return readOnly;
  }
}

/** 末尾那句话。图纸写的是「发布与运行未授权」，这里说的是当下的实情。 */
function withheldNote(preset: string | null): string {
  switch (migrateApprovalMode(preset)) {
    case 'unattended':
      return '全部放行 · 这一档下写操作不再逐项确认';
    case 'ai_assisted':
      return '发布与运行需逐项确认';
    default:
      return '任何写操作都需逐项确认';
  }
}

export function SupervisorDrawer({
  open,
  context,
  graph,
  onApply,
  onClose,
}: SupervisorDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);

  /*
   * 打开时把焦点接管进输入框。
   *
   * 不接管的话焦点仍留在身后的页面上：Tab 会一路穿过被遮罩挡住、
   * 根本点不到的画布控件，键盘用户等于被困在一个看不见的图层里。
   */
  useEffect(() => {
    if (!open) return;
    drawerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [open]);

  /*
   * 换了工作流就把提议丢掉 —— 它是对上一张图算出来的。
   *
   * 留着它的话「应用到草稿」会把 A 的操作落到 B：那些 nodeId 在 B 里
   * 要么不存在（报一个用户看不懂的错），要么碰巧存在（改错东西，而且没人会发现）。
   */
  useEffect(() => {
    setProposal((current) =>
      current && current.workflowId !== context.workflowId ? null : current,
    );
  }, [context.workflowId]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  /** 推理深度的候选与当前选择。候选由 runtime 给，不写死。 */
  const [efforts, setEfforts] = useState<string[]>([]);
  const [effort, setEffort] = useState<string | null>(null);
  /** 正在跑的工具调用。它回答的是「它现在在做什么」。 */
  const [liveTool, setLiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  /*
   * 光有上面那条 effect 不够：它只在 workflowId **变化时**跑一次。
   *
   * 提问进行中切换工作流的话，effect 在 proposal 还是 null 时就跑完了，
   * 而回答回来时按发问那一刻的 context 设置 proposal —— 那条 effect
   * 不会再触发，提议就留在屏幕上，「应用到草稿」照样可点。
   * 所以渲染时再比对一次身份，两道都要有。
   */
  const liveProposal = proposal && proposal.workflowId === context.workflowId ? proposal : null;
  /**
   * 当前会话。
   *
   * 第一问时是 null（那时还没有会话），后端回来带上 id，
   * 之后的每一问都带着它 —— 不然同一次对话会散成好几条历史。
   */
  /**
   * 用户从这次对话里摘掉的上下文项（规范 §6：chips 可增删）。
   *
   * 两个用处：问一般性问题时不想被当前草稿带偏；把对话给别人看之前
   * 先把那条运行的 id 摘掉。摘掉的项会列在下面，随时能加回来。
   */
  const [droppedContext, setDroppedContext] = useState<ContextKey[]>([]);
  /*
   * 摘除是「这次对话」的事 —— 换了会话就该回到默认。
   *
   * 不清的话：在上一条会话里摘掉了运行，开新对话或翻开一条历史会话时
   * 那个运行仍然默认被排除，而注释与界面都说的是「从这次对话摘掉」。
   */
  const dropped = (key: ContextKey) => droppedContext.includes(key);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * 这次会话实际拿到的 Scope。
   *
   * 图纸把这一行画成三个固定的 chip 加一句「发布与运行未授权」。
   * 那是**一次会话当时的状态**，不是常量 —— 写死的话，用户把权限档
   * 调成 Trusted Workflow 之后，底下仍然写着「未授权」，
   * 而主管 AI 其实已经能发布了。界面说的话必须是真的。
   *
   * 形态照图纸一字不动：同样的 chip、同样的排版、末尾同样一句说明。
   * 变的只是那句说明说的是不是实话。
   */
  const [preset, setPreset] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  /** 这一问等了多久（秒）。0 表示没在等。 */
  const [waited, setWaited] = useState(0);
  /**
   * 取消的凭据。
   *
   * 取消之后后端仍会回来 —— 那时那个回答已经不是用户要的了，
   * 显示出来会让人以为自己的取消没生效。用一个自增的号码判断：
   * 回来时号码对不上就丢掉。
   */
  const askSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  /*
   * 实时帧落到最后那条 streaming 消息上。
   *
   * `busy` 同时当开关用：用户按了取消之后 busy 立刻变 false，
   * 后续帧就不再往界面上写 —— 不然「已取消」下面还会继续冒字，
   * 而那正是他刚放弃的那一问。
   */
  const onChunk = useCallback((chunk: StreamChunk) => {
    if (chunk.kind === 'toolCall') {
      // 工具活动单独显示：它回答的是「它现在在做什么」，
      // 混进正文会把 agent 的话打断
      setLiveTool(chunk.status === 'completed' ? null : chunk.title);
      return;
    }
    if (chunk.kind !== 'text') return;
    setMessages((prev) => {
      const last = prev.at(-1);
      if (!last || last.role !== 'agent' || !last.streaming) return prev;
      return [...prev.slice(0, -1), { ...last, text: last.text + chunk.text }];
    });
  }, []);
  useStreamChunks(busy, onChunk);

  useEffect(() => {
    if (!open) return;
    // 只列已启用的模型 —— 与 Agent 页同一条规则
    void coreClient
      // 显式要满额：不写 limit 就拿分页的默认值（50），
      // 于是第 51 条之后的已启用模型在下拉里根本不存在 ——
      // 而界面上写着「只列出已启用的条目」
      .call('model.list', { enabledOnly: true, limit: LIST_PAGE_LIMIT_MAX })
      .then((result) => {
        const items = (result as { items: ModelOption[] }).items;
        setModels(items);
        setModelId((current) => current ?? items[0]?.id ?? null);
      })
      .catch(() => setModels([]));
  }, [open]);

  // 推理深度的候选。
  //
  // **不能写死**：codex 现在 6 档（low…ultra）、claude 也是 6 档，
  // 而两边的值不一样，本机 CLI 升级还会再变。只能问 runtime。
  //
  // 缓存在模块级：`model.sync` 会起一个 adapter 进程（实测 ~300ms），
  // 每次开抽屉都来一次的话，用户开关三次就起了三个进程。
  useEffect(() => {
    if (!open || efforts.length > 0) return;
    if (cachedEfforts.length > 0) {
      setEfforts(cachedEfforts);
      return;
    }
    void coreClient
      .call('model.sync', { runtime: AGENT_RUNTIMES[0] })
      .then((result) => {
        const list = (result as { efforts: { value: string }[] }).efforts.map((e) => e.value);
        cachedEfforts = list;
        setEfforts(list);
        // 默认值也用 runtime 自报的那个，不硬编码 ——
        // 实测 codex 是 high，正好是我们想要的默认
        const current = (result as { currentEffort?: string }).currentEffort;
        if (current) setEffort((now) => now ?? current);
      })
      // 拿不到就不显示这个下拉：**不给一份编出来的清单** ——
      // 设一个 agent 不认的深度会被当场拒掉，而用户以为自己选上了
      .catch(() => setEfforts([]));
  }, [open, efforts.length]);

  useEffect(() => {
    if (!open) return;
    // 权限档决定底下那行 Scope 说什么。每次打开都重读 ——
    // 用户可能刚在「设置与环境」里改过，而抽屉里显示的还是上一次的
    void coreClient
      .call('workspace.settings', {})
      .then((result) =>
        setPreset((result as { permissionPreset?: string }).permissionPreset ?? null),
      )
      .catch(() => setPreset(null));
  }, [open]);

  useEffect(() => {
    if (!busy) {
      setWaited(0);
      return;
    }
    // 一直「正在想…」而不说等了多久，用户没法判断是慢还是死了。
    // ACP 那边的超时是 180 秒 —— 干等三分钟没有任何反馈是不可接受的
    const started = Date.now();
    const timer = setInterval(() => {
      setWaited(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    // 新消息进来时滚到底：对话是时间序的，用户要看最新那条。
    // 直接赋 scrollTop 而不是 scrollTo —— 后者在 jsdom 里没实现，
    // 测试会因为一个纯视觉的行为整片红掉
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [messages]);

  if (!open) return null;

  /** 读一条历史会话回对话区。 */
  const openSession = async (id: string) => {
    // 同上：翻开另一条会话时不该带着上一条的摘除
    setDroppedContext([]);
    setError(null);
    try {
      const result = (await coreClient.call('supervisor.session', { sessionId: id })) as {
        messages: { role: 'user' | 'agent'; text: string; at: string }[];
      };
      setMessages(
        result.messages.map((message, index) => ({
          id: `${id}_${index}`,
          role: message.role,
          text: message.text,
        })),
      );
      setSessionId(id);
      setHistoryOpen(false);
      setProposal(null);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    setDraft('');
    setBusy(true);
    setError(null);
    const seq = (askSeq.current += 1);
    setMessages((prev) => [
      ...prev,
      { id: `u_${Date.now()}`, role: 'user', text },
      { id: `a_${Date.now()}`, role: 'agent', text: '', streaming: true },
    ]);

    try {
      const result = (await coreClient.call('supervisor.ask', {
        question: text,
        // 有会话就接上去 —— 不带的话后端会新开一条，
        // 同一次对话在历史里散成好几段
        ...(sessionId ? { sessionId } : {}),
        ...(modelId ? { modelRef: modelId } : {}),
        // 不选就不发 —— 后端据此走「不设置，用 agent 自己的默认」那条路
        ...(effort ? { effort } : {}),
        context: {
          ...(dropped('draft') || context.draftRev === undefined
            ? {}
            : { draftRev: context.draftRev }),
          ...(dropped('run') || !context.runId ? {} : { runId: context.runId }),
          // 后端靠它读当前草稿的图 —— 不给的话 AI 只能凭空造 nodeId，
          // 那些操作应用不到任何东西上
          ...(dropped('draft') || !context.workflowId ? {} : { workflowId: context.workflowId }),
        },
      })) as {
        text: string;
        sessionId?: string;
        /** 这轮对话有没有进历史。false 时答案照给，但要告诉用户。 */
        historySaved?: boolean;
        /** 这轮用了几次工具。界面显示「工具活动 · N 次」。 */
        toolCalls?: number;
        proposal?: { summary: string; operations: PatchOperation[] };
      };

      /*
       * 号码对不上就丢掉 —— 这句注释本来就写在上面，但守卫只写在了 catch 分支里。
       *
       * 成功分支没有它的后果：用户按了取消、界面已显示「已取消」，
       * 几十秒后突然冒出一块「AI 提议的改动」和一个「应用到草稿」按钮 ——
       * 那是他已经放弃的那一问的产物。
       */
      if (seq !== askSeq.current) return;

      if (result.sessionId) setSessionId(result.sessionId);

      setMessages((prev) => {
        const settled = prev.map((message) =>
          message.streaming
            ? {
                ...message,
                text: result.text,
                streaming: false,
                ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
              }
            : message,
        );
        // 落库失败时答案照给，但要说出来 —— 用户隔天回来找不到这条对话，
        // 会以为是自己记错了
        if (result.historySaved === false) {
          settled.push({
            id: `h_${prev.length}`,
            role: 'agent',
            text: '这轮对话没能存进历史，关掉抽屉后就找不到了。',
            system: true,
          });
        }
        return settled;
      });

      // 改动**先出 Diff**，用户确认才落草稿。
      // 这里只是算出「会变成什么样」，一个字节都不写
      if (result.proposal && !graph) {
        /*
         * 没有草稿图时此前整块被 `if (proposal && graph)` 吞掉：
         * AI 在运行页/设置页回了一组改动，界面上什么都不显示，
         * 用户以为它没听懂。算不出 Diff 是事实，但提议本身要说出来。
         */
        setProposal({
          workflowId: context.workflowId,
          summary: result.proposal.summary,
          operations: result.proposal.operations,
          diff: null,
        });
      }

      if (result.proposal && graph) {
        try {
          // 用当前 rev 当 baseRevision：这一步只是**试算**，
          // 真正的守卫在落草稿那一步（editorStore 会带上它自己的 rev）
          const rev = context.draftRev ?? 0;
          const applied = applyPatch(graph, rev, {
            baseRevision: rev,
            operations: result.proposal.operations,
          });
          setProposal({
            workflowId: context.workflowId,
            summary: result.proposal.summary,
            operations: result.proposal.operations,
            diff: applied.diff,
          });
        } catch (err) {
          // AI 引用了一个不存在的节点 —— 多半是图变了而它拿的是旧的。
          // 给一个空 Diff 会让用户以为「没什么改动」然后点确认
          setProposal(null);
          setError(`这次的提议应用不上：${describeError(err)}`);
        }
      }
    } catch (err) {
      if (seq !== askSeq.current) return;
      // 失败时把那条空的 agent 消息去掉 —— 留一个空气泡比没有更糟
      setMessages((prev) => prev.filter((message) => !message.streaming));
      setError(describeError(err));
    } finally {
      if (seq === askSeq.current) {
        setBusy(false);
        // 一轮结束把工具活动清掉：留着的话下一轮的「正在想…」
        // 会显示上一轮最后调过的那个工具
        setLiveTool(null);
      }
    }
  };

  return (
    // 遮罩不关抽屉：里面那个输入框可能正打着一段长问题，
    // 点到外面就没了。同样堵掉「在抽屉里按下鼠标、拖到外面松开」——
    // 那时 click 落在遮罩上，内层的 stopPropagation 拦不住。
    // 关闭的出路是右上角那个按钮与 Esc
    <div className="supervisor__backdrop" data-testid="supervisor-backdrop">
      <aside
        className="supervisor"
        /*
         * 是模态对话框，就要说出来：读屏用户需要听到「进入了一个对话框」，
         * 否则他不知道自己已经离开了身后那一屏。
         */
        role="dialog"
        aria-modal="true"
        aria-label="主管 AI"
        ref={drawerRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;

          /*
           * 焦点陷阱。
           *
           * 光声明 aria-modal="true" 是不够的 —— 实测抽屉打开时身后仍有
           * 18 个元素能 Tab 到，而它们在视觉上被遮罩挡着、根本点不到。
           * 「说是模态、行为不是」对键盘用户比没有模态更糟：他会以为自己
           * 还在抽屉里，其实已经在操作身后那一屏了。
           */
          const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          if (!focusable || focusable.length === 0) return;

          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;

          // 到头了就绕回另一端，而不是走出对话框
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="supervisor__head">
          <span className="supervisor__avatar">
            <i className="ph ph-sparkle" aria-hidden="true" />
          </span>
          <div className="supervisor__title">
            <p className="supervisor__name">主管 AI</p>
            <p className="supervisor__sub">
              掌握全部功能：工作流、节点、运行、记忆、提示词、模型、设置
            </p>
          </div>

          <select
            className="supervisor__model"
            aria-label="切换模型"
            value={modelId ?? ''}
            onChange={(event) => setModelId(event.target.value)}
          >
            {models.length === 0 ? <option value="">未登记模型</option> : null}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>

          {/* 推理深度。候选由 runtime 给 —— 拿不到就不显示这个下拉，
              **不给一份编出来的清单**：设一个 agent 不认的值会被当场拒掉，
              而用户以为自己选上了 */}
          {efforts.length > 0 ? (
            <select
              className="supervisor__model"
              aria-label="推理深度"
              value={effort ?? ''}
              onChange={(event) => setEffort(event.target.value)}
            >
              {efforts.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : null}

          <button
            type="button"
            className="supervisor__close"
            aria-label="历史会话"
            aria-expanded={historyOpen}
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              // 每次展开都重读：别的地方可能刚问过一句
              if (next) {
                void coreClient
                  .call('supervisor.sessions', {})
                  .then((result) => setSessions((result as { items: SessionSummary[] }).items))
                  .catch(() => setSessions([]));
              }
            }}
          >
            <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
          </button>

          <button
            type="button"
            className="supervisor__close"
            aria-label="新对话"
            onClick={() => {
              setMessages([]);
              setSessionId(null);
              setProposal(null);
              setError(null);
              // 摘除是「这次对话」的事，新对话回到默认
              setDroppedContext([]);
            }}
          >
            <i className="ph ph-plus" aria-hidden="true" />
          </button>

          <button type="button" className="supervisor__close" aria-label="关闭" onClick={onClose}>
            <i className="ph ph-x" aria-hidden="true" />
          </button>
        </header>

        {historyOpen ? (
          <section className="supervisor__history" aria-label="历史会话">
            {sessions === null ? <p className="supervisor__empty">正在读取…</p> : null}
            {sessions?.length === 0 ? (
              <p className="supervisor__empty">
                还没有历史会话。你问的每一句都会存下来，隔天回来还能接着问。
              </p>
            ) : null}
            {(sessions ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                className="supervisor__history-item"
                data-session={item.id}
                data-active={item.id === sessionId ? 'true' : undefined}
                onClick={() => void openSession(item.id)}
              >
                <span className="supervisor__history-title">{item.title}</span>
                <span className="supervisor__history-meta">
                  {/* 图纸：「按关联的工作流 / 运行 / 记忆 / 模型标注」 */}
                  {item.workflowId ? <span className="supervisor__chip">工作流</span> : null}
                  {item.runId ? <span className="supervisor__chip">运行</span> : null}
                  <span>{item.messageCount} 条</span>
                  <span>{formatWhen(item.updatedAt)}</span>
                </span>
              </button>
            ))}
          </section>
        ) : null}

        <div className="supervisor__context" aria-label="上下文">
          <span className="supervisor__context-label">上下文</span>
          {context.draftRev !== undefined && !dropped('draft') ? (
            <span className="supervisor__chip">
              <i className="ph ph-graph" aria-hidden="true" />
              草稿 rev{context.draftRev}
              <button
                type="button"
                className="supervisor__chip-drop"
                aria-label="移除草稿上下文"
                onClick={() => setDroppedContext((keys) => [...keys, 'draft'])}
              >
                <i className="ph ph-x" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          {/* 选中节点数不在契约的 context 里，只是给用户看的 —— 没有可摘的东西 */}
          {context.selectedNodes ? (
            <span className="supervisor__chip">
              <i className="ph ph-selection" aria-hidden="true" />
              选中节点 {context.selectedNodes}
            </span>
          ) : null}
          {context.runId && !dropped('run') ? (
            <span className="supervisor__chip">
              <i className="ph ph-clock-counter-clockwise" aria-hidden="true" />
              {context.runId.slice(0, 10)}
              <button
                type="button"
                className="supervisor__chip-drop"
                aria-label="移除运行上下文"
                onClick={() => setDroppedContext((keys) => [...keys, 'run'])}
              >
                <i className="ph ph-x" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          {/* 摘掉的留在这里，随时加回来 —— 否则得关掉抽屉重开 */}
          {droppedContext.map((key) => (
            <button
              key={key}
              type="button"
              className="supervisor__chip supervisor__chip--dropped"
              aria-label={key === 'draft' ? '加回草稿上下文' : '加回运行上下文'}
              onClick={() => setDroppedContext((keys) => keys.filter((k) => k !== key))}
            >
              <i className="ph ph-plus" aria-hidden="true" />
              {key === 'draft' ? '草稿' : '运行'}
            </button>
          ))}
          {/*
           * 这里原来还有一个「记忆 N 条」的 chip。删掉了：契约的
           * supervisor.ask.context 里根本没有记忆这一项，前端也无从知道
           * 后端会注入哪些 —— 它承诺的「这次对话它能看到什么」说不了真话。
           * 要它回来的话，得先让后端把实际注入的记忆回给前端。
           */}
        </div>

        <div className="supervisor__body" ref={bodyRef}>
          {messages.length === 0 ? (
            <p className="supervisor__empty">
              问它任何关于这个应用的事：怎么搭一条工作流、上次运行为什么失败、
              某条记忆会在哪里生效。它的改动都会先给你看 Diff。
            </p>
          ) : null}

          {messages.map((message) => (
            <div key={message.id} className="supervisor__message" data-role={message.role}>
              {message.role === 'agent' ? (
                <span className="supervisor__message-avatar">
                  <i className="ph ph-sparkle" aria-hidden="true" />
                </span>
              ) : null}
              <div className="supervisor__bubble">
                {message.system ? (
                  <span className="supervisor__system">{message.text}</span>
                ) : message.streaming && !message.text ? (
                  <span className="supervisor__thinking">
                    {/* 有工具在跑就说它在做什么 —— 「正在想…」挂十几秒
                        与卡死长得一模一样，而「正在 读取文件」不会 */}
                    {liveTool ? `正在 ${liveTool}` : '正在想…'}
                    {waited >= 5 ? (
                      <span className="supervisor__waited">已等待 {waited} 秒</span>
                    ) : null}
                  </span>
                ) : (
                  <>
                    {message.text}
                    {/* 生成中的信号。没有它的话，一段刚好停在句号上的
                        流式回答与「说完了」看不出区别 */}
                    {message.streaming ? <span className="supervisor__caret" /> : null}
                  </>
                )}
                {message.toolCalls ? (
                  <span className="supervisor__toolcalls">
                    <i className="ph ph-wrench" aria-hidden="true" />
                    工具活动 · {message.toolCalls} 次
                  </span>
                ) : null}
              </div>
            </div>
          ))}

          {liveProposal ? (
            <section className="supervisor__proposal" aria-label="AI 提议的改动">
              <p className="supervisor__proposal-head">
                <i className="ph ph-git-diff" aria-hidden="true" />
                {liveProposal.summary}
              </p>
              {liveProposal.diff ? (
                <div className="ver__diff-body">
                  <DiffLines diff={liveProposal.diff} empty="这组操作不会改变任何东西" />
                </div>
              ) : (
                <p className="supervisor__proposal-note">
                  这里算不出 Diff —— 当前没有打开的工作流草稿。
                  去工作流编辑器里打开对应的工作流再问一次，就能看到改动并应用。
                </p>
              )}
              <div className="supervisor__proposal-actions">
                <button type="button" className="runs__action" onClick={() => setProposal(null)}>
                  不用了
                </button>
                {/*
                 * 两个条件都要：没有 onApply 是没有草稿可落，
                 * 没有 diff 是用户没看过这组操作会变成什么样 ——
                 * 「AI 的改动一律先出 Diff，用户确认才落草稿」是架构原则，
                 * 不能因为调用方碰巧传了 onApply 就绕过它。
                 */}
                {onApply && liveProposal.diff ? (
                  <button
                    type="button"
                    className="runs__action runs__action--primary"
                    onClick={() => {
                      onApply(liveProposal.operations);
                      setProposal(null);
                    }}
                  >
                    应用到草稿
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {error ? (
            <p className="runs__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="supervisor__scopes">
          <span>本次会话授予：</span>
          {grantedScopes(preset).map((scope) => (
            <code key={scope}>{scope}</code>
          ))}
          <em>{withheldNote(preset)}</em>
        </footer>

        <footer className="supervisor__foot">
          {/* ⏎ 发送、⇧⏎ 换行 —— 图纸底部标着那个 ⏎ 符号。
              键盘逻辑在 ChatInput 里只有一份，别在这儿再抄一遍 */}
          <ChatInput
            label="问主管 AI"
            placeholder="问它，或让它改这条工作流…"
            value={draft}
            disabled={busy}
            onChange={setDraft}
            onSubmit={() => void send()}
          />
          {/* 等待时给取消 —— 用户要能脱身。
              ACP 的超时是 180 秒，干等三分钟没有出口是不可接受的 */}
          {busy ? (
            <button
              type="button"
              className="runs__action"
              onClick={() => {
                // 号码一变，回来的答案就会被丢掉
                askSeq.current += 1;
                setBusy(false);
                setLiveTool(null);
                // 留一条回执。不留的话按了取消界面上什么都没变化 ——
                // 那和没按上是一样的观感，用户会再按几次
                setMessages((prev) => [
                  ...prev.filter((message) => !message.streaming),
                  {
                    id: `c_${prev.length}`,
                    role: 'agent',
                    text: waited > 0 ? `等待 ${waited} 秒后已取消` : '已取消',
                    system: true,
                  },
                ]);
              }}
            >
              取消
            </button>
          ) : (
            <button
              type="button"
              className="runs__action runs__action--primary"
              disabled={!draft.trim()}
              onClick={() => void send()}
            >
              发送
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

/** 历史列表里的时间。今天的只给时分，更早的带上日期。 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const today = new Date().toDateString() === at.toDateString();
  return at.toLocaleString('zh-CN', {
    hour12: false,
    ...(today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }),
  });
}
