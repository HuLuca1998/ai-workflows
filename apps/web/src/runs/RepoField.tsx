import { useEffect, useId, useState } from 'react';
import { coreClient } from '../data/workspace.js';
import { describeError } from '../data/describeError.js';

/**
 * 启动表单里的仓库字段（inputSchema 的 `format: 'repo'`）。
 *
 * 仓库与分支是**一个字段**，值是 `{name, branch}` —— 它们本来就不该分开填：
 * 分支只有在某个仓库里才有意义，先选仓库再选分支是唯一说得通的顺序。
 *
 * 为什么值得从 gh 拉：手填 `owner/name` 打错一个字，要等运行跑到
 * `git clone` 那一步才报错，而那时 worktree 已经建好了。
 *
 * **gh 用不了时退回两个文本框**，并把原因显示出来。
 * 一个空下拉看着像「你没有仓库」，用户会跑去 GitHub 上找自己哪儿配错了；
 * 而把人堵在这儿更糟 —— 他明明知道自己要跑哪个仓库。
 */

interface Repo {
  fullName: string;
  defaultBranch: string;
  isOrg: boolean;
}

export interface RepoFieldProps {
  /** 仓库全名（`owner/name`），没选时是空串。 */
  name: string;
  branch: string;
  onChange: (next: { name: string; branch: string }) => void;
  /** 必填且没选时标红。 */
  invalid?: boolean;
}

export function RepoField({ name, branch, onChange, invalid }: RepoFieldProps) {
  const repoId = useId();
  const branchId = useId();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [ghError, setGhError] = useState<string | null>(null);
  /** 点一次「重试」加一，effect 靠它重跑。 */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void coreClient
      .call('github.repos', {})
      .then((result) => {
        if (cancelled) return;
        setRepos((result as { items: Repo[] }).items);
        setGhError(null);
      })
      .catch((err: unknown) => {
        // 说清原因并让位给手填，不是显示一个空下拉
        if (!cancelled) setGhError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    // 还没选仓库就没有分支可问 —— 白问一次只是让用户多等
    if (!name) {
      setBranches([]);
      return;
    }
    // 已经退回手填了就别再问：这个 effect 会拿默认分支**覆盖**用户填的值，
    // 而他此刻正一个字一个字地敲。列仓库都失败了，问分支多半也不会成
    if (ghError !== null) return;
    let cancelled = false;
    void coreClient
      .call('github.branches', { repo: name })
      .then((result) => {
        if (cancelled) return;
        const { items, defaultBranch } = result as { items: string[]; defaultBranch: string };
        setBranches(items);
        // 换了仓库之后旧分支多半不存在了。预选默认分支，
        // 让「选完仓库直接就能跑」成立
        if (!items.includes(branch)) onChange({ name, branch: defaultBranch });
      })
      .catch(() => {
        // 仓库列表拿到了、分支没拿到：让分支可以手填，别把整个字段废掉
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
    // branch 不进依赖：它由这个 effect 自己写，进去会立刻再跑一轮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, ghError]);

  if (ghError !== null) {
    return (
      <div className="launch__repo">
        <p className="launch__repo-error" role="status">
          {ghError}{' '}
          {/* 网络抖一下（代理切节点）就会失败，重试一次多半就好。
              没有这个按钮的话，唯一的出路是关掉对话框重开 ——
              而那会把已经填好的其它参数一起丢掉 */}
          <button
            type="button"
            className="launch__repo-retry"
            onClick={() => setAttempt((n) => n + 1)}
          >
            重试
          </button>
        </p>
        <div className="launch__repo-row">
          <label className="launch__repo-sub" htmlFor={repoId}>
            仓库
          </label>
          <input
            id={repoId}
            value={name}
            placeholder="owner/name"
            aria-invalid={invalid ? 'true' : undefined}
            onChange={(event) => onChange({ name: event.target.value, branch })}
          />
          <label className="launch__repo-sub" htmlFor={branchId}>
            分支
          </label>
          <input
            id={branchId}
            value={branch}
            placeholder="分支"
            onChange={(event) => onChange({ name, branch: event.target.value })}
          />
        </div>
      </div>
    );
  }

  const orgRepos = (repos ?? []).filter((repo) => repo.isOrg);
  const personalRepos = (repos ?? []).filter((repo) => !repo.isOrg);

  return (
    <div className="launch__repo">
      <div className="launch__repo-row">
        <label className="launch__repo-sub" htmlFor={repoId}>
          仓库
        </label>
        <select
          id={repoId}
          value={name}
          aria-invalid={invalid ? 'true' : undefined}
          onChange={(event) => onChange({ name: event.target.value, branch: '' })}
        >
          <option value="">{repos === null ? '正在读取仓库…' : '选择仓库'}</option>
          {/* 分组：个人的和组织的混在一列里很难找，而用户往往有几十个 */}
          {orgRepos.length > 0 ? (
            <optgroup label="组织">
              {orgRepos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </optgroup>
          ) : null}
          {personalRepos.length > 0 ? (
            <optgroup label="个人">
              {personalRepos.map((repo) => (
                <option key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>

        <label className="launch__repo-sub" htmlFor={branchId}>
          分支
        </label>
        <select
          id={branchId}
          value={branch}
          disabled={!name}
          onChange={(event) => onChange({ name, branch: event.target.value })}
        >
          <option value="">{name ? '选择分支' : '先选仓库'}</option>
          {branches.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
