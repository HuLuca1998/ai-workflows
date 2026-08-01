import { useMemo, useState } from 'react';
import { IMPLEMENTED_NODE_TYPES, NODE_LIBRARY, type NodeType } from '@aiwf/contracts';
import { iconFor, isAiNode } from './nodeVisuals.js';

export interface NodeLibraryProps {
  /** 拖入画布时回调（画布负责换算落点坐标）。 */
  onDragStart: (type: NodeType) => void;
  /**
   * 点击或按键激活时回调 —— 画布把它落在中央。
   *
   * 只做拖拽是不够的：这些条目挂着 `role="button"` 与 `tabIndex={0}`，
   * 那是在宣告「我可以被激活」。而在补上这个之前，
   * 点它没有任何反应（节点没出现也没报错），**键盘用户
   * 无法往画布添加任何节点** —— 空画布右键那一项还是禁用的。
   */
  onAdd: (type: NodeType) => void;
}

/**
 * 节点库面板，186px，照图纸「02 画布编辑器」：
 * 标题「节点库 · 拖入画布」+ 搜索框 + 条目列表（图标 · 名称 · 拖动手柄）。
 *
 * 图纸里是 15 条目录项（脚本节点合并成一条）。点开脚本那条会展开两种解释器——
 * 图纸没画展开态，所以这里让它直接给出两个条目而不是自造一个交互。
 */
export function NodeLibrary({ onDragStart, onAdd }: NodeLibraryProps) {
  const [query, setQuery] = useState('');

  const entries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    // 把节点库的 15 条展开成可拖的具体类型：脚本那条给出 shell 与 python 两项
    const flat = NODE_LIBRARY.flatMap((entry) =>
      entry.types.map((type) => ({
        type,
        label:
          entry.types.length > 1 ? `${entry.label.split(' / ')[0] ?? entry.label}` : entry.label,
        display: entry.types.length > 1 ? labelForScript(type) : entry.label,
        summary: entry.summary,
        // 引擎跑不跑得了它。判据取自契约，不在这里抄一份 ——
        // 抄的那份会在某个类型接上之后继续说它没实现
        implemented: IMPLEMENTED_NODE_TYPES.includes(type),
      })),
    );
    if (!keyword) return flat;
    return flat.filter(
      (item) =>
        item.display.toLowerCase().includes(keyword) ||
        item.summary.toLowerCase().includes(keyword),
    );
  }, [query]);

  return (
    <aside className="node-lib" aria-label="节点库">
      <p className="node-lib__title">节点库 · 拖入画布</p>

      <label className="node-lib__search">
        <i className="ph ph-magnifying-glass" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索节点"
          aria-label="搜索节点"
        />
      </label>

      <div className="node-lib__list">
        {entries.map((item) => (
          <div
            key={item.type}
            className="node-lib__item"
            draggable
            onDragStart={(event) => {
              // 用 dataTransfer 传类型：画布 onDrop 时才知道落点
              event.dataTransfer.setData('application/aiwf-node-type', item.type);
              event.dataTransfer.effectAllowed = 'move';
              onDragStart(item.type);
            }}
            onClick={() => onAdd(item.type)}
            onKeyDown={(event) => {
              // 空格的默认行为是滚动页面 —— 不拦的话用户按一下
              // 节点加上了，同时整页往下跳一屏
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onAdd(item.type);
              }
            }}
            title={
              item.implemented
                ? item.summary
                : `${item.summary}\n\n引擎还没实现这种节点：搭进草稿没问题，运行会在这里停下。`
            }
            role="button"
            tabIndex={0}
            data-node-type={item.type}
            data-implemented={item.implemented ? 'true' : 'false'}
          >
            <i
              className={`ph ${iconFor(item.type)}`}
              data-ai={isAiNode(item.type) ? 'true' : undefined}
              aria-hidden="true"
            />
            <span className="node-lib__label">{item.display}</span>
            {/* 文字而不只是颜色：纯色标注对读屏与色觉障碍用户等于不存在。
                不禁用拖拽 —— 先把流程搭出来等实现落地是合法用法，
                这一屏的职责是说清楚，不是拦住 */}
            {item.implemented ? null : <span className="node-lib__todo">未实现</span>}
            <i className="ph ph-dots-six-vertical node-lib__grip" aria-hidden="true" />
          </div>
        ))}

        {entries.length === 0 ? <p className="node-lib__empty">没有匹配的节点</p> : null}
      </div>
    </aside>
  );
}

function labelForScript(type: NodeType): string {
  return type === 'script.python' ? 'Python 脚本' : 'Shell 脚本';
}
