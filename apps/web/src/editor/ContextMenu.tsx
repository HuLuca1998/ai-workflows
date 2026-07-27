import { useEffect, useRef, useState } from 'react';
import { NODE_LIBRARY, resolveNodeOutputs, type NodeType } from './editorDeps.js';
import {
  menuItemsFor,
  operationsFor,
  type MenuActionInput,
  type MenuContext,
  type MenuTarget,
} from './menuActions.js';
import { minimalConfigFor, titleFor } from './nodeDefaults.js';
import type { PatchOperation } from './editorDeps.js';

export interface CanvasContextMenuProps {
  target: MenuTarget;
  /** 屏幕坐标。 */
  at: { x: number; y: number };
  ctx: MenuContext;
  onClose: () => void;
  onApply: (operations: PatchOperation[]) => void;
  /** 「编辑配置」不改图，交回给画布打开弹层。 */
  onEditNode: (nodeId: string) => void;
}

/**
 * 画布右键菜单。菜单项与动作都来自 menuActions.ts（那部分有单测），
 * 这里只负责呈现、二级选择（端口 / 插入的节点类型）与输入（分组名）。
 */
export function CanvasContextMenu({
  target,
  at,
  ctx,
  onClose,
  onApply,
  onEditNode,
}: CanvasContextMenuProps) {
  const items = menuItemsFor(target, ctx);
  const ref = useRef<HTMLDivElement>(null);
  /** 需要二级选择时，记住是哪一项。 */
  const [pending, setPending] = useState<string | null>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const run = (itemId: string, input: MenuActionInput = {}) => {
    if (itemId === 'edit' && target.kind === 'node') {
      onEditNode(target.nodeId);
      onClose();
      return;
    }
    const operations = operationsFor(itemId, target, ctx, input);
    if (operations.length > 0) onApply(operations);
    onClose();
  };

  const onPick = (itemId: string, needsInput?: boolean) => {
    if (!needsInput) {
      run(itemId);
      return;
    }
    setPending(itemId);
    setText('');
  };

  return (
    <div
      ref={ref}
      className="ctx"
      role="menu"
      tabIndex={-1}
      style={{ left: at.x, top: at.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      // 菜单本身的右键不再冒泡，否则会把菜单关掉又重开
      onContextMenu={(event) => event.preventDefault()}
    >
      {pending === null ? (
        items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="ctx__item"
            data-danger={item.danger ? 'true' : undefined}
            disabled={item.disabled}
            title={item.disabledReason}
            onClick={() => onPick(item.id, item.needsInput)}
          >
            {item.label}
          </button>
        ))
      ) : (
        <SecondStep
          itemId={pending}
          target={target}
          ctx={ctx}
          text={text}
          onText={setText}
          onCancel={() => setPending(null)}
          onConfirm={run}
        />
      )}
    </div>
  );
}

function SecondStep({
  itemId,
  target,
  ctx,
  text,
  onText,
  onCancel,
  onConfirm,
}: {
  itemId: string;
  target: MenuTarget;
  ctx: MenuContext;
  text: string;
  onText: (next: string) => void;
  onCancel: () => void;
  onConfirm: (itemId: string, input: MenuActionInput) => void;
}) {
  // 切换源端口：列出该节点的全部输出端口
  if (itemId === 'switch-port' && target.kind === 'edge') {
    const edge = ctx.graph.edges.find((e) => e.id === target.edgeId);
    const source = ctx.graph.nodes.find((n) => n.id === edge?.source.nodeId);
    const ports = source ? resolveNodeOutputs(source.type, source.config) : [];
    return (
      <>
        <p className="ctx__label">选择源端口</p>
        {ports.map((port) => (
          <button
            key={port.id}
            type="button"
            role="menuitem"
            className="ctx__item"
            data-current={port.id === edge?.source.port ? 'true' : undefined}
            onClick={() => onConfirm('switch-port', { value: port.id })}
          >
            {port.label}
            {port.id === edge?.source.port ? ' ·  当前' : ''}
          </button>
        ))}
        <button type="button" className="ctx__item ctx__item--back" onClick={onCancel}>
          返回
        </button>
      </>
    );
  }

  // 在连线上插入节点：列出节点库
  if (itemId === 'insert-node') {
    return (
      <>
        <p className="ctx__label">插入哪种节点</p>
        <div className="ctx__scroll">
          {NODE_LIBRARY.flatMap((entry) => entry.types).map((type: NodeType) => (
            <button
              key={type}
              type="button"
              role="menuitem"
              className="ctx__item"
              onClick={() =>
                onConfirm('insert-node', {
                  nodeType: type,
                  nodeTitle: titleFor(type),
                  nodeConfig: minimalConfigFor(type),
                })
              }
            >
              {titleFor(type)}
            </button>
          ))}
        </div>
        <button type="button" className="ctx__item ctx__item--back" onClick={onCancel}>
          返回
        </button>
      </>
    );
  }

  // 其余需要输入的（建分组、重命名分组）
  const label = itemId === 'rename-group' ? '新的分组名' : '分组名称';
  return (
    <form
      className="ctx__form"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(itemId, { value: text });
      }}
    >
      <label className="ctx__label" htmlFor="ctx-input">
        {label}
      </label>
      <input
        id="ctx-input"
        className="ctx__input"
        value={text}
        onChange={(e) => onText(e.target.value)}
        autoFocus
      />
      <div className="ctx__form-actions">
        <button type="button" className="ctx__item ctx__item--back" onClick={onCancel}>
          返回
        </button>
        <button type="submit" className="ctx__item">
          确定
        </button>
      </div>
    </form>
  );
}
