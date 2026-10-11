import { FormEvent, useState } from 'react';
import { ErrorBox } from '../components';
import * as api from '../api';
import { href } from '../router';

/** 密码找回：用户名 + 恢复码 + 新密码（ADR 0015）。 */
export function RecoverPage(): JSX.Element {
  const [username, setUsername] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword({
        username: username.trim(),
        recoveryCode: recoveryCode.trim(),
        newPassword,
      });
      setDone(true);
      setRecoveryCode('');
      setNewPassword('');
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
        <h2>重置密码</h2>
        <p className="small muted">
          用注册时显示的恢复码重置密码。重置后该账号所有会话吊销、恢复码轮换；新恢复码请联系管理员获取。
        </p>
        {done ? (
          <div className="message ok">
            <p style={{ margin: '0 0 8px' }}>
              <strong>密码已重置。</strong>所有旧会话已吊销，请用新密码重新登录。
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              <a href={href('/login')}>前往登录 →</a>
            </p>
          </div>
        ) : (
          <form className="stack" onSubmit={onSubmit}>
            <label className="field">
              用户名
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="用户名"
                autoComplete="username"
                required
              />
            </label>
            <label className="field">
              恢复码
              <input
                type="password"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="注册时显示的恢复码"
                required
              />
            </label>
            <label className="field">
              新密码
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 6 位"
                minLength={6}
                autoComplete="new-password"
                required
              />
            </label>
            <div>
              <button
                className="primary"
                type="submit"
                disabled={busy || username.trim() === '' || recoveryCode.trim() === '' || newPassword === ''}
              >
                {busy ? '重置中…' : '重置密码'}
              </button>
            </div>
          </form>
        )}
        {error != null && <ErrorBox error={error} />}
      </div>
    </>
  );
}
