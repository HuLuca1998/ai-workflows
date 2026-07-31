import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBanner } from './ApprovalBanner.js';
import { Link, useNavigate, useParams } from 'react-router';
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
import { Button } from '@aiwf/ui';
import { useWorkspace } from '../data/workspace.js';
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
import { minimalConfigFor, titleFor } from './nodeDefaults.js';
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

  return <ReactFlow {...props} defaultNodes={graphNodes} onNodesChange={onNodesChange} />;
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

  useEffect(() => {
    if (workflowId) void load(workflowId);
    return () => clear();
  }, [workflowId, load, clear]);

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
      // 而撤销是「待实现」。按 tagName 挡不住按钮和标签页
      if (configNodeId) return;

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
  }, [setSelection, configNodeId]);

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

      const sourcePort = defaultSourcePort(source.type, source.config);
      const targetPort = defaultTargetPort(target.type);
      // 端口不存在说明这个方向本来就不该连（如从 end 拖出、连到 entry）
      if (!sourcePort || !targetPort) return;

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
      apply([
        {
          op: 'addNode',
          type,
          title: titleFor(type),
          position: { x: center.x - NODE_WIDTH / 2, y: center.y - NODE_HEIGHT / 2 },
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

      {/* 图纸把它放在工具栏与画布之间：用户在这一屏做的是改流程，
          而有个运行正卡在审批上等他 —— 那件事得先看见 */}
      {workflowId ? (
        <ApprovalBanner workflowId={workflowId} onWaitingNode={setWaitingNodeId} />
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
              .then((id) => navigate(`/editor/${id}`))
              .finally(() => setCreating(false));
          }}
        >
          <i className="ph ph-plus" aria-hidden="true" />
          新建工作流
        </Button>
      </p>
    </article>
  );
}
