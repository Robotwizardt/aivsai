import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ErrorBox, formatTime } from '../components';
import * as api from '../api';
import type { AdminEntrantDetail } from '../api';
import type { CredentialBundle } from '../types';

/**
 * 管理入口：输入管理员密钥（服务器启动时的 ADMIN_KEY，独立于工作台凭证体系）。
 * 密钥仅存 sessionStorage（关浏览器即失效）。
 *
 * 功能：平台概览（含对局统计）、邀请码发放/随机生成/撤销、
 * 工作台明细（完整 ID/恢复码查看复制、重置凭证、参赛对象明细含归档）。
 * 找回账户流程：管理员查看恢复码 → 转交用户自助恢复（#/recover）；
 * 连恢复码也丢（或存量旧码无明文）→ 管理员重置凭证，新凭据一次性返回转交。
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

  if (!authed) {
    return (
      <div className="panel">
        <h2>管理员登录</h2>
        <p className="muted">
          管理员密钥由平台所有者在服务器启动时设置（环境变量 <span className="mono">ADMIN_KEY</span>），
          与工作台凭证、参赛对象凭证互不相通。密钥只保存在当前浏览器会话中，关闭浏览器即失效。
        </p>
        <form className="admin-login-form" onSubmit={onLogin}>
          <label className="field">
            管理员密钥
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="ADMIN_KEY"
              autoComplete="off"
            />
          </label>
          <div>
            <button className="primary" type="submit">
              登录
            </button>
          </div>
        </form>
        {error != null && <ErrorBox error={error} />}
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
            <div className="stat-value">{stats ? stats.workspaces.length : '…'}</div>
            <div className="stat-label">工作台</div>
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
        <p className="admin-logout">
          <button type="button" className="ghost" onClick={onLogout}>
            退出管理
          </button>
        </p>
        {error != null && <ErrorBox error={error} />}
      </div>

      <div className="panel">
        <h3>发放邀请码</h3>
        <p className="muted">邀请码一次性使用：兑换即作废，每个邀请码创建一个私密工作台。</p>
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
        <h3>工作台</h3>
        {stats == null ? (
          <p className="muted">加载中…</p>
        ) : stats.workspaces.length === 0 ? (
          <p className="muted">还没有工作台兑换过邀请码。</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>昵称</th>
                  <th>工作台 ID</th>
                  <th>创建时间</th>
                  <th>参赛对象</th>
                  <th>策略版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {stats.workspaces.map((w) => (
                  <WorkspaceRow key={w.id} workspace={w} onError={setError} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ marginTop: 10 }}>
          「查看恢复码」复制转交给用户，用户在<a href="#/recover">恢复凭证页</a>凭工作台 ID + 恢复码自助重置；
          连恢复码也丢失时用「重置凭证」，新凭据一次性生成，请直接转交。
        </p>
      </div>
    </>
  );
}

/** 凭据展示行：标签 + 明文 + 复制按钮（重置凭证后的三段凭据展示共用）。 */
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

/** 工作台行：完整 ID / 恢复码查看复制、重置凭证、展开参赛对象明细。 */
function WorkspaceRow({
  workspace,
  onError,
}: {
  workspace: {
    id: string;
    nickname: string | null;
    createdAt: number;
    entrantCount: number;
    archivedEntrantCount: number;
    strategyCount: number;
  };
  onError: (err: unknown) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [showFullId, setShowFullId] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null | undefined>(undefined);
  const [resetBundle, setResetBundle] = useState<CredentialBundle | null>(null);
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
      const res = await api.getWorkspaceRecoveryCode(workspace.id);
      setRecoveryCode(res.recoveryCode);
      if (res.recoveryCode) await copy('恢复码', res.recoveryCode);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onResetCredential = async () => {
    if (
      !window.confirm(
        `确定重置「${workspace.nickname ?? workspace.id.slice(0, 8)}…」的凭证？\n` +
          '旧凭证、旧恢复码与该工作台全部对象凭证将立即作废，新凭据只显示一次。',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const bundle = await api.adminResetWorkspaceCredential(workspace.id);
      setResetBundle(bundle);
      setRecoveryCode(bundle.recoveryCode);
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
        const res = await api.listWorkspaceEntrants(workspace.id);
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
        <td>{workspace.nickname ?? <span className="muted">（未命名）</span>}</td>
        <td className="mono">
          {showFullId ? (
            workspace.id
          ) : (
            <span title={workspace.id}>{workspace.id.slice(0, 8)}…</span>
          )}
        </td>
        <td>{formatTime(workspace.createdAt)}</td>
        <td>
          {workspace.entrantCount}
          {workspace.archivedEntrantCount > 0 && (
            <span className="muted">（已归档 {workspace.archivedEntrantCount}）</span>
          )}
        </td>
        <td>{workspace.strategyCount}</td>
        <td>
          <div className="admin-row-actions">
            <button
              type="button"
              className="link"
              onClick={() => {
                setShowFullId((v) => !v);
                if (!showFullId) void copy('工作台 ID', workspace.id);
              }}
            >
              {showFullId ? '收起 ID' : '完整 ID'}
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void onShowRecoveryCode()}
            >
              {recoveryCode === undefined ? '查看恢复码' : '复制恢复码'}
            </button>
            <button type="button" className="link danger-link" disabled={busy} onClick={() => void onResetCredential()}>
              重置凭证
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => void onToggleEntrants()}>
              {entrantsOpen ? '收起明细' : '参赛对象详情'}
            </button>
          </div>
        </td>
      </tr>
      {copied && (
        <tr className="admin-detail-row">
          <td colSpan={6}>
            <span className="message ok" style={{ display: 'inline-block', padding: '6px 12px' }}>
              {copied}
            </span>
          </td>
        </tr>
      )}
      {recoveryCode !== undefined && (
        <tr className="admin-detail-row">
          <td colSpan={6}>
            {recoveryCode === null ? (
              <span className="muted">
                该工作台的恢复码创建于明文存库之前，查不到明文；请点「重置凭证」生成新凭据。
              </span>
            ) : (
              <span className="mono admin-secret">
                恢复码：<span className="admin-secret-value">{recoveryCode}</span>
                <button type="button" className="link" onClick={() => void copy('恢复码', recoveryCode)}>
                  复制
                </button>
                <span className="small muted">（转交给用户，在「恢复凭证」页使用）</span>
              </span>
            )}
          </td>
        </tr>
      )}
      {resetBundle && (
        <tr className="admin-detail-row">
          <td colSpan={6}>
            <div className="message ok" style={{ padding: '10px 14px' }}>
              <strong>凭证已重置，请把以下凭据转交给用户（只显示一次）：</strong>
              <div style={{ marginTop: 6 }}>
                <CopyField label="工作台 ID" value={resetBundle.workspaceId} />
                <CopyField label="工作台凭证" value={resetBundle.credential} />
                <CopyField label="恢复码" value={resetBundle.recoveryCode} />
              </div>
            </div>
          </td>
        </tr>
      )}
      {entrantsOpen && entrants && (
        <tr className="admin-detail-row">
          <td colSpan={6}>
            {entrants.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                该工作台还没有参赛对象。
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
