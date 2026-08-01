import { useEffect, useRef, useState } from 'react';
import { REPORT_ARTIFACT_NAME, parseRunReport, type RunReport } from '@aiwf/contracts';

import { coreClient } from '../data/workspace.js';
import { describeError } from '../data/describeError.js';
import { CopyButton } from '../layout/CopyButton.js';
import { ReportView } from './ReportView.js';

/**
 * 运行报告抽屉。
 *
 * ## 为什么是抽屉而不是产物列表里的一块
 *
 * 产物预览是列表项底下 `max-height: 320px` 的一小格 —— 那个尺寸是给
 * 「扫一眼 stdout」用的。而报告是这次运行**给人看的成品**：
 * 指标、表格、时间线摆在 320px 里没法读。
 *
 * 所以给它整块屏：右侧 72% 宽（最小 720px），从上到下自己滚。
 * 主管 AI 抽屉是 468px 固定宽，那是对话；报告是要被读的文档，不一样。
 *
 * ## 一条工作流有多个 run 时
 *
 * 每个 run 一份报告，抽屉顶部显示这是哪一次运行（时间 + run id）。
 * 并排比较两次运行属于另一件事（要先有「选中多条」的交互），
 * 不在这一版里假装支持。
 */
export function ReportDrawer({
  runId,
  runLabel,
  onClose,
}: {
  runId: string;
  /** 「哪一次运行」—— 同一条工作流可能有好几个 run 同时在跑。 */
  runLabel: string;
  onClose: () => void;
}) {
  const [report, setReport] = useState<RunReport | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);
    setRaw(null);

    void (async () => {
      try {
        const artifacts = (await coreClient.call('run.artifacts', { runId })) as {
          items: { relPath: string; name: string }[];
        };
        const found = artifacts.items.find((item) => item.name === REPORT_ARTIFACT_NAME);
        if (!found) {
          if (!cancelled) {
            setError('这次运行没有产出报告。');
            setLoading(false);
          }
          return;
        }

        const content = (await coreClient.call('run.artifactContent', {
          runId,
          path: found.relPath,
          // 报告可能有几十 KB —— 默认 64KB 够，但截断的报告读起来是断的
          maxBytes: 512_000,
        })) as { text?: string; truncated: boolean };

        if (cancelled) return;
        const text = content.text ?? '';
        setRaw(text);
        try {
          setReport(parseRunReport(JSON.parse(text)));
        } catch {
          // 解析失败不抛：一份坏报告不该让这个抽屉打不开，
          // 下面会把原文显示出来让用户自己看
          setReport(null);
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(describeError(err));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Esc 关闭 —— 与应用里其余浮层一致
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="report-drawer__backdrop"
      /* 点遮罩关闭。报告是只读的，不像对话框那样有「正打着一半的输入」*/
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="report-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`运行报告：${runLabel}`}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="report-drawer__head">
          <div className="report-drawer__head-text">
            <p className="runs__label">运行报告</p>
            {/* 同一条工作流可能有好几个 run 在跑 —— 说清这是哪一次 */}
            <p className="report-drawer__run">{runLabel}</p>
          </div>
          <span className="runs__grow" />
          <CopyButton value={runId} label="复制 Run ID" className="runs__action" />
          <button type="button" className="runs__action" aria-label="关闭报告" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="report-drawer__body">
          {loading ? <p className="runs__empty">正在读取报告…</p> : null}

          {error ? (
            <p className="runs__empty">
              {error}
              {/* 说清报告是怎么来的 —— 用户下次想要就知道该怎么配 */}
              <br />
              报告由工作流里的 AI 节点产出，写成产物 <code>{REPORT_ARTIFACT_NAME}</code>。
            </p>
          ) : null}

          {report ? <ReportView report={report} /> : null}

          {!loading && !error && !report && raw !== null ? (
            <>
              <p className="runs__empty">
                这份 <code>{REPORT_ARTIFACT_NAME}</code> 不合报告格式，下面是原文。
              </p>
              <pre className="report-drawer__raw">{raw}</pre>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
