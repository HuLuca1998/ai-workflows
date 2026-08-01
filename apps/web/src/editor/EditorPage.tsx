import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBanner } from './ApprovalBanner.js';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  type EdgeTypes,
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
  type ReactFlowProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeType } from '@aiwf/contracts';
import { Button, Dialog } from '@aiwf/ui';
import { coreClient, useWorkspace } from '../data/workspace.js';
import { clearLeaveGuard, registerLeaveGuard } from '../layout/leaveGuard.js';
import { describeConnection } from './connectRules.js';
import type { MenuTarget } from './menuActions.js';
import { useEditor } from './editorStore.js';
import { EditorToolbar } from './EditorToolbar.jsx';
import { CanvasContextMenu } from './ContextMenu.jsx';
import { GroupLayer, groupBoxes } from './GroupFrame.jsx';
import { NodeConfigDialog } from './NodeConfigDialog.jsx';
import { NodeLibrary } from './NodeLibrary.jsx';
import { VersionDrawer } from './VersionDrawer.jsx';
import { LaunchDialog } from '../runs/LaunchDialog.js';
import { WorkflowNode } from './WorkflowNode.jsx';
import { FloatingEdge } from './FloatingEdge.jsx';
import { ConnectionLine } from './ConnectionLine.jsx';
import { defaultSourcePort, defaultTargetPort, toFlowEdges, toFlowNodes } from './graphAdapter.js';
import { NODE_HEIGHT, NODE_WIDTH } from './nodeVisuals.js';
import { cascadeFrom, minimalConfigFor, titleFor } from './nodeDefaults.js';
import { needsBulkDeleteConfirm } from './bulkDelete.js';
import { shortcut } from '../data/platformKeys.js';

const NODE_TYPES: NodeTypes = { workflow: WorkflowNode };
/**
 * 连线用自定义组件：端点按节点矩形实时算，不绑 Handle。
 * 对象定义在模块级 —— 放进组件里的话每次渲染都是新引用，
 * XYFlow 会整片重建边。
 */
const EDGE_TYPES: EdgeTypes = { floating: FloatingEdge };

interface LiveReactFlowProps extends Omit<
  ReactFlowProps,
  'nodes' | 'defaultNodes' | 'onNodesChange'
> {
  nodes: NonNullable<ReactFlowProps['nodes']>;
  onNodesChange: (changes: NodeChange[]) => void;
}

/**
 * 让拖动期间的位置完全留在 React Flow 自己的 store。
 *
 * `nodes` 会把组件切到受控模式：XYFlow 每次 pointermove 只上报 change，必须
 * 等 React props 回灌位置才能画下一帧。这里使用 `defaultNodes`，使其在拖动
 * 热路径里直接更新内部 Zustand store；外部 graph 变化时才命令式同步一次。
 */
function LiveReactFlow({
  nodes: graphNodes,
  onNodesChange: persistNodeChanges,
  ...props
}: LiveReactFlowProps) {
  const { setNodes } = useReactFlow();
  const activeDragIdsRef = useRef<Set<string>>(new Set());
  const previousGraphNodesRef = useRef(graphNodes);

  useEffect(() => {
    if (previousGraphNodesRef.current === graphNodes) return;
    previousGraphNodesRef.current = graphNodes;

    setNodes((currentNodes) => {
      if (activeDragIdsRef.current.size === 0) return graphNodes;

      // 配置、校验或选中态可以在拖动中变化；同步这些字段时保住 XYFlow
      // 已经算好的实时坐标，不能拿持久层里的旧位置把节点拽回去。
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graphNodes.map((node) => {
        if (!activeDragIdsRef.current.has(node.id)) return node;
        const current = currentById.get(node.id);
        return current ? { ...node, position: current.position } : node;
      });
    });
  }, [graphNodes, setNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position') {
          if (change.dragging === true) activeDragIdsRef.current.add(change.id);
          if (change.dragging === false) activeDragIdsRef.current.delete(change.id);
        }
        if (change.type === 'remove') activeDragIdsRef.current.delete(change.id);
      }
      persistNodeChanges(changes);
    },
    [persistNodeChanges],
  );

  // colorMode:画布根元素曾挂着 React Flow 的 light 类 —— 自研样式盖住了它,
  // 但内置 Controls/MiniMap 一旦启用就会是浅色的(第 7 轮实测 #9)
  return (
    <ReactFlow
      {...props}
      colorMode="dark"
      defaultNodes={graphNodes}
      onNodesChange={onNodesChange}
    />
  );
}

/**
 * 导出为 JSON 文件。图纸的版本抽屉有「导出此版本」，
 * 导出物就是图本身——它能被原样导入（M1 的导入导出要求）。
 */
function downloadGraph(graph: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** 缩放范围取自图纸：35%–220%。 */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;

/**
 * fitView 的上限压到 100%。
 *
 * 不压的话它会「适配到填满」——拖进来的头几个节点挨得近，
 * 于是画布直接放大到 maxZoom（220%），节点重叠还溢出可视区。
 * fitView 该做的只有「缩小到看得全」，放大交给用户自己。
 */
const FIT_VIEW = { maxZoom: 1, padding: 0.2 };

export function EditorPage() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  );
}

function EditorCanvas() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    name,
    rev,
    graph,
    versions,
    validation,
    dirty,
    saving,
    loading,
    error,
    discardLocal,
    selection,
    load,
    loadVersionGraph,
    rollbackTo,
    apply,
    save,
    publish,
    setSelection,
    rename,
    clear,
  } = useEditor();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  /**
   * 正在等待审批的节点。规范 §6 的审批是双通道（画布脉冲 + 顶部横幅），
   * 而 `toneOf` 此前在全仓没有任何调用方 —— 所有节点恒为 idle，
   * §5.2 里 done / wait / ghost 三种状态全是死代码，双通道只剩横幅。
   */
  const [waitingNodeId, setWaitingNodeId] = useState<string | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  /** 双击打开的节点（图纸：双击节点打开配置弹层）。 */
  const [configNodeId, setConfigNodeId] = useState<string | null>(null);
  /** 右键菜单：目标与屏幕位置。 */
  const [menu, setMenu] = useState<{ target: MenuTarget; at: { x: number; y: number } } | null>(
    null,
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  /** 侧栏导航被离开守卫拦下时弹的确认。存的是**目标路径**，用户确认后去那里。 */
  const [confirmingNavLeave, setConfirmingNavLeave] = useState<string | null>(null);
  /** 上一次连线被拒的理由。几秒后自己消失 —— 它是对刚才那个动作的回应。 */
  const [connectHint, setConnectHint] = useState<string | null>(null);
  /** 等确认的批量删除。非空时弹确认；确认后才真的落 removeNode。 */
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  /**
   * 引用字段（Agent 角色 / 提示词）的候选。查一次给弹层用 ——
   * 自由文本要用户手打 builtin:analyst 这类内部 id，
   * 是三轮浏览器实测里最一致的阻断点（S4/P5/#3）。
   * 读失败落成空 —— 弹层会退回自由文本输入，功能不断。
   */
  const [references, setReferences] = useState<
    Partial<Record<'agentProfile' | 'prompt', { value: string; label: string }[]>>
  >({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      coreClient.call('agent.list', { limit: 200 }),
      coreClient.call('prompt.list', { limit: 200 }),
    ])
      .then(([agents, prompts]) => {
        if (cancelled) return;
        const agentItems = (agents as { items: { id: string; name: string }[] }).items;
        const promptItems = (prompts as { items: { id: string; name: string }[] }).items;
        setReferences({
          agentProfile: agentItems.map((item) => ({
            value: item.id,
            label: `${item.name}（${item.id}）`,
          })),
          prompt: promptItems.map((item) => ({
            value: item.id,
            label: `${item.name}（${item.id}）`,
          })),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  useEffect(() => {
    if (workflowId) void load(workflowId);
    return () => clear();
  }, [workflowId, load, clear]);

  // 从概览的「运行」进来时带 ?run=1 —— 草稿加载完直接开运行对话框,
  // 免得用户到了编辑器还要再找一次「运行」(第 6 轮实测 #11)
  useEffect(() => {
    if (!loading && workflowId && searchParams.get('run') === '1') {
      setLaunchOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('run');
      setSearchParams(next, { replace: true });
    }
  }, [loading, workflowId, searchParams, setSearchParams]);

  /**
   * 刷新或关标签前拦一下未保存的草稿。
   *
   * 站内跳转再后退能保住现场（编辑器只在 workflowId 变化时重建草稿），
   * 但刷新和关标签整个页面就没了 —— 浏览器只给 beforeunload 这一个口子，
   * 而且不允许自定义文案，只能触发它自己那句通用询问。
   *
   * 没有它的时候：拖了两个节点、没点保存、随手刷新，整张图直接消失，
   * 工具栏还显示「已保存」。
   */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 老浏览器看的是 returnValue，新的看 preventDefault，两个都给
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /** 连线提示几秒后自己消失 —— 它是对刚才那个动作的回应，不是常驻状态。 */
  useEffect(() => {
    if (!connectHint) return;
    const timer = setTimeout(() => setConnectHint(null), 5000);
    return () => clearTimeout(timer);
  }, [connectHint]);

  /**
   * 侧栏导航也要拦。
   *
   * 工具栏的「返回」一直会问，而左侧那 7 个链接一个都不拦 ——
   * 拖完节点点一下「记忆」，改动静默丢失（第三方巡检 B-05 实测）。
   * 同一个「离开编辑器」的动作，两条路两种结果。
   */
  useEffect(() => {
    if (!dirty) {
      clearLeaveGuard();
      return;
    }
    registerLeaveGuard((to) => {
      // 记下用户想去哪：不记的话「丢弃并离开」只能回一个写死的路径，
      // 点「记忆」确认丢弃会落在工作流列表（复核实测 B）
      setConfirmingNavLeave(to);
      return false;
    });
    return () => clearLeaveGuard();
  }, [dirty]);

  /**
   * ⌘A 全选 —— 底部状态栏写着它，那它就必须能用。
   *
   * 界面上承诺了却不存在的功能比没有更糟：用户会以为是自己按错了，
   * 反复试几次才放弃，然后开始怀疑别的提示是不是也是假的。
   *
   * 焦点在输入框里时不接管：那时 ⌘A 该是「全选文本」——
   * 改节点标题时想全选却选中整张图，比没有快捷键更让人恼火。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'a' || !(event.metaKey || event.ctrlKey)) return;

      // 弹层开着时画布快捷键整体失效。第 2 轮实测的事故链：焦点落在
      // 弹层内的按钮上按 ⌘A → 画布全选 → Backspace 清空整张画布，
      // 而撤销是「待实现」。按 tagName 挡不住按钮和标签页。
      // 版本抽屉与运行对话框同理 —— 抽屉不是 role=dialog，
      // 光靠下面的 closest 兜不住（codex 复核抓到的）
      if (configNodeId || versionsOpen || launchOpen) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      // 任何模态（运行对话框、版本抽屉…）里的元素都不该触发画布全选
      if (target?.closest?.('[role="dialog"]')) return;

      event.preventDefault();
      // 走 store 而不是 flow.setNodes：节点是受控的，
      // React Flow 内部改的 selected 会被下一次渲染覆盖
      setSelection(useEditor.getState().graph.nodes.map((node) => node.id));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSelection, configNodeId, versionsOpen, launchOpen]);

  /**
   * Enter 打开选中节点的配置 —— 键盘用户此前只有双击这一条路，
   * 配置弹层根本进不去（第 8 轮实测 P0-2，阻断）。
   * 恰好选中一个节点时才响应；焦点在输入框/弹层里时让给它们。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (configNodeId || versionsOpen || launchOpen) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (target?.closest?.('[role="dialog"]')) return;
      const selected = useEditor.getState().selection;
      if (selected.length !== 1) return;
      event.preventDefault();
      setConfigNodeId(selected[0] ?? null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [configNodeId, versionsOpen, launchOpen]);

  const selectedIds = useMemo(() => new Set(selection), [selection]);
  const nodes = useMemo(
    () =>
      toFlowNodes(graph, {
        issues: validation.issues,
        selected: selectedIds,
        toneOf: (nodeId) => (nodeId === waitingNodeId ? 'wait' : 'idle'),
      }),
    [graph, validation, selectedIds, waitingNodeId],
  );
  /**
   * 连线的选中态要自己维护：`edges` 是受控 prop，
   * XYFlow 只上报 change、不会自己改 props，所以不回灌 selected 就点不亮。
   */
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const edges = useMemo(
    () =>
      toFlowEdges(graph, { waitingNodeId }).map((edge) =>
        selectedEdgeIds.has(edge.id) ? { ...edge, selected: true } : edge,
      ),
    [graph, selectedEdgeIds, waitingNodeId],
  );
  const groups = useMemo(() => groupBoxes(graph), [graph]);
  const configNode = useMemo(
    () => (configNodeId ? graph.nodes.find((n) => n.id === configNodeId) : undefined),
    [configNodeId, graph],
  );

  /** 拖动中只更新画面；拖动结束才把最终位置作为一个 Patch 写入草稿。 */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const operations: Parameters<typeof apply>[0] = [];
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          operations.push({ op: 'moveNode', nodeId: change.id, position: change.position });
        }
        if (change.type === 'remove') {
          operations.push({ op: 'removeNode', nodeId: change.id });
        }
      }
      if (operations.length > 0) apply(operations);
    },
    [apply],
  );

  /**
   * 受控的 `edges` 若不配 `onEdgesChange`，XYFlow 的 triggerEdgeChanges 会
   * **静默丢弃**全部 edge change —— 点连线选不中、按 Delete 也删不掉，
   * 而底部状态条上写着「点连线可删」。选中与删除都走这一条路。
   */
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const operations: Parameters<typeof apply>[0] = [];
      let nextSelection: Set<string> | null = null;
      for (const change of changes) {
        if (change.type === 'remove') {
          operations.push({ op: 'disconnect', edgeId: change.id });
        }
        if (change.type === 'select') {
          nextSelection ??= new Set(selectedEdgeIds);
          if (change.selected) nextSelection.add(change.id);
          else nextSelection.delete(change.id);
        }
      }
      if (nextSelection) setSelectedEdgeIds(nextSelection);
      if (operations.length > 0) apply(operations);
    },
    [apply, selectedEdgeIds],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = graph.nodes.find((n) => n.id === connection.source);
      const target = graph.nodes.find((n) => n.id === connection.target);
      if (!source || !target) return;

      /*
       * 拒绝要说话。
       *
       * 原来这里是两行 early return：拖拽虚线正常画出、目标端口还高亮成
       * 紫色（与合法目标一模一样），松手后连线凭空消失 —— 用户只会以为
       * 自己手滑了（B-11）。自连更糟：它压根没被拒，进了草稿之后渲染成
       * 宽度 0 的竖线压在节点底下，点不到删不掉（B-03）。
       */
      const verdict = describeConnection({
        sourceType: source.type,
        targetType: target.type,
        sameNode: source.id === target.id,
        sourceConfig: source.config,
      });
      if (!verdict.ok) {
        setConnectHint(verdict.reason ?? '这两个端口连不上');
        return;
      }

      const sourcePort = defaultSourcePort(source.type, source.config);
      const targetPort = defaultTargetPort(target.type);
      if (!sourcePort || !targetPort) return;

      setConnectHint(null);
      apply([
        {
          op: 'connect',
          source: { nodeId: source.id, port: sourcePort },
          target: { nodeId: target.id, port: targetPort },
        },
      ]);
    },
    [graph, apply],
  );

  /**
   * 一次删一批之前先问。
   *
   * ⌘A + Delete 会一秒删光整张图，而撤销/重做在工具栏上永久禁用 ——
   * 一次误触就是全毁（第三方巡检 B-04）。单个删除照旧不问：
   * 那是常规操作，问了只会让人学会闭眼点确认。
   *
   * 必须用 `onBeforeDelete` 而不是在 `onNodesChange` 里 return：
   * 画布跑在非受控模式（`defaultNodes`），XYFlow 自己维护内部 store ——
   * 在 change 那一层拦下只会让**画布上删了而草稿里还在**，
   * 两边一不一致就白屏（实测过一次）。
   */
  /**
   * 已经确认过的那一批。
   *
   * 用户点「删除」之后要真的删，而删除只能走 React Flow 自己的
   * `deleteElements` —— 绕过它直接 `apply(removeNode)` 的话，
   * XYFlow 内部 store 里那些节点还在，它随后会为「消失的节点」
   * 再发一轮 remove change，于是 `removeNode` 应用两遍：
   * 第二遍找不到节点，整个编辑器崩成「节点 entry_1 不存在」
   * （复核实测，含全新工作流必现）。
   *
   * 所以确认放行走这个 ref：deleteElements 会重新触发 onBeforeDelete，
   * 那一次直接 true，删除照常经 onNodesChange 落一次草稿。
   */
  const confirmedDelete = useRef<Set<string>>(new Set());

  const onBeforeDelete = useCallback(async ({ nodes }: { nodes: { id: string }[] }) => {
    const ids = nodes.map((node) => node.id);
    // 这一批已经确认过：放行，让删除走正常那条路
    if (ids.length > 0 && ids.every((id) => confirmedDelete.current.has(id))) {
      for (const id of ids) confirmedDelete.current.delete(id);
      return true;
    }
    if (!needsBulkDeleteConfirm(ids.length)) return true;
    setPendingDelete(ids);
    return false;
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/aiwf-node-type') as NodeType;
      if (!type) return;

      // 落点换算到画布坐标，再让节点中心对准鼠标
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      apply([
        {
          op: 'addNode',
          type,
          title: titleFor(type),
          position: { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 },
          config: minimalConfigFor(type),
        },
      ]);
    },
    [flow, apply],
  );

  /**
   * 从节点库**点**出来的节点落在哪。
   *
   * 拖拽有鼠标位置，点击没有 —— 落在视口中央是唯一说得通的选择：
   * 落在原点的话，画布已经平移过之后新节点会出现在屏幕外，
   * 用户看到的仍然是「点了没反应」。
   */
  const onAddFromLibrary = useCallback(
    (type: NodeType) => {
      const center = flow.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const position = cascadeFrom(useEditor.getState().graph.nodes, {
        x: center.x - NODE_WIDTH / 2,
        y: center.y - NODE_HEIGHT / 2,
      });
      apply([
        {
          op: 'addNode',
          type,
          title: titleFor(type),
          position,
          config: minimalConfigFor(type),
        },
      ]);
    },
    [flow, apply],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      setSelectedCount(selected.length);
      setSelection(selected.map((n) => n.id));
    },
    [setSelection],
  );

  // 图纸的编辑器总是针对某个工作流；不带 id 进来时给空态而不是空白画布
  if (!workflowId) {
    return <EditorEmptyState />;
  }

  if (loading) {
    return <div className="editor-loading">正在读取草稿…</div>;
  }

  // 加载失败(多半是 /editor/<不存在的 id>)：给明确的空态,
  // 而不是把错误条挂在一个照样能画能点、点运行才漏出
  // `FOREIGN KEY constraint failed` 的空白编辑器上(第 6 轮实测 #4)
  if (error && rev === 0 && graph.nodes.length === 0) {
    return (
      <article className="page">
        <header className="page__head">
          <h1>打不开这个工作流</h1>
          <p className="page__summary">{error}</p>
        </header>
        <p className="page__todo">
          它可能已被删除，或链接里的 id 不对。<Link to="/">回到工作流列表</Link>。
        </p>
      </article>
    );
  }

  return (
    <div className="editor">
      <EditorToolbar
        name={name}
        rev={rev}
        {...(versions[0] ? { latestVersion: versions[0].version } : {})}
        dirty={dirty}
        saving={saving}
        validation={validation}
        nodeCount={graph.nodes.length}
        edgeCount={graph.edges.length}
        onSave={() => void save()}
        onPublish={() => void publish()}
        onToggleVersions={() => setVersionsOpen((open) => !open)}
        onRun={() => setLaunchOpen(true)}
        onRename={(next) => void rename(next)}
      />

      {launchOpen && workflowId ? (
        <LaunchDialog
          workflowId={workflowId}
          workflowName={name}
          graph={graph}
          rev={rev}
          versions={versions}
          onClose={() => setLaunchOpen(false)}
          onStarted={(runId) => {
            setLaunchOpen(false);
            // 直接去执行记录看这次运行：启动的意图就是要看它跑
            navigate(`/runs?run=${runId}`);
          }}
        />
      ) : null}

      {/* 侧栏导航被守卫拦下时的确认。文案与工具栏「返回」那个一致 ——
          同一件事在两条路上说两种话，用户会以为后果不同 */}
      <Dialog
        open={confirmingNavLeave !== null}
        title="有未保存的改动"
        onClose={() => setConfirmingNavLeave(null)}
        width={420}
        actions={
          <>
            <Button onClick={() => setConfirmingNavLeave(null)}>留下继续编辑</Button>
            <Button
              variant="danger"
              onClick={() => {
                // 去**用户点的那个地方**。写死 '/' 的话他点「记忆」、
                // 确认丢弃，落在工作流列表（复核实测 B）
                const to = confirmingNavLeave ?? '/';
                setConfirmingNavLeave(null);
                // 守卫先撤，否则下一句 navigate 会被它自己拦下
                clearLeaveGuard();
                void navigate(to);
              }}
            >
              丢弃并离开
            </Button>
          </>
        }
      >
        <p>
          这份草稿还没保存到后端 —— 现在离开，这些改动会丢。 要保留的话先点工具栏的「保存草稿」。
        </p>
      </Dialog>

      {/* 图纸把它放在工具栏与画布之间：用户在这一屏做的是改流程，
          而有个运行正卡在审批上等他 —— 那件事得先看见 */}
      {workflowId ? (
        <ApprovalBanner workflowId={workflowId} onWaitingNode={setWaitingNodeId} />
      ) : null}

      {/* 批量删除的确认。撤销还没有，所以这是唯一一道防线 */}
      <Dialog
        open={pendingDelete !== null}
        title={`删除 ${pendingDelete?.length ?? 0} 个节点？`}
        onClose={() => setPendingDelete(null)}
        width={420}
        actions={
          <>
            <Button onClick={() => setPendingDelete(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                const ids = pendingDelete ?? [];
                setPendingDelete(null);
                if (ids.length === 0) return;
                // 走 React Flow 自己的删除：直接 apply 的话它内部 store
                // 里那些节点还在，随后会再发一轮 remove change，
                // removeNode 应用两遍就崩（见 confirmedDelete 的注释）
                for (const id of ids) confirmedDelete.current.add(id);
                void flow.deleteElements({ nodes: ids.map((id) => ({ id })) });
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p>
          连着的线也会一并删掉。<strong>撤销还没有做</strong> ——
          删错了只能重新搭，或者不保存草稿直接刷新页面回到上次保存的样子。
        </p>
      </Dialog>

      {/* 连线被拒的理由。放在画布上方而不是一个 toast：用户的视线
          刚才就在这附近，而 toast 会飘到屏幕角落 */}
      {connectHint ? (
        <p className="editor-connect-hint" role="status">
          <i className="ph ph-prohibit" aria-hidden="true" />
          {connectHint}
        </p>
      ) : null}

      {error ? (
        <p className="editor-error" role="alert">
          {error}
          {/* 冲突时重试没用（baseRevision 已过期），得给一条主动脱身的路。
              保存失败后本地改动一直留着，用户要能明确地丢掉它 */}
          {dirty ? (
            <button type="button" className="editor-error__action" onClick={discardLocal}>
              放弃本地改动
            </button>
          ) : null}
        </p>
      ) : null}

      {versionsOpen ? (
        <VersionDrawer
          rev={rev}
          dirty={dirty}
          graph={graph}
          versions={versions}
          loadVersionGraph={loadVersionGraph}
          onClose={() => setVersionsOpen(false)}
          onPublish={() => {
            void publish().then((version) => {
              if (version) setVersionsOpen(false);
            });
          }}
          onRollback={(versionId) => {
            void rollbackTo(versionId).then(() => setVersionsOpen(false));
          }}
          onExport={(exported, label) => downloadGraph(exported, `${name}-${label}`)}
        />
      ) : null}

      <div className="editor__body">
        <NodeLibrary onDragStart={() => {}} onAdd={onAddFromLibrary} />

        <div className="editor__canvas" ref={wrapper}>
          <LiveReactFlow
            key={workflowId}
            nodes={nodes}
            edges={edges}
            onEdgesChange={onEdgesChange}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            // 拖线预览：源端口跟着鼠标方位换（设计图的行为）。
            // 默认预览线锁死在被按下的那个 Handle 上，从下方拖会先向右甩一段。
            connectionLineComponent={ConnectionLine}
            onNodesChange={onNodesChange}
            onBeforeDelete={onBeforeDelete}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            onNodeDoubleClick={(_, node) => setConfigNodeId(node.id)}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setMenu({
                target: { kind: 'node', nodeId: node.id },
                at: { x: event.clientX, y: event.clientY },
              });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              setMenu({
                target: { kind: 'edge', edgeId: edge.id },
                at: { x: event.clientX, y: event.clientY },
              });
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              const e = event as unknown as MouseEvent;
              setMenu({ target: { kind: 'canvas' }, at: { x: e.clientX, y: e.clientY } });
            }}
            onPaneClick={() => setMenu(null)}
            onDrop={onDrop}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onMove={(_, viewport) => setZoom(viewport.zoom)}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            fitView
            fitViewOptions={FIT_VIEW}
            // 规范 §6：⌘/Ctrl + 滚轮以光标为中心缩放，滚轮平移。
            // 不写 zoomActivationKeyCode —— XYFlow 的默认值就是
            // `isMacOs() ? 'Meta' : 'Control'`，写死 "Meta" 反而让非 macOS
            // （Web 形态）失去缩放快捷键。
            panOnScroll
            // 框选靠默认的 selectionKeyCode='Shift'。
            // 不传 selectionOnDrag：XYFlow 会算 `selectionOnDrag && panOnDrag !== true`，
            // 而 panOnDrag 默认 true，所以那个 prop 恒为 false —— 留着只会误导下一个人。
            multiSelectionKeyCode="Shift"
            // 配置弹层开着时把删除键交还给输入框：焦点这时还停在被双击的
            // react-flow 节点上，按 Backspace 会连节点带弹层一起删掉，而撤销是禁用的。
            deleteKeyCode={configNode ? null : ['Delete', 'Backspace']}
            // §8「200 节点拖拽 ≥50fps」：只渲染视口内的元素
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
          >
            <ViewportPortal>
              <GroupLayer
                boxes={groups}
                onContextMenu={(groupId, at) => setMenu({ target: { kind: 'group', groupId }, at })}
              />
            </ViewportPortal>
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          </LiveReactFlow>

          {graph.nodes.length === 0 ? <p className="editor__hint">从左侧拖入入口节点</p> : null}

          <div className="editor__zoom">
            <button type="button" onClick={() => void flow.zoomIn()} aria-label="放大">
              <i className="ph ph-plus" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => void flow.zoomOut()} aria-label="缩小">
              <i className="ph ph-minus" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => void flow.fitView()} aria-label="适应视图">
              <i className="ph ph-crosshair-simple" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="editor__zoom-value"
              onClick={() => void flow.zoomTo(1)}
              aria-label="缩放复位到 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
          </div>

          {menu ? (
            <CanvasContextMenu
              target={menu.target}
              at={menu.at}
              ctx={{ graph, selection }}
              onClose={() => setMenu(null)}
              onApply={apply}
              onEditNode={setConfigNodeId}
            />
          ) : null}

          {configNode ? (
            <NodeConfigDialog
              references={references}
              node={configNode}
              graph={graph}
              onClose={() => setConfigNodeId(null)}
              onSave={(config, title) => {
                const ops: Parameters<typeof apply>[0] = [
                  { op: 'setConfig', nodeId: configNode.id, config },
                ];
                // 标题没改就不产生多余的 Diff 项
                if (title !== configNode.title) {
                  ops.push({ op: 'renameNode', nodeId: configNode.id, title });
                }
                apply(ops);
                setConfigNodeId(null);
              }}
            />
          ) : null}

          <div className="editor__status">
            <span>双击编辑 · 右键菜单</span>
            <span className="editor__status-dot">·</span>
            <span>端口拖出连线 · 点连线可删</span>
            <span className="editor__status-dot">·</span>
            <span>Shift 框选 · {shortcut('A')} 全选</span>
            <span className="editor__status-dot">·</span>
            <span>{selectedCount > 0 ? `已选 ${selectedCount} 个` : '未选中'}</span>
            <span className="editor__status-dot">·</span>
            <span>
              {graph.nodes.length} 节点 {graph.edges.length} 连接
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 不带工作流 id 时的空态。文案说「或新建一个」，那就必须真的有新建入口 ——
 * 只给一个跳回概览的链接是条死胡同（第 1 轮实测 M11）。
 */
function EditorEmptyState() {
  const navigate = useNavigate();
  const createWorkflow = useWorkspace((state) => state.createWorkflow);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  return (
    <article className="page">
      <header className="page__head">
        <h1>工作流编辑器</h1>
        <p className="page__summary">设计与维护流程</p>
      </header>
      <p className="page__todo">
        先在<Link to="/">概览与工作流</Link>里选一个工作流，或者
      </p>
      <p>
        <Button
          variant="primary"
          loading={creating}
          onClick={() => {
            if (creating) return;
            setCreating(true);
            void createWorkflow(null)
              .then((id) => {
                if (id) navigate(`/editor/${id}`);
              })
              // 建失败要说出来 —— 只有 then/finally 的话按钮弹回原状,
              // 用户看不到任何原因(codex 复核抓到的)
              .catch((error: unknown) => {
                setCreateError(error instanceof Error ? error.message : String(error));
              })
              .finally(() => setCreating(false));
          }}
        >
          <i className="ph ph-plus" aria-hidden="true" />
          新建工作流
        </Button>
      </p>
      {createError ? <p role="alert">新建失败：{createError}</p> : null}
    </article>
  );
}
