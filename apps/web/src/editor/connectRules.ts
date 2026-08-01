import { getNodeDefinition, type NodeType } from '@aiwf/contracts';
import { defaultSourcePort, defaultTargetPort } from './graphAdapter.js';

/**
 * 一次连线能不能建，以及**建不了的时候那句话**。
 *
 * 原来这些判断是 `onConnect` 里的两行 early return：拖拽虚线正常画出、
 * 目标端口还高亮成紫色（与合法目标一模一样），松手后连线凭空消失，
 * 无 toast 无文案 —— 用户只会以为自己手滑了（第三方巡检 B-11）。
 *
 * 自连更糟：它**没有**被拒，而是进了草稿。那条边渲染成宽度 0 的竖线
 * 压在节点底下，点不到也删不掉，只能删掉整个节点连带丢配置（B-03）。
 *
 * 抽成纯函数是为了测得了：early return 只能靠渲染整个画布验，
 * 而 jsdom 不做布局。
 */

export interface ConnectVerdict {
  ok: boolean;
  /** 拒绝时给人看的一句话。放行时为空。 */
  reason?: string;
}

export function describeConnection(input: {
  sourceType: NodeType;
  targetType: NodeType;
  sameNode: boolean;
  /**
   * 源节点当前配置。条件分支的输出端口由它决定。
   *
   * 收 `unknown` 而不是 `Record<string, unknown>`：图里的 config 类型是
   * `unknown`（Schema 驱动，形状随节点类型变），收窄的话每个调用点
   * 都要断言一次，而断言正是「类型说得通、运行时不成立」的来源。
   */
  sourceConfig?: unknown;
}): ConnectVerdict {
  if (input.sameNode) {
    return {
      ok: false,
      reason: '不能连到自己 —— 工作流必须是有向无环图，自连会让这个节点永远等自己',
    };
  }

  const sourcePort = defaultSourcePort(
    input.sourceType,
    input.sourceConfig ?? getNodeDefinition(input.sourceType).seed ?? {},
  );
  if (!sourcePort) {
    return {
      ok: false,
      reason: `「${getNodeDefinition(input.sourceType).title}」没有输出端口，连不出去`,
    };
  }

  const targetPort = defaultTargetPort(input.targetType);
  if (!targetPort) {
    return {
      ok: false,
      reason: `「${getNodeDefinition(input.targetType).title}」没有输入端口，连不进去`,
    };
  }

  return { ok: true };
}
