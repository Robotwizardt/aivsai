import { FormEvent, useState } from 'react';
import { ErrorBox } from '../components';
import * as api from '../api';
import { href } from '../router';
import { CredentialBundle } from '../types';

/** 恢复凭证入口：输入工作台 ID + 恢复码 → 重置凭证。 */
export function RecoverPage(): JSX.Element {
  const [workspaceId, setWorkspaceId] = useState(api.getWorkspaceId() ?? '');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [bundle, setBundle] = useState<CredentialBundle | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const b = await api.resetCredential(workspaceId.trim(), recoveryCode.trim());
      api.saveCredential(b);
      setBundle(b);
      setRecoveryCode('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <a className="back-link" href={href('/')}>
        ← 返回首页
      </a>
      <div className="panel">
        <h2>恢复凭证</h2>
        <p className="small muted">
          用创建工作台时提供的恢复码更换工作台凭证。恢复后旧凭证、旧恢复码与该工作台全部对象凭证一并作废，将生成新的恢复码。
        </p>
        {bundle ? (
          <div className="message ok">
            <p style={{ margin: '0 0 8px' }}>
              <strong>凭证已重置。</strong>请保存新凭据（只显示这一次）：
            </p>
            <p className="mono" style={{ margin: '0 0 4px' }}>
              工作台凭证：{bundle.credential}
            </p>
            <p className="mono" style={{ margin: '0 0 8px' }}>
              新恢复码：{bundle.recoveryCode}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              新凭证已自动存入本浏览器。<a href={href('/workspace')}>前往我的工作台 →</a>
            </p>
          </div>
        ) : (
          <form className="stack" onSubmit={onSubmit}>
            <label className="field">
              工作台 ID
              <input
                type="text"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="workspaceId（UUID）"
                required
              />
            </label>
            <label className="field">
              恢复码
              <input
                type="password"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="创建工作台时提供的恢复码"
                required
              />
            </label>
            <div>
              <button
                className="primary"
                type="submit"
                disabled={busy || workspaceId.trim() === '' || recoveryCode.trim() === ''}
              >
                {busy ? '重置中…' : '重置凭证'}
              </button>
            </div>
          </form>
        )}
        {error != null && <ErrorBox error={error} />}
      </div>
    </>
  );
}
