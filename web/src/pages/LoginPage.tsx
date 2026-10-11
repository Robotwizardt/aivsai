import { FormEvent, useState } from 'react';
import { ErrorBox } from '../components';
import * as api from '../api';
import { href } from '../router';

/** 登录页：用户名 + 密码 → 会话令牌（ADR 0015）。 */
export function LoginPage(): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      window.location.hash = '#/workspace';
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
        <h2>登录</h2>
        <p className="small muted">输入用户名与密码登录平台。没有账号？<a href={href('/register')}>注册</a>（需要邀请码）。</p>
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
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              autoComplete="current-password"
              required
            />
          </label>
          <div>
            <button
              className="primary"
              type="submit"
              disabled={busy || username.trim() === '' || password === ''}
            >
              {busy ? '登录中…' : '登录'}
            </button>
          </div>
        </form>
        {error != null && <ErrorBox error={error} />}
        <p className="small muted" style={{ marginTop: 12 }}>
          忘记密码？<a href={href('/recover')}>用恢复码重置</a>。
        </p>
      </div>
    </>
  );
}
