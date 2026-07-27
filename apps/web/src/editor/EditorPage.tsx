import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeType } from '@aiwf/contracts';
import type { MenuTarget } from './menuActions.js';
import { useEditor } from './editorStore.js';
import { EditorToolbar } from './EditorToolbar.jsx';
import { CanvasContextMenu } from './ContextMenu.jsx';
import { NodeConfigDialog } from './NodeConfigDialog.jsx';
import { NodeLibrary } from './NodeLibrary.jsx';
import { WorkflowNode } from './WorkflowNode.jsx';
import { defaultSourcePort, defaultTargetPort, toFlowEdges, toFlowNodes } from './graphAdapter.js';
import { NODE_HEIGHT, NODE_WIDTH } from './nodeVisuals.js';
import { minimalConfigFor, titleFor } from './nodeDefaults.js';

const NODE_TYPES: NodeTypes = { workflow: WorkflowNode };

/** 缩放范围取自图纸：35%–220%。 */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;

export function EditorPage() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  );
}

function EditorCanvas() {
  const { workflowId } = useParams();
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
    selection,
    load,
    apply,
    save,
    publish,
    setSelection,
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

  useEffect(() => {
    if (workflowId) void load(workflowId);
    return () => clear();
  }, [workflowId, load, clear]);

  const nodes = useMemo(
    () => toFlowNodes(graph, { issues: validation.issues }),
    [graph, validation],
  );
  const edges = useMemo(() => toFlowEdges(graph), [graph]);
  const configNode = useMemo(
    () => (configNodeId ? graph.nodes.find((n) => n.id === configNodeId) : undefined),
    [configNodeId, graph],
  );

  /** 拖动结束才写入草稿：拖动过程中每帧都提交会产生几十个无意义的修订。 */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          apply([{ op: 'moveNode', nodeId: change.id, position: change.position }]);
        }
        if (change.type === 'remove') {
          apply([{ op: 'removeNode', nodeId: change.id }]);
        }
      }
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
        onToggleVersions={() => {}}
      />

      {error ? (
        <p className="editor-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="editor__body">
        <NodeLibrary onDragStart={() => {}} />

        <div className="editor__canvas" ref={wrapper}>
          <ReactFlow
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
            // 图纸：⌘/Ctrl + 滚轮以光标为中心缩放，滚轮平移
            zoomActivationKeyCode="Meta"
            panOnScroll
            selectionOnDrag
            multiSelectionKeyCode="Shift"
            deleteKeyCode={['Delete', 'Backspace']}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          </ReactFlow>

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
