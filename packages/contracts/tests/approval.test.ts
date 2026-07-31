import { describe, expect, it } from 'vitest';

import {
  APPROVAL_MODES,
  NODE_DECIDERS,
  RISK_LEVELS,
  approvalDecider,
  baseRiskOf,
  type ApprovalMode,
  type NodeDecider,
} from '../src/approval.js';
import { migrateApprovalMode } from '../src/capabilities.js';
import { NODE_TYPES, getNodeDefinition } from '../src/nodes/index.js';
import { getMethodSpec } from '../src/api.js';

/**
 * 审批三档 —— 谁来批工作流里的那些门。
 *
 * **权限由流程管**：执行节点拿最高权限，要不要停下来问由工作流的形状决定
 * （在「探索完成 → 开始编辑」之间、在「编码完成 → 开 PR」之间放一个
 * approval 节点）。这三档决定的是那些门由谁来批。
 *
 * 判定是两维的：全局档位（用户当下想被打扰多少）× 节点上写的
 * （工作流作者的意图）。两维都在契约里，因为引擎按它拦、界面按它提示 ——
 * 两处各写一份的话，用户在设置里选的那一档在两个地方含义不同。
 */

describe('三档的形状', () => {
  it('从严到松三档，顺序就是界面上的顺序', () => {
    expect(APPROVAL_MODES).toEqual(['human_approval', 'ai_assisted', 'unattended']);
  });

  it('风险从低到高三级', () => {
    expect(RISK_LEVELS).toEqual(['read_only', 'workspace_write', 'external_write']);
  });
});

describe('判定矩阵：全局档位 × 节点上写的 → 谁来批', () => {
  /**
   * 整张表摊开写。用循环生成期望值等于把实现抄一遍 ——
   * 那样实现改了期望跟着改，测试永远绿。
   */
  const 矩阵: [ApprovalMode, NodeDecider, 'ai' | 'human'][] = [
    // 全都我来 —— 节点上写的 ai 也不作数
    ['human_approval', 'auto', 'human'],
    ['human_approval', 'user', 'human'],
    ['human_approval', 'ai', 'human'],

    // 节点说了算；没说时默认 AI
    ['ai_assisted', 'auto', 'ai'],
    ['ai_assisted', 'user', 'human'],
    ['ai_assisted', 'ai', 'ai'],

    // 全交给 AI —— 节点上写的 user 也不作数
    ['unattended', 'auto', 'ai'],
    ['unattended', 'user', 'ai'],
    ['unattended', 'ai', 'ai'],
  ];

  for (const [mode, nodeDecider, expected] of 矩阵) {
    it(`${mode} × 节点写 ${nodeDecider} → ${expected}`, () => {
      expect(approvalDecider(mode, nodeDecider)).toBe(expected);
    });
  }

  it('中间档是唯一一档会看节点配置的', () => {
    // 另外两档的名字就是「全都我来」与「全交给 AI」——
    // 它们要是也看节点配置，那两个名字就不成立了
    const 会看节点的 = APPROVAL_MODES.filter(
      (mode) => approvalDecider(mode, 'user') !== approvalDecider(mode, 'ai'),
    );
    expect(会看节点的).toEqual(['ai_assisted']);
  });

  it('无人值守连「必须我批」也交给 AI —— 否则它不叫无人值守', () => {
    expect(approvalDecider('unattended', 'user')).toBe('ai');
  });

  it('节点没写时按 auto 算', () => {
    for (const mode of APPROVAL_MODES) {
      expect(approvalDecider(mode, undefined)).toBe(approvalDecider(mode, 'auto'));
    }
  });

  it('没有「不用批」这一档 —— 门就是门', () => {
    // 审批节点是工作流作者显式放下的一道门。
    // 让某个档位把它整个跳过，等于让设置页悄悄改写工作流的形状
    for (const mode of APPROVAL_MODES) {
      for (const nodeDecider of NODE_DECIDERS) {
        expect(['ai', 'human']).toContain(approvalDecider(mode, nodeDecider));
      }
    }
  });
});

describe('认不出的值按最严处理', () => {
  it('档位拼错 → 回到人', () => {
    // 数据库里躺一个旧值（比如上一版的 workspace_safe）时会走到这里。
    // 静默交给 AI 的话，用户以为自己设了一道要亲自批的门
    for (const nodeDecider of NODE_DECIDERS) {
      expect(approvalDecider('workspace_safe' as ApprovalMode, nodeDecider)).toBe('human');
    }
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
  it('每个节点类型都有基线风险 —— 漏一个，审批界面上那一栏就是空的', () => {
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

  it('会动文件或起进程的节点不能标成只读', () => {
    // 风险等级现在是**给审批者看的说明**，不是自动拦截的依据。
    // 把 ai.execute 标成「只读」，批的那个人（或 AI）会以为
    // 放行它不会改任何东西
    for (const type of ['ai.execute', 'script.shell', 'script.python', 'git.worktree', 'env']) {
      expect(baseRiskOf(type), `${type} 被判成了只读`).not.toBe('read_only');
    }
  });

  it('纯流程与纯分析的节点是只读 —— 审批界面上不该吓唬人', () => {
    for (const type of ['entry', 'end', 'approval', 'ai.analyze', 'ai.review', 'ai.decide']) {
      expect(baseRiskOf(type), `${type} 不该拦`).toBe('read_only');
    }
  });

  it('未知节点类型按外部写算', () => {
    // 契约加了新节点而这张表没跟上时走到这里。
    // 默认 read_only 的话，审批界面会对一个没人知道会做什么的节点
    // 说「这一步什么都不改」
    expect(baseRiskOf('something.new')).toBe('external_write');
  });
});
