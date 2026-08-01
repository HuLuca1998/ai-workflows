import { useState } from 'react';
import { coreClient } from '../data/workspace.js';
import { describeError } from '../data/describeError.js';

/**
 * 「安全与隐私」这一档的隐私那一半。
 *
 * 在此之前这一档里**只有**一张「谁来审批」单选卡 —— 而那张卡在
 * 「首次配置」和「运行环境与工具」里各还有一份逐字相同的拷贝，
 * 隐私相关内容一个字都没有（第三方巡检 A-05）。
 *
 * 下面每一条都对应仓库里真实存在的机制，不是承诺：
 *
 * - 存储层拒收明文凭据（`crates/store/src/lib.rs` 的
 *   「凭据必须是 keychain:// 引用」）
 * - 事件写入前过脱敏器（`runner.rs` 的 `emit_full`）
 * - 运行输入落库前脱敏（`store` 的 `redact_inputs`）
 * - 读取时再兜一道（事件、产物预览、主管 AI 会话）—— 脱敏规则会补新形态，
 *   而规则加进来之前写下的历史数据仍带明文
 *
 * 写在界面上是因为用户有权知道自己的数据被怎么处理，
 * 而这些保证目前只存在于源码注释与文档里。
 */
export function PrivacyPanel() {
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportDiagnostics = async () => {
    setError(null);
    try {
      const result = (await coreClient.call('env.diagnostics', {})) as { path: string };
      setPath(result.path);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section className="privacy" aria-label="隐私与数据">
      <h5 className="permission__title">你的数据去哪了</h5>

      <ul className="privacy__list">
        <li>
          <strong>Secret 只进 Keychain。</strong>
          登记模型时的凭据一栏只收 <code>keychain://</code> 引用 ——
          填明文会被存储层当场拒掉。仓库、事件流、日志、导出物里出现的
          永远是那个引用，不是密钥本身。
        </li>
        <li>
          <strong>事件写入前过脱敏器。</strong>
          节点摘要、运行输入在落库那一刻就被脱敏；读取时再兜一道 —— 脱敏规则会补新形态（比如{' '}
          <code>sec-</code> 前缀是后加的）， 而规则加进来之前写下的历史数据仍带着明文。
        </li>
        <li>
          <strong>界面不提供绕过查看。</strong>
          产物预览与主管 AI 的历史会话同样过脱敏。磁盘上的原始文件不动 ——
          那是脚本的真实输出，要调试就去工作目录看，路径在运行详情页显示着。
        </li>
        <li>
          <strong>不上传任何东西。</strong>
          运行记录、产物、日志都写在你选的工作目录里。AI 调用走本机装的 ACP
          adapter（它自己管登录态），这个应用不额外发送遥测。
        </li>
      </ul>

      <p className="models__note">
        要把现场发给别人看时用下面这个 —— 它走的是同一条脱敏管道，
        比手工整理可靠（手工整理必然会漏掉某处的 token）。
      </p>

      {error ? (
        <p className="runs__error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="button" className="runs__action" onClick={() => void exportDiagnostics()}>
        导出脱敏诊断报告
      </button>

      {path ? (
        <p className="onboarding__diagnostics" role="status">
          <i className="ph ph-file-text" aria-hidden="true" />
          已导出到 <code>{path}</code>
        </p>
      ) : null}
    </section>
  );
}
