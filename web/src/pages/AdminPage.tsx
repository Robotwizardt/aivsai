import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ErrorBox, formatTime } from '../components';
import * as api from '../api';
import type { AdminEntrantDetail, AdminUserDetail } from '../api';

/**
 * 管理入口（ADR 0015）：admin 角色的登录会话直接使用管理 API，无需单独密钥。
 * 非管理员（或未登录）访问管理路由一律 401。
 *
 * 功能：平台概览（含对局统计）、邀请码发放/随机生成/撤销、
 * 用户明细（恢复码查看复制、兜底重置、角色升降、封禁/解封、参赛对象明细含归档）。
 * 找回账户流程：管理员查看恢复码 → 转交用户自助重置密码（#/recover）；
 * 连恢复码也丢 → 管理员重置，新密码/恢复码一次性返回转交。
 */
export function AdminPage(): JSX.Element {
  const [stats, setStats] = useState<api.AdminStats | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 非 admin（或未登录）访问：提示后不渲染管理界面
  const [forbidden, setForbidden] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.getAdminStats(), api.listPendingInviteCodes()]);
      setStats(s);
      setCodes(c.codes);
      setForbidden(false);
      setError(null);
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) {
        setForbidden(true);
      } else {
        setError(err);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const onRevokeCode = async (code: string) => {
    if (!window.confirm(`确定撤销邀请码 ${code}？撤销后不可恢复。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.revokeInviteCode(code);
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

  if (forbidden) {
    return (
      <div className="panel">
        <h2>管理</h2>
        <p className="muted">
          需要管理员账号。请先<a href="#/login">登录</a>管理员账号后刷新本页。
        </p>
      </div>
    );
  }

  const ms = stats?.matchStats;

  return (
    <>
      <div className="panel">
        <h2>平台概览</h2>
        <div className="card-grid">
          <div className="game-card stat-card">
            <div className="stat-value">{stats ? stats.users.length : '…'}</div>
            <div className="stat-label">用户</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">{stats ? stats.pendingInviteCodes : '…'}</div>
            <div className="stat-label">未兑换邀请码</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">{stats ? stats.consumedInviteCodes : '…'}</div>
            <div className="stat-label">已兑换邀请码</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">
              {stats ? `${stats.entrantCount} / ${stats.archivedEntrantCount}` : '…'}
            </div>
            <div className="stat-label">参赛对象（在役 / 已归档）</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">{stats ? stats.strategyVersions : '…'}</div>
            <div className="stat-label">策略版本总数</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">{ms ? ms.total : '…'}</div>
            <div className="stat-label">对局总数</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">{ms ? ms.live : '…'}</div>
            <div className="stat-label">进行中对局</div>
          </div>
          <div className="game-card stat-card">
            <div className="stat-value">{ms ? `${ms.official} / ${ms.training}` : '…'}</div>
            <div className="stat-label">对局（正式 / 训练）</div>
          </div>
        </div>
        {error != null && <ErrorBox error={error} />}
      </div>

      <div className="panel">
        <h3>发放邀请码</h3>
        <p className="muted">邀请码一次性使用：注册即作废，每个邀请码创建一个账号。</p>
        <form className="admin-code-form" onSubmit={onCreateCode}>
          <label className="field">
            邀请码
            <input
              type="text"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="例如 AI-A2B3-C4D5"
              className="mono"
            />
          </label>
          <button type="button" className="ghost" onClick={suggestCode}>
            随机生成
          </button>
          <button className="primary" type="submit" disabled={busy || !newCode.trim()}>
            {busy ? '发放中…' : '发放'}
          </button>
        </form>
        {codes != null && codes.length > 0 && (
          <div>
            <h3>未兑换邀请码</h3>
            <ul className="admin-code-list">
              {codes.map((c) => (
                <li key={c} className="mono admin-code-item">
                  <span>{c}</span>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy}
                    onClick={() => void onRevokeCode(c)}
                  >
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>用户</h3>
        {stats == null ? (
          <p className="muted">加载中…</p>
        ) : stats.users.length === 0 ? (
          <p className="muted">还没有用户注册。</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>昵称 / 用户名</th>
                  <th>注册时间</th>
                  <th>参赛对象</th>
                  <th>策略版本</th>
                  <th>会话</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {stats.users.map((u) => (
                  <UserRow key={u.id} user={u} onError={setError} onChanged={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginTop: 10 }}>
          「查看恢复码」复制转交给用户，用户在<a href="#/recover">重置密码页</a>凭用户名 + 恢复码自助重置；
          连恢复码也丢失时用「重置密码」，新凭据一次性生成，请直接转交。
        </p>
      </div>
    </>
  );
}

/** 凭据展示行：标签 + 明文 + 复制按钮（重置后的凭据展示共用）。 */
function CopyField({ label, value }: { label: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <p className="mono" style={{ margin: '2px 0' }}>
      {label}：{value}
      <button
        type="button"
        className="link"
        onClick={async () => {
          const ok = await api.copyTextToClipboard(value);
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 2500);
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </p>
  );
}

/** 用户行：恢复码查看复制、兜底重置密码、角色升降、封禁/解封、展开参赛对象明细。 */
function UserRow({
  user,
  onError,
  onChanged,
}: {
  user: AdminUserDetail;
  onError: (err: unknown) => void;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null | undefined>(undefined);
  const [resetResult, setResetResult] = useState<{ newPassword: string; recoveryCode: string } | null>(
    null,
  );
  const [entrants, setEntrants] = useState<AdminEntrantDetail[] | null>(null);
  const [entrantsOpen, setEntrantsOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, text: string) => {
    const ok = await api.copyTextToClipboard(text);
    setCopied(ok ? `${label}已复制` : `${label}复制失败，请手动复制`);
    setTimeout(() => setCopied(null), 2500);
  };

  const onShowRecoveryCode = async () => {
    // 已加载过：直接复制当前明文
    if (recoveryCode !== undefined) {
      if (recoveryCode) await copy('恢复码', recoveryCode);
      return;
    }
    setBusy(true);
    try {
      const res = await api.getUserRecoveryCode(user.id);
      setRecoveryCode(res.recoveryCode);
      if (res.recoveryCode) await copy('恢复码', res.recoveryCode);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onResetPassword = async () => {
    if (
      !window.confirm(
        `确定重置「${user.nickname ?? user.username}」的密码？\n` +
          '旧密码、旧恢复码与该用户全部会话将立即作废，新密码/恢复码只显示一次。',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await api.adminResetUserPassword(user.id);
      setResetResult(res);
      setRecoveryCode(res.recoveryCode);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onSetRole = async () => {
    const next = user.role === 'admin' ? 'user' : 'admin';
    if (!window.confirm(`确定将「${user.username}」${next === 'admin' ? '提升为' : '降级为'} ${next}？`)) {
      return;
    }
    setBusy(true);
    try {
      await api.setUserRole(user.id, next);
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onSetBanned = async () => {
    const next = !user.banned;
    if (
      !window.confirm(
        next
          ? `确定封禁「${user.username}」？封禁后无法登录，数据保留。`
          : `确定解封「${user.username}」？`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.setUserBanned(user.id, next);
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onToggleEntrants = async () => {
    if (!entrantsOpen && entrants === null) {
      setBusy(true);
      try {
        const res = await api.listUserEntrants(user.id);
        setEntrants(res.entrants);
      } catch (err) {
        onError(err);
        return;
      } finally {
        setBusy(false);
      }
    }
    setEntrantsOpen((o) => !o);
  };

  return (
    <>
      <tr>
        <td>
          {user.nickname ?? <span className="muted">（未设置昵称）</span>}
          <div className="small muted mono">@{user.username}</div>
        </td>
        <td>{formatTime(user.createdAt)}</td>
        <td>
          {user.entrantCount}
          {user.archivedEntrantCount > 0 && (
            <span className="muted">（已归档 {user.archivedEntrantCount}）</span>
          )}
        </td>
        <td>{user.strategyCount}</td>
        <td>{user.sessionCount}</td>
        <td>
          {user.banned ? (
            <span className="tag banned">已封禁</span>
          ) : user.role === 'admin' ? (
            <span className="tag admin">admin</span>
          ) : (
            <span className="muted">正常</span>
          )}
        </td>
        <td>
          <div className="admin-row-actions">
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void onShowRecoveryCode()}
            >
              {recoveryCode === undefined ? '查看恢复码' : '复制恢复码'}
            </button>
            <button type="button" className="link danger-link" disabled={busy} onClick={() => void onResetPassword()}>
              重置密码
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => void onSetRole()}>
              {user.role === 'admin' ? '降为用户' : '提升为 admin'}
            </button>
            <button type="button" className="link danger-link" disabled={busy} onClick={() => void onSetBanned()}>
              {user.banned ? '解封' : '封禁'}
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => void onToggleEntrants()}>
              {entrantsOpen ? '收起明细' : '参赛对象详情'}
            </button>
          </div>
        </td>
      </tr>
      {copied && (
        <tr className="admin-detail-row">
          <td colSpan={7}>
            <span className="message ok" style={{ display: 'inline-block', padding: '6px 12px' }}>
              {copied}
            </span>
          </td>
        </tr>
      )}
      {recoveryCode !== undefined && (
        <tr className="admin-detail-row">
          <td colSpan={7}>
            {recoveryCode === null ? (
              <span className="muted">该用户没有恢复码（异常，请点「重置密码」生成新凭据）。</span>
            ) : (
              <span className="mono admin-secret">
                恢复码：<span className="admin-secret-value">{recoveryCode}</span>
                <button type="button" className="link" onClick={() => void copy('恢复码', recoveryCode)}>
                  复制
                </button>
                <span className="small muted">（转交给用户，在「重置密码」页使用）</span>
              </span>
            )}
          </td>
        </tr>
      )}
      {resetResult && (
        <tr className="admin-detail-row">
          <td colSpan={7}>
            <div className="message ok" style={{ padding: '10px 14px' }}>
              <strong>密码已重置，请把以下凭据转交给用户（只显示一次）：</strong>
              <div style={{ marginTop: 6 }}>
                <CopyField label="用户名" value={user.username} />
                <CopyField label="新密码" value={resetResult.newPassword} />
                <CopyField label="恢复码" value={resetResult.recoveryCode} />
              </div>
            </div>
          </td>
        </tr>
      )}
      {entrantsOpen && entrants && (
        <tr className="admin-detail-row">
          <td colSpan={7}>
            {entrants.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                该用户还没有参赛对象。
              </p>
            ) : (
              <table className="data admin-entrant-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>游戏</th>
                    <th>创建时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {entrants.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <span
                          className="entrant-color-dot"
                          style={{ background: e.appearance.color }}
                        />{' '}
                        {e.name}
                      </td>
                      <td>{e.gameId}</td>
                      <td>{formatTime(e.createdAt)}</td>
                      <td>
                        {e.archivedAt ? (
                          <span className="muted">已归档（{formatTime(e.archivedAt)}）</span>
                        ) : (
                          '在役'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
