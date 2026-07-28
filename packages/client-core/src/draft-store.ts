import {
  applyPatch,
  type PatchOperation,
  type ValidationResult,
  type WorkflowDiff,
  type WorkflowGraph,
} from '@aiwf/contracts';
import type { CoreApiClient } from './client.js';

/**
 * 草稿 store。
 *
 * 两条产品原则在这里落地：
 * 「草稿与执行分离」——本地改动只影响草稿，运行中的版本不受影响；
 * 「AI 建议 ≠ 执行」——AI 的改动进 pendingProposal，出 Diff，用户确认后才写。
 *
 * 本地是乐观的：画布立刻响应，提交失败则整体回滚——绝不留下一份服务端并不知道的图。
 */

export interface DraftSnapshot {
  graph: WorkflowGraph;
  rev: number;
}

export interface PatchOutcome {
  diff: WorkflowDiff;
  validation: ValidationResult;
}

export interface PendingProposal extends PatchOutcome {
  operations: PatchOperation[];
  /** 谁提的：主管 AI、MCP 调用方或用户自己。 */
  by: string;
  graph: WorkflowGraph;
}

export class DraftStore {
  private readonly client: CoreApiClient;
  readonly workflowId: string;

  private currentGraph: WorkflowGraph;
  /** 服务端已知的图：提交失败时回滚到它。 */
  private committedGraph: WorkflowGraph;
  private currentRev: number;
  private pending: PatchOperation[] = [];
  private proposal: PendingProposal | null = null;
  private listeners = new Set<() => void>();

  constructor(client: CoreApiClient, workflowId: string, initial: DraftSnapshot) {
    this.client = client;
    this.workflowId = workflowId;
    this.currentGraph = structuredClone(initial.graph);
    this.committedGraph = structuredClone(initial.graph);
    this.currentRev = initial.rev;
  }

  get graph(): WorkflowGraph {
    return this.currentGraph;
  }

  /** 服务端已确认的修订号；本地未提交的改动不会推高它。 */
  get rev(): number {
    return this.currentRev;
  }

  get isDirty(): boolean {
    return this.pending.length > 0;
  }

  get pendingProposal(): PendingProposal | null {
    return this.proposal;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 用户直接编辑：立刻改本地图，攒着等 commit。 */
  apply(operations: PatchOperation[]): PatchOutcome {
    const outcome = this.applyInternal(operations);
    this.notify();
    return outcome;
  }

  /**
   * AI 提议：算出 Diff 与校验结果，但**不动草稿**。
   * 界面据此在画布上高亮将新增的节点与连线，等用户点「应用到草稿」。
   */
  propose(operations: PatchOperation[], meta: { by?: string } = {}): PatchOutcome {
    const result = applyPatch(this.currentGraph, this.currentRev, {
      baseRevision: this.currentRev,
      operations,
    });
    this.proposal = {
      operations,
      diff: result.diff,
      validation: result.validation,
      by: meta.by ?? 'user',
      graph: result.graph,
    };
    this.notify();
    return { diff: result.diff, validation: result.validation };
  }

  acceptProposal(): PatchOutcome | null {
    const proposal = this.proposal;
    if (!proposal) return null;
    // 内部应用后统一通知一次，避免订阅者收到两连击
    const outcome = this.applyInternal(proposal.operations);
    this.proposal = null;
    this.notify();
    return outcome;
  }

  discardProposal(): void {
    if (!this.proposal) return;
    this.proposal = null;
    this.notify();
  }

  /**
   * 提交待写入的操作。
   * 版本冲突时回滚本地图并把错误抛给调用方——由界面提示「草稿已变化，请重新读取」。
   */
  async commit(): Promise<void> {
    if (this.pending.length === 0) return;

    const operations = this.pending;
    try {
      const result = (await this.client.call('workflow.patch', {
        id: this.workflowId,
        baseRevision: this.currentRev,
        operations,
        // 结果图一并提交：applyPatch 的实现只在这一侧，引擎不重写一份（ADR-0008）
        graphJson: JSON.stringify(this.currentGraph),
      })) as { rev: number };

      this.currentRev = result.rev;
      this.committedGraph = structuredClone(this.currentGraph);
      this.pending = [];
      this.notify();
    } catch (error) {
      // **不回滚**。
      //
      // 曾经无条件把本地图退回 committedGraph 并清空 pending，代价是：
      // 网络抖一下（服务端根本没收到）用户拖的节点就没了，界面还显示
      // 禁用的「已保存」——数据丢了，而提示说一切正常。
      //
      // 版本冲突也一样保留：并发保护挡住了「旧版本覆盖新草稿」，
      // 但保护完顺手清掉本地现场，只是把一种数据损失换成了另一种。
      //
      // 保留意味着 isDirty 仍是 true，界面据此显示「未保存」并允许重试；
      // 要脱身走 discardLocal()，那得用户自己按。
      this.notify();
      throw error;
    }
  }

  /**
   * 放弃本地未提交的改动，回到服务端已确认的那份图。
   *
   * 提交失败后本地改动会一直留着（见 commit 的 catch）。冲突场景里
   * 重试也没用 —— baseRevision 已经过期。这个方法是用户主动脱身的出路：
   * 明确知道自己在丢什么，然后按下去。
   */
  discardLocal(): void {
    if (this.pending.length === 0) return;
    this.currentGraph = structuredClone(this.committedGraph);
    this.pending = [];
    this.notify();
  }

  /** 服务端有了新版本（别处改了草稿）时重置本地状态。 */
  reset(snapshot: DraftSnapshot): void {
    this.currentGraph = structuredClone(snapshot.graph);
    this.committedGraph = structuredClone(snapshot.graph);
    this.currentRev = snapshot.rev;
    this.pending = [];
    this.proposal = null;
    this.notify();
  }

  private applyInternal(operations: PatchOperation[]): PatchOutcome {
    // 先算再写：applyPatch 抛错时本地图保持原样，不会留下半截改动
    const result = applyPatch(this.currentGraph, this.currentRev, {
      baseRevision: this.currentRev,
      operations,
    });
    this.currentGraph = result.graph;
    this.pending = [...this.pending, ...operations];
    return { diff: result.diff, validation: result.validation };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
