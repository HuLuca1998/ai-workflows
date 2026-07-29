import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalBanner } from './ApprovalBanner.js';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
  type ReactFlowProps,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeType } from '@aiwf/contracts';
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
import { defaultSourcePort, defaultTargetPort, toFlowEdges, toFlowNodes } from './graphAdapter.js';
import { NODE_HEIGHT, NODE_WIDTH } from './nodeVisuals.js';
import { minimalConfigFor, titleFor } from './nodeDefaults.js';

const NODE_TYPES: NodeTypes = { workflow: WorkflowNode };

interface LiveReactFlowProps extends Omit<ReactFlowProps, 'nodes' | 'onNodesChange'> {
  nodes: NonNullable<ReactFlowProps['nodes']>;
  onNodesChange: (changes: NodeChange[]) => void;
}

/**
 * 只让 React Flow 子树响应 pointermove。
 *
 * 拖动位置如果放在 EditorCanvas，工具栏、节点库、状态栏与所有浮层都会跟着
 * 每个鼠标事件重渲染。这里把高频状态隔离起来，并用 rAF 合并高采样率鼠标在
 * 同一屏幕帧内产生的多次 change；草稿仍然只在 dragging=false 时更新一次。
 */
function LiveReactFlow({
  nodes: graphNodes,
  onNodesChange: persistNodeChanges,
  ...props
}: LiveReactFlowProps) {
  const positionsRef = useRef<Map<string, XYPosition>>(new Map());
  const activeDragIdsRef = useRef<Set<string>>(new Set());
  const frameRef = useRef<number | null>(null);
  const [dragPositions, setDragPositions] = useState<ReadonlyMap<string, XYPosition>>(
    () => new Map(),
  );

  const flushDragPositions = useCallback(() => {
    frameRef.current = null;
    setDragPositions(new Map(positionsRef.current));
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // 最终坐标进入 graph 后再清临时覆盖，前后两层位置相同，不会在松手时跳一帧。
  useEffect(() => {
    setDragPositions((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [id, position] of current) {
        if (activeDragIdsRef.current.has(id)) continue;
        const graphNode = graphNodes.find((node) => node.id === id);
        if (graphNode?.position.x === position.x && graphNode.position.y === position.y) {
          next.delete(id);
          positionsRef.current.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [graphNodes]);

  const nodes = useMemo(() => {
    if (dragPositions.size === 0) return graphNodes;
    return graphNodes.map((node) => {
      const position = dragPositions.get(node.id);
      return position ? { ...node, position } : node;
    });
  }, [graphNodes, dragPositions]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let shouldScheduleFrame = false;
      let shouldFlushNow = false;

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (change.dragging === true) {
            positionsRef.current.set(change.id, change.position);
            activeDragIdsRef.current.add(change.id);
            shouldScheduleFrame = true;
          } else if (change.dragging === false) {
            positionsRef.current.set(change.id, change.position);
            activeDragIdsRef.current.delete(change.id);
            shouldFlushNow = true;
          }
        }

        if (change.type === 'remove') {
          positionsRef.current.delete(change.id);
          activeDragIdsRef.current.delete(change.id);
          shouldFlushNow = true;
        }
      }

      if (shouldFlushNow) {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        flushDragPositions();
      } else if (shouldScheduleFrame && frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flushDragPositions);
      }

      persistNodeChanges(changes);
    },
    [flushDragPositions, persistNodeChanges],
  );

  return <ReactFlow {...props} nodes={nodes} onNodesChange={onNodesChange} />;
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

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      event.preventDefault();
      // 走 store 而不是 flow.setNodes：节点是受控的，
      // React Flow 内部改的 selected 会被下一次渲染覆盖
      setSelection(useEditor.getState().graph.nodes.map((node) => node.id));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSelection]);

  const selectedIds = useMemo(() => new Set(selection), [selection]);
  const nodes = useMemo(
    () => toFlowNodes(graph, { issues: validation.issues, selected: selectedIds }),
    [graph, validation, selectedIds],
  );
  const edges = useMemo(() => toFlowEdges(graph), [graph]);
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

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      setSelectedCount(selected.length);
      setSelection(selected.map((n) => n.id));
    },
    [setSelection],
  );

  // 图纸的编辑器总是针对某个工作流；不带 id 进来时给空态而不是空白画布
  if (!workflowId) {
    return (
      <article className="page">
        <header className="page__head">
          <h1>工作流编辑器</h1>
          <p className="page__summary">设计与维护流程</p>
        </header>
        <p className="page__todo">
          先在<Link to="/">概览与工作流</Link>里选一个工作流，或新建一个。
        </p>
      </article>
    );
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
      {workflowId ? <ApprovalBanner workflowId={workflowId} /> : null}

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
        <NodeLibrary onDragStart={() => {}} />

        <div className="editor__canvas" ref={wrapper}>
          <LiveReactFlow
            key={workflowId}
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
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
            // 图纸：⌘/Ctrl + 滚轮以光标为中心缩放，滚轮平移
            zoomActivationKeyCode="Meta"
            panOnScroll
            selectionOnDrag
            multiSelectionKeyCode="Shift"
            deleteKeyCode={['Delete', 'Backspace']}
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
            <span>Shift 框选 · ⌘A 全选</span>
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
