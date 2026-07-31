import { describe, expect, it } from 'vitest';

import {
  APPROVAL_MODES,
  RISK_LEVELS,
  approvalDecider,
  baseRiskOf,
  type ApprovalMode,
  type RiskLevel,
} from '../src/approval.js';
import { migrateApprovalMode } from '../src/capabilities.js';
import { NODE_TYPES, getNodeDefinition } from '../src/nodes/index.js';
import { getMethodSpec } from '../src/api.js';

/**
 * 审批三档。
 *
 * 这三档替换了原来的 review_every_change / workspace_safe / trusted_workflow ——
 * 那三档描述的是「哪一类操作要确认」，而用户真正要选的是**谁来确认**：
 * 全都我来 / AI 顶大部分但外部写留给我 / 全交给 AI。
 *
 * 判定是两维的：档位（谁批）× 风险等级（这一步会造成什么）。
 * 两维都放在契约里，因为引擎按它拦、界面按它提示、MCP 按它决定要不要确认 ——
 * 三处各写一份的话，用户在设置里选的那一档在三个地方含义不同。
 */

describe('三档的形状', () => {
  it('从严到松三档，顺序就是界面上的顺序', () => {
    expect(APPROVAL_MODES).toEqual(['human_approval', 'ai_assisted', 'unattended']);
  });

  it('风险从低到高三级', () => {
    expect(RISK_LEVELS).toEqual(['read_only', 'workspace_write', 'external_write']);
  });
});

describe('判定矩阵：档位 × 风险 → 谁来批', () => {
  /**
   * 整张表摊开写。用循环生成期望值等于把实现抄一遍 ——
   * 那样实现改了期望跟着改，测试永远绿。
   */
  const 矩阵: [ApprovalMode, RiskLevel, 'none' | 'ai' | 'human'][] = [
    // 只读的三档都不拦。用户的原话：「现在连读取 issue 都需要用户审批」
    ['human_approval', 'read_only', 'none'],
    ['ai_assisted', 'read_only', 'none'],
    ['unattended', 'read_only', 'none'],

    // 工作区内写：可回滚、不出这台机器
    ['human_approval', 'workspace_write', 'human'],
    ['ai_assisted', 'workspace_write', 'ai'],
    ['unattended', 'workspace_write', 'ai'],

    // 外部写：push、PR、删远端。别人看得见，撤不回来
    ['human_approval', 'external_write', 'human'],
    ['ai_assisted', 'external_write', 'human'],
    ['unattended', 'external_write', 'ai'],
  ];

  for (const [mode, risk, expected] of 矩阵) {
    it(`${mode} × ${risk} → ${expected}`, () => {
      expect(approvalDecider(mode, risk)).toBe(expected);
    });
  }

  it('ai_assisted 与 unattended 的唯一差别就在外部写那一格', () => {
    // 这条是「AI 审批，关键节点用户审批」这句话的全部内容。
    // 两档在别处也有差异的话，「关键节点」就不止外部写这一类，
    // 而界面上并没有第二个地方告诉用户那是什么
    const 不同 = RISK_LEVELS.filter(
      (risk) => approvalDecider('ai_assisted', risk) !== approvalDecider('unattended', risk),
    );
    expect(不同).toEqual(['external_write']);
  });

  it('无人值守也不是「不批」——AI 批过要留下决定', () => {
    // 返回 'none' 的话就没有 approval.decided 事件，
    // 事后没人能回答「这次 push 是谁放行的」
    expect(approvalDecider('unattended', 'external_write')).toBe('ai');
  });
});

describe('认不出的值按最严处理', () => {
  it('档位拼错 → 全部人工', () => {
    // 数据库里躺一个旧值（比如上一版的 workspace_safe）时会走到这里。
    // 静默放行的话，用户以为自己选的是某一档，实际一道门都没有
    for (const risk of RISK_LEVELS) {
      const decider = approvalDecider('workspace_safe' as ApprovalMode, risk);
      expect(decider, `${risk} 在未知档位下被放行了`).toBe('human');
    }
  });

  it('风险等级拼错 → 按外部写那一档算', () => {
    expect(approvalDecider('ai_assisted', 'somehow_new' as RiskLevel)).toBe('human');
    expect(approvalDecider('unattended', 'somehow_new' as RiskLevel)).toBe('ai');
  });
});

describe('上一版三档的迁移', () => {
  it('旧档位在 API 层被拒 —— 值域换了就得真的换', () => {
    // 原来的测试只遍历 PERMISSION_PRESETS 断言「里面的都合法」，
    // 换掉整组值它照样绿。这条点名旧值，换回去会红
    const spec = getMethodSpec('workspace.updateSettings');
    for (const 旧值 of ['review_every_change', 'workspace_safe', 'trusted_workflow']) {
      expect(spec.input.safeParse({ permissionPreset: 旧值 }).success, `${旧值} 仍被接受`).toBe(
        false,
      );
    }
  });

  it('按严格程度对齐，不按名字像不像', () => {
    expect(migrateApprovalMode('review_every_change')).toBe('human_approval');
    expect(migrateApprovalMode('workspace_safe')).toBe('ai_assisted');
    expect(migrateApprovalMode('trusted_workflow')).toBe('unattended');
  });

  it('新值原样返回 —— 迁移函数在读取处每次都跑，不能把已迁好的又改一遍', () => {
    for (const mode of APPROVAL_MODES) {
      expect(migrateApprovalMode(mode)).toBe(mode);
    }
  });

  it('认不出的值、空值都回到最严那档', () => {
    for (const 坏值 of ['', '随便什么', null, undefined]) {
      expect(migrateApprovalMode(坏值), `${坏值} 没有回到最严档`).toBe('human_approval');
    }
  });
});

describe('节点的基线风险', () => {
  it('每个节点类型都有基线风险 —— 漏一个就是漏一道门', () => {
    for (const type of NODE_TYPES) {
      expect(RISK_LEVELS, `${type} 没有基线风险`).toContain(baseRiskOf(type));
    }
  });

  it('契约里标了 externalWrite 的节点，基线风险必须是 external_write', () => {
    // 两处声明同一件事，就会有两处不一致的那天。
    // 这条不是同义反复：externalWrite 是既有字段，很多地方在读它，
    // 而 baseRisk 是新加的 —— 新增节点时只改一处是最可能发生的事
    for (const type of NODE_TYPES) {
      if (getNodeDefinition(type).externalWrite) {
        expect(baseRiskOf(type), `${type} 标了 externalWrite 却不是 external_write`).toBe(
          'external_write',
        );
      }
    }
  });

  it('会动文件或起进程的节点不能是只读', () => {
    // 判成 read_only 就等于三档全部放行。
    // 这几个类型无论如何都到不了那一档
    for (const type of ['ai.execute', 'script.shell', 'script.python', 'git.worktree', 'env']) {
      expect(baseRiskOf(type), `${type} 被判成了只读`).not.toBe('read_only');
    }
  });

  it('纯流程与纯分析的节点是只读 —— 否则最严档下连看一眼都要批', () => {
    for (const type of ['entry', 'end', 'approval', 'ai.analyze', 'ai.review', 'ai.decide']) {
      expect(baseRiskOf(type), `${type} 不该拦`).toBe('read_only');
    }
  });

  it('未知节点类型按外部写算', () => {
    // 契约加了新节点而这张表没跟上时走到这里。
    // 默认 read_only 的话，新节点会带着「三档全放行」上线
    expect(baseRiskOf('something.new')).toBe('external_write');
  });
});
