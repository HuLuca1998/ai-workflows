import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UpdaterBackend } from '@aiwf/client-core';
import { UpdateCard } from '../src/updater/UpdateCard.js';

/**
 * 更新卡片是用户唯一的更新入口——刻意不做「发现新版就弹窗」，
 * 因为这个工具会长时间挂着等审批，打断代价比晚一天更新大。
 */

const backend = (overrides: Partial<UpdaterBackend> = {}): UpdaterBackend => ({
  check: async () => ({ available: true, version: '2026.7.28', notes: '修复缓存未失效' }),
  download: async (onProgress) => onProgress(100),
  installAndRestart: async () => {},
  ...overrides,
});

describe('UpdateCard', () => {
  it('Web 形态没有自更新，说明清楚而不是给个点不动的按钮', () => {
    render(<UpdateCard currentVersion="2026.7.27" backend={null} />);
    expect(screen.getByText(/Web 形态/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull();
  });

  it('进入设置页自动查一次，发现新版本给出下载入口', async () => {
    render(<UpdateCard currentVersion="2026.7.27" backend={backend()} />);
    await waitFor(() => expect(screen.getByText(/发现新版本 2026\.7\.28/u)).toBeInTheDocument());
    expect(screen.getByText('修复缓存未失效')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载更新' })).toBeInTheDocument();
  });

  it('已是最新时不显示下载按钮', async () => {
    render(
      <UpdateCard
        currentVersion="2026.7.27"
        backend={backend({ check: async () => ({ available: false }) })}
      />,
    );
    await waitFor(() => expect(screen.getByText('已是最新版本')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '下载更新' })).toBeNull();
  });

  it('下载完成后才出现重启入口', async () => {
    render(<UpdateCard currentVersion="2026.7.27" backend={backend()} />);
    await waitFor(() => screen.getByRole('button', { name: '下载更新' }));
    expect(screen.queryByRole('button', { name: '重启并安装' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重启并安装' })).toBeInTheDocument(),
    );
  });

  it('重启会真的调用后端', async () => {
    const installAndRestart = vi.fn(async () => {});
    render(<UpdateCard currentVersion="2026.7.27" backend={backend({ installAndRestart })} />);
    await waitFor(() => screen.getByRole('button', { name: '下载更新' }));
    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    await waitFor(() => screen.getByRole('button', { name: '重启并安装' }));
    fireEvent.click(screen.getByRole('button', { name: '重启并安装' }));
    await waitFor(() => expect(installAndRestart).toHaveBeenCalledOnce());
  });

  it('检查失败给出可读原因，且仍能再试', async () => {
    render(
      <UpdateCard
        currentVersion="2026.7.27"
        backend={backend({
          check: async () => {
            throw new Error('无法连接 github.com');
          },
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText(/无法连接 github\.com/u)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled();
  });

  it('开发构建不去查更新', async () => {
    const check = vi.fn(async () => ({ available: false }));
    render(<UpdateCard currentVersion="dev" backend={backend({ check })} />);
    await waitFor(() => expect(screen.getByText('尚未检查更新')).toBeInTheDocument());
    expect(check).not.toHaveBeenCalled();
  });
});
