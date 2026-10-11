import { FormEvent, useState } from 'react';
import { CopyButton, ErrorBox } from '../components';
import * as api from '../api';
import { href } from '../router';
import { RegisterResult } from '../types';

/**
 * 注册页：邀请码 + 用户名 + 密码（+ 可选昵称）→ 创建账号（ADR 0015）。
 * 注册成功一次性显示恢复码——只此一次，服务端只存哈希。
 */
export function RegisterPage(): JSX.Element {
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<RegisterResult | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.register({
        inviteCode: inviteCode.trim(),
        username: username.trim(),
        password,
        ...(nickname.trim() !== '' ? { nickname: nickname.trim() } : {}),
      });
      setResult(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <>
        <a className="back-link" href={href('/')}>
          ← 返回首页
        </a>
        <div className="panel">
          <h2>注册成功</h2>
          <div className="message ok">
            <p style={{ margin: '0 0 8px' }}>
              <strong>账号已创建。</strong>请保存恢复码（只显示这一次，丢失后需管理员重置）：
            </p>
            <p className="mono" style={{ margin: '0 0 8px' }}>
              恢复码：{result.recoveryCode} <CopyButton text={result.recoveryCode} />
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              <a href={href('/login')}>前往登录 →</a>
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <a className="back-link" href={href('/')}>
        ← 返回首页
      </a>
      <div className="panel">
        <h2>注册</h2>
        <p className="small muted">
          需要邀请码（向管理员索取）。注册成功后凭用户名密码登录；已有账号？
          <a href={href('/login')}>直接登录</a>。
        </p>
        <form className="stack" onSubmit={onSubmit}>
          <label className="field">
            邀请码
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="邀请码（向管理员索取）"
              required
            />
          </label>
          <label className="field">
            用户名
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-32 个字符：字母、数字、下划线"
              pattern="[A-Za-z0-9_]{3,32}"
              title="3-32 位字母、数字或下划线"
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
              placeholder="至少 6 位"
              minLength={6}
              autoComplete="new-password"
              required
            />
          </label>
          <label className="field">
            昵称（可选）
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="展示用昵称，不填则用用户名"
            />
          </label>
          <div>
            <button
              className="primary"
              type="submit"
              disabled={busy || inviteCode.trim() === '' || username.trim() === '' || password === ''}
            >
              {busy ? '注册中…' : '注册'}
            </button>
          </div>
        </form>
        {error != null && <ErrorBox error={error} />}
      </div>
    </>
  );
}
