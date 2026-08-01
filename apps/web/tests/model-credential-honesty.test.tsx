import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

/**
 * 凭据这一格要说清「现在填了没用」。
 *
 * 第三方巡检 C-29 实测：填明文会被拦下并告知「请先把密钥存进钥匙串，
 * 再在这里引用它」—— 文案对，但**没有任何按钮或链接带用户去存**，
 * 也没说怎么存，用户到这一步就卡住。
 *
 * 实证下来问题更深一层：`cred_ref` 在引擎与 core-api 里**零消费点**
 * （只有存储层存取它），而 `sync_models` 的注释自己写着
 * 「ACP 不用凭据（登录态由 CLI 自己管）」—— 当前两个 runtime
 * 都不需要它。所以正确的做法不是给一行 `security` 命令，
 * 而是说清这个字段现在的真实状态。
 *
 * 与 `NodeConfigDialog.tsx` 那条同一个写法：在界面上直说。
 */

const call = vi.fn();
vi.mock('../src/data/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  coreClient: { call: (m: string, i: unknown) => call(m, i) },
}));

const { createContractCall } = await import('./_contractClient.js');
const { ModelsPage } = await import('../src/models/ModelsPage.js');

beforeEach(() => {
  call.mockReset();
  const checked = createContractCall({
    'model.list': () => ({ items: [], total: 0 }),
    'model.create': () => ({ id: 'model_new' }),
  });
  call.mockImplementation((m: string, i: unknown) => checked(m, i));
});

async function 打开登记表单() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ModelsPage />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /登记模型/u }));
  return user;
}

describe('凭据这一格说清现状', () => {
  it('表单上就写明 ACP 不需要它 —— 不用等用户填错才说', async () => {
    await 打开登记表单();
    const form = document.querySelector('.models__form')!;
    expect(form.textContent, 'cred_ref 在引擎里零消费，而这一格看起来是必要配置').toMatch(
      /不需要|不读|留空/u,
    );
  });

  it('填了明文时的报错要说清怎么办，不是一句「请先存进钥匙串」', async () => {
    const user = await 打开登记表单();
    const form = document.querySelector('.models__form')!;
    const 凭据框 = [...form.querySelectorAll('input')].find((input) =>
      input.closest('label')?.textContent?.includes('凭据'),
    )!;

    await user.type(screen.getByLabelText(/名称/u), '测试模型');
    await user.type(凭据框, 'sk-plain-text');
    // 表单内的提交按钮 —— 页面上还有一个同名的「登记模型」入口
    const submit = [...form.querySelectorAll('button')].find(
      (button) => button.getAttribute('type') === 'submit',
    )!;
    await user.click(submit);

    const alert = await screen.findByRole('alert');
    // 要么给出具体命令，要么说清「ACP 不用填，留空即可」——
    // 只说「请先存进钥匙串」是死胡同
    expect(alert.textContent).toMatch(/security add-generic-password|留空|不需要/u);
  });
});
