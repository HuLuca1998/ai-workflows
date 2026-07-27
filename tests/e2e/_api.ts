import type { Page } from '@playwright/test';

/**
 * 在浏览器里直接调开发服务，用来给用例铺数据。
 *
 * 走 `page.evaluate` 而不是 Node 侧的 fetch，是为了让请求来自页面同源上下文 ——
 * 顺带验证了 CORS 配置真的放行了浏览器。
 *
 * 端口从环境变量取：写死的话，换一个端口起服务（比如本地已有实例占着 5177）
 * 就会得到「Failed to fetch」这种毫无指向性的错误。
 */
export const API_BASE = process.env.AIWF_TEST_API ?? 'http://127.0.0.1:5177';

export async function api(page: Page, command: string, body: unknown = {}): Promise<unknown> {
  return page.evaluate(
    async ([base, cmd, payload]) => {
      const response = await fetch(`${base}/ipc/${cmd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload as string,
      });
      if (!response.ok) throw new Error(`${cmd}: ${await response.text()}`);
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    },
    [API_BASE, command, JSON.stringify(body)] as const,
  );
}

/** 建一个工作流并存下它的图，返回 id 与草稿 rev。 */
export async function seedWorkflow(
  page: Page,
  name: string,
  graph: unknown,
): Promise<{ id: string; rev: number }> {
  const id = (await api(page, 'workflow_create', { name })) as string;
  const rev = (await api(page, 'workflow_save_draft', {
    id,
    baseRev: 0,
    graphJson: JSON.stringify(graph),
  })) as number;
  return { id, rev };
}
