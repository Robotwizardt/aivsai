import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ErrorBox, formatTime } from '../components';
import * as api from '../api';

/**
 * 管理入口：输入管理员密钥（服务器启动时的 ADMIN_KEY，独立于工作台凭证体系）。
 * 密钥仅存 sessionStorage（关浏览器即失效），可发放邀请码、查看平台概览。
 */
export function AdminPage(): JSX.Element {
  const [keyInput, setKeyInput] = useState(api.getAdminKey() ?? '');
  const [authed, setAuthed] = useState(api.getAdminKey() !== null);

  const [stats, setStats] = useState<api.AdminStats | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!api.getAdminKey()) return;
    try {
      const [s, c] = await Promise.all([api.getAdminStats(), api.listPendingInviteCodes()]);
      setStats(s);
      setCodes(c.codes);
      setAuthed(true);
      setError(null);
    } catch (err) {
      setError(err);
      // 密钥失效（401）时回到未登录态
      if (err instanceof api.ApiError && err.status === 401) {
        api.clearAdminKey();
        setAuthed(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    const key = keyInput.trim();
    if (!key) return;
    api.saveAdminKey(key);
    await refresh();
  };

  const onLogout = () => {
    api.clearAdminKey();
    setAuthed(false);
    setStats(null);
    setCodes(null);
    setKeyInput('');
  };

  const onCreateCode = async (e: FormEvent) => {
    e.preventDefault();
    const code = newCode.trim();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      await api.createInviteCode(code);
      setNewCode('');
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // 随机生成一个易抄写的邀请码（前后缀各 4 位）
  const suggestCode = () => {
    const rand = () =>
      Array.from({ length: 4 }, () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        return chars[Math.floor(Math.random() * chars.length)];
      }).join('');
    setNewCode(`AI-${rand()}-${rand()}`);
  };

  if (!authed) {
    return (
      <div className="panel">
        <h2>管理员登录</h2>
        <p className="muted">
          管理员密钥由平台所有者在服务器启动时设置（环境变量 <span className="mono">ADMIN_KEY</span>），
          与工作台凭证、参赛对象凭证互不相通。密钥只保存在当前浏览器会话中，关闭浏览器即失效。
        </p>
        <form onSubmit={onLogin}>
          <label>
            管理员密钥
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="ADMIN_KEY"
              autoComplete="off"
            />
          </label>
          <button className="primary" type="submit">
            登录
          </button>
        </form>
        {error != null && <ErrorBox error={error} />}
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <h2>
          平台概览{' '}
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            （数据为内存态，重启即清空）
          </span>
        </h2>
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div className="game-card">
            <div className="game-name">{stats ? stats.workspaces.length : '…'}</div>
            <div className="game-meta">工作台</div>
          </div>
          <div className="game-card">
            <div className="game-name">{stats ? stats.pendingInviteCodes : '…'}</div>
            <div className="game-meta">未兑换邀请码</div>
          </div>
          <div className="game-card">
            <div className="game-name">{stats ? stats.consumedInviteCodes : '…'}</div>
            <div className="game-meta">已兑换邀请码</div>
          </div>
          <div className="game-card">
            <div className="game-name">{stats ? stats.strategyVersions : '…'}</div>
            <div className="game-meta">策略版本总数</div>
          </div>
        </div>
        <p>
          <button type="button" onClick={onLogout} style={{ marginTop: '0.5rem' }}>
            退出管理
          </button>
        </p>
        {error != null && <ErrorBox error={error} />}
      </div>

      <div className="panel">
        <h3>发放邀请码</h3>
        <p className="muted">邀请码一次性使用：兑换即作废，每个邀请码创建一个私密工作台。</p>
        <form onSubmit={onCreateCode} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ flex: 1, minWidth: '220px' }}>
            邀请码
            <input
              type="text"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="例如 AI-A2B3-C4D5"
              className="mono"
            />
          </label>
          <button type="button" onClick={suggestCode}>
            随机生成
          </button>
          <button className="primary" type="submit" disabled={busy || !newCode.trim()}>
            {busy ? '发放中…' : '发放'}
          </button>
        </form>
        {codes != null && codes.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <h3>未兑换邀请码</h3>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {codes.map((c) => (
                <li key={c} className="mono">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>工作台</h3>
        {stats == null ? (
          <p className="muted">加载中…</p>
        ) : stats.workspaces.length === 0 ? (
          <p className="muted">还没有工作台兑换过邀请码。</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th>昵称</th>
                <th>工作台 ID</th>
                <th>创建时间</th>
                <th>参赛对象</th>
                <th>策略版本</th>
              </tr>
            </thead>
            <tbody>
              {stats.workspaces.map((w) => (
                <tr key={w.id}>
                  <td>{w.nickname ?? <span className="muted">（未命名）</span>}</td>
                  <td className="mono" title={w.id}>
                    {w.id.slice(0, 8)}…
                  </td>
                  <td>{formatTime(w.createdAt)}</td>
                  <td>{w.entrantCount}</td>
                  <td>{w.strategyCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
