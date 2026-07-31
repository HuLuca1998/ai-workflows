// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 纪律二「绝不假装成功」在界面文案层的守卫。
 *
 * 三种形态里的第三种：**界面文案承诺了一件事，实现里没有对应代码**。
 * 这一类躲得过所有渲染测试 —— 断言「那句话在位」的测试反而会把假承诺锁死
 * （实测：提示词页与引导页各有一条测试正是这么锁的）。
 *
 * 所以守卫的形态是「文案与实现的接缝」：某句话出现在界面上时，
 * 它依赖的那条实现路径必须真的存在。
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const promptsPage = read('apps/web/src/prompts/PromptsPage.tsx');
const agentsPage = read('apps/web/src/agents/AgentsPage.tsx');
const onboardingPage = read('apps/web/src/onboarding/OnboardingPage.tsx');
const updateCard = read('apps/web/src/updater/UpdateCard.tsx');

describe('提示词库 · 文案跟着事实走', () => {
  it('B-3 已接上:不再自称「引擎不读」,也说清追溯靠什么', () => {
    // run_ai 现在读 promptId、发 system.prompt_resolved(B-3 已还清)。
    // 老实话过时之后留着就是新的假话
    expect(promptsPage).not.toContain('引擎目前不读提示词库');
    expect(promptsPage).not.toContain('执行路径尚未接上');
    expect(promptsPage).toContain('system.prompt_resolved');
  });
});

describe('Agent 新建 · 乐观行不能显示假的权限档', () => {
  it('提交与乐观插入共用同一份 capabilities 常量', () => {
    // 之前乐观行写 `capabilities: {}`，而详情区取不到键回落 'none' ——
    // 刚建好的角色四项全显示「不允许」，与后端实际存的不一致，
    // 而表单上还写着「新建时默认只读文件、不联网」。
    expect(agentsPage).toContain('const NEW_AGENT_CAPABILITIES');
    const uses = agentsPage.match(/capabilities: NEW_AGENT_CAPABILITIES/gu) ?? [];
    expect(uses.length, '提交处与乐观插入处都要用这个常量').toBe(2);
    // 不能再出现空对象的写法
    expect(agentsPage).not.toMatch(/capabilities: \{\},/u);
  });
});

describe('首次引导 · 按钮名要与它真的做的事一致', () => {
  it('主按钮不叫「安装」—— 应用不替你装任何东西', () => {
    // 同一屏里两段说明都写着「应用不替你下载任何东西」，
    // 而主按钮却写「确认并安装」的话，两者自相矛盾
    expect(onboardingPage).not.toContain('确认并安装');
    expect(onboardingPage).not.toContain('一键安装');
  });

  it('点不动的主按钮旁边要说清还差什么', () => {
    // 必需项没齐时按钮是禁用的。不说原因的话，用户只看到一个灰按钮，
    // 而他不知道该去做什么
    expect(onboardingPage).toContain('先选一个能写入的工作目录');
    expect(onboardingPage).toMatch(/还差 \$\{?missingRequired/u);
  });

  it('「应用不替你下载任何东西」这条产品原则仍在页面上', () => {
    expect(onboardingPage).toMatch(/不替你|不代劳|不安装/u);
  });
});

describe('更新卡片 · 护栏要真的接上，错误要真的显示', () => {
  it('setBlockers 有生产调用方 —— 不能只有单测在调', () => {
    // client-core 的 applyAndRestart 据 blockers 拦截重启，
    // 但整个 apps/web 此前一次都没调过 setBlockers，那道护栏是死的。
    expect(updateCard).toContain('controller.setBlockers');
  });

  it('applyAndRestart 的失败不被吞掉', () => {
    // 它的两条抛错路径在 throw 前都不 patch state，
    // `.catch(() => {})` 会让错误既不进 state.message 也不进 UI ——
    // 用户点了不重启、不报错、按钮不变，只能反复点。
    expect(updateCard).not.toMatch(/applyAndRestart\(\)\.catch\(\(\) => \{\}\)/u);
    expect(updateCard).toContain('setApplyError');
  });
});
