import { useEffect } from 'react';
import { isDesktopRuntime } from '../updater/useAppVersion.js';

/**
 * 主管 AI 的实时帧。
 *
 * 在这之前，一轮对话要几十秒而界面上只有一个转圈：用户唯一能判断
 * 「它还活着吗」的方式是继续等。这条通道让 agent 说到哪、
 * 正在调什么工具都当场看得见。
 *
 * **帧不是事实来源。** 最终那段话仍然由 `supervisor.ask` 的返回值落库，
 * 断线、刷新、翻历史都从库里恢复 —— 所以丢帧不影响正确性，
 * 这也是它可以不落库、可以按窗口聚合的原因。
 *
 * 只在桌面形态挂：Web 侧的 dispatch 是一来一回的 HTTP，
 * 要流式得先有 SSE 端点（还没做）。挂不上时静默退回「转圈等」，
 * 那正是这条通道出现之前的样子。
 */
/**
 * 一帧。`runId` / `nodeId` 只有工作流里的 AI 节点会带 ——
 * 主管 AI 不属于任何一次运行。
 */
export type StreamChunk = { runId?: string; nodeId?: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'toolCall'; title: string; status: string }
);

/**
 * @param runId 只收这条运行的帧。传 `null` 表示只收**不属于任何运行**的
 *   （主管 AI）。一个事件通道服务两处，分流在这里做 ——
 *   不分的话，运行面板会把主管 AI 的话显示成某个节点的输出。
 */
export function useStreamChunks(
  enabled: boolean,
  onChunk: (chunk: StreamChunk) => void,
  runId: string | null = null,
): void {
  useEffect(() => {
    if (!enabled || !isDesktopRuntime()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<StreamChunk>('ai:chunk', (event) => {
          // 形状对不上就丢：payload 来自我们自己的桌面壳，但这一层
          // 不该假设它永远不出错 —— 一个缺 kind 的帧会让渲染分支全落空，
          // 而症状是「流式偶尔不动」，最难查的那种
          const chunk = event.payload;
          if (!chunk || typeof chunk !== 'object' || !('kind' in chunk)) return;
          // 分流：要这条运行的就只收它的，要主管 AI 的就只收没有 runId 的
          if (runId === null ? chunk.runId !== undefined : chunk.runId !== runId) return;
          onChunk(chunk);
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        // 接不上就退回转圈等。这里报错等于在每次提问时
        // 弹一条与用户的问题无关的提示
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, onChunk]);
}
