import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { href, navigate } from '../router';
import { CopyButton, ErrorBox, formatTime, Loading, useAsync } from '../components';
import { TankReplayPlayer } from '../components/TankReplayPlayer';
import { Entrant, MatchSummary, SimulateResult, StrategyVersion } from '../types';
import { DEFAULT_STRATEGY_TEMPLATE, STRATEGY_API_DOC } from '../strategy-doc';

const PRESETS = ['classic', 'scout', 'heavy'] as const;
const PRESET_COLORS: Record<string, string> = {
  classic: '#2563eb',
  scout: '#16a34a',
  heavy: '#92400e',
};

export function WorkspacePage(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entrants = useAsync(() => api.listMyEntrants(), [api.getCredential()]);

  if (api.getCredential() === null) {
    const notice = api.takeUnauthorizedNotice();
    return (
      <div className="panel">
        <h2>我的工作台</h2>
        {notice != null && <div className="message error">{notice}</div>}
        <p className="muted">
          尚未兑换工作台。请回到<a href={href('/')}>首页</a>输入邀请码，或用{' '}
          <a href={href('/recover')}>恢复码</a> 找回已有工作台。
        </p>
      </div>
    );
  }

  return (
    <div className="workspace-layout">
      <aside className="workspace-side">
      <div className="panel">
        <h2>我的参赛对象</h2>
        {entrants.loading && <Loading />}
        {entrants.error != null && <ErrorBox error={entrants.error} />}
        {entrants.data &&
          (entrants.data.length === 0 ? (
            <p className="muted">还没有参赛对象，先用下方表单创建一个。</p>
          ) : (
            <div className="entrant-list">
              {entrants.data.map((e) => (
                <div key={e.id} className={`entrant-item${selectedId === e.id ? ' selected' : ''}`}>
                  <button type="button" className="entrant-hit" onClick={() => setSelectedId(e.id)}>
                    <span className="entrant-swatch" style={{ background: e.appearance.color }} />
                    <span>
                      <div className="entrant-name">{e.name}</div>
                      <div className="entrant-meta">
                        {e.appearance.name} · {e.appearance.preset} · 游戏 {e.gameId} ·{' '}
                        <span className="mono">{e.id.slice(0, 8)}…</span>
                      </div>
                    </span>
                  </button>
                  <CopyButton text={e.id} label="复制 ID" />
                </div>
              ))}
            </div>
          ))}
      </div>

      <CreateEntrantForm
        gameIds={entrants.data ? [...new Set(entrants.data.map((e) => e.gameId))] : []}
        onCreated={(id) => {
          entrants.reload();
          setSelectedId(id);
        }}
      />
      </aside>
      <main className="workspace-main">
      {selectedId && entrants.data ? (
        <EntrantDetail
          entrant={entrants.data.find((e) => e.id === selectedId) ?? null}
          entrantId={selectedId}
          onDeleted={() => {
            entrants.reload();
            setSelectedId(null);
          }}
        />
      ) : (
        <div className="panel">
          <h2>选择一个参赛对象</h2>
          <p className="muted">点左侧列表中的参赛对象，在这里管理策略、发起对局、看历史。</p>
        </div>
      )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- 创建参赛对象

function CreateEntrantForm({
  gameIds,
  onCreated,
}: {
  gameIds: string[];
  onCreated: (entrantId: string) => void;
}): JSX.Element {
  const games = useAsync(() => api.listGames(), []);
  const gameIdOptions = games.data ? games.data.map((g) => g.id) : gameIds;

  const [gameId, setGameId] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<string>('classic');
  const [color, setColor] = useState<string>(PRESET_COLORS.classic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!gameId && gameIdOptions.length > 0) setGameId(gameIdOptions[0]);
  }, [gameId, gameIdOptions]);

  const onPresetChange = (p: string) => {
    setPreset(p);
    if (PRESET_COLORS[p]) setColor(PRESET_COLORS[p]);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createEntrant({
        gameId,
        name: name.trim(),
        appearance: { preset, color, name: name.trim() },
      });
      setName('');
      onCreated(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>创建参赛对象</h2>
      <form className="inline" onSubmit={onSubmit}>
        <label className="field">
          游戏
          <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
            {gameIdOptions.length === 0 && <option value="">（加载中）</option>}
            {gameIdOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          名称
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          外观预设
          <select value={preset} onChange={(e) => onPresetChange(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          颜色
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#2563eb'}
            onChange={(e) => setColor(e.target.value)}
            style={{ width: 48, height: 36, padding: 2 }}
          />
        </label>
        <div>
          <button className="primary" type="submit" disabled={busy || !gameId || name.trim() === ''}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
      {error != null && <ErrorBox error={error} />}
    </div>
  );
}

// ---------------------------------------------------------------- 参赛对象详情

/** 对象详情页签：把原来的五大面板分组，避免一页滚动到底。 */
type EntrantTab = 'match' | 'strategy' | 'sim' | 'history';

const ENTRANT_TABS: ReadonlyArray<{ id: EntrantTab; label: string }> = [
  { id: 'match', label: '发起对局' },
  { id: 'strategy', label: '策略' },
  { id: 'sim', label: '快速试跑' },
  { id: 'history', label: '对局历史' },
];

function EntrantDetail({
  entrant,
  entrantId,
  onDeleted,
}: {
  entrant: Entrant | null;
  entrantId: string;
  onDeleted: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<EntrantTab>('match');
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <div className="panel">
        <div className="entrant-head">
          <div>
            <h2>{entrant ? entrant.name : entrantId}</h2>
            {entrant && (
              <p className="small muted">
                游戏 {entrant.gameId} · 外观 {entrant.appearance.preset}（{entrant.appearance.name}）· 创建于{' '}
                {formatTime(entrant.createdAt)}
              </p>
            )}
            <p className="small" style={{ margin: '6px 0 0' }}>
              <span className="match-id">
                <span className="mono">
                  {entrant?.gameId === 'tank' ? '坦克 ID' : '参赛对象 ID'} {entrantId}
                </span>
                <CopyButton text={entrantId} label="复制 ID" />
              </span>
            </p>
          </div>
        </div>
        <div className="tab-bar" role="tablist">
          {ENTRANT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tab-btn${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'match' && <StartMatchPanel entrantId={entrantId} defaultGameId={entrant?.gameId ?? ''} />}
      {tab === 'strategy' && (
        <>
          <StrategyPanel entrantId={entrantId} />
          <DelegationPanel entrantId={entrantId} />
        </>
      )}
      {tab === 'sim' && <QuickSimPanel entrantId={entrantId} />}
      {tab === 'history' && <EntrantHistoryPanel entrantId={entrantId} />}
      <div className="panel danger-zone">
        <h2>删除参赛对象</h2>
        <p className="small muted">
          删除即归档，不可恢复。历史对局与回放会保留，但该对象将从列表、匹配池、排行榜移除，
          对象凭证也会被吊销。
        </p>
        <button type="button" className="btn danger" onClick={() => setConfirmOpen(true)}>
          删除参赛对象
        </button>
      </div>
      {confirmOpen && (
        <DeleteEntrantModal
          entrantId={entrantId}
          entrantName={entrant ? entrant.name : entrantId}
          onCancel={() => setConfirmOpen(false)}
          onDeleted={() => {
            setConfirmOpen(false);
            onDeleted();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- 删除参赛对象（二次确认）

/**
 * 应用内二次确认弹窗（复用 styles.css 的 .modal-backdrop/.modal/.modal-head）。
 * 确认后归档参赛对象：成功回调 onDeleted；失败把后端 error 文案展示在弹窗内。
 */
function DeleteEntrantModal({
  entrantId,
  entrantName,
  onCancel,
  onDeleted,
}: {
  entrantId: string;
  entrantName: string;
  onCancel: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const confirm = async () => {
    if (api.getCredential() === null) {
      setError('本地没有工作台凭证，无法删除。请重新兑换邀请码或恢复工作台。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteEntrant(entrantId);
      onDeleted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>删除参赛对象</h3>
          <button
            type="button"
            className="ghost close-btn"
            onClick={onCancel}
            disabled={busy}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <p>
          确认删除参赛对象 <strong>{entrantName}</strong>？
        </p>
        <p className="small muted">
          将从列表、匹配池、排行榜移除并吊销对象凭证，不可恢复；历史对局与回放保留。
        </p>
        {error != null && <ErrorBox error={error} />}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 对局历史（某坦克全部参战记录）

function EntrantHistoryPanel({ entrantId }: { entrantId: string }): JSX.Element {
  const [page, setPage] = useState(1);
  const matches = useAsync(
    () => api.listMatches(undefined, page, 20, { entrantId }),
    [entrantId, page],
  );
  if (matches.loading) return <div className="panel"><Loading /></div>;
  if (matches.error != null) return <div className="panel"><ErrorBox error={matches.error} /></div>;
  const list = matches.data?.matches ?? [];
  const total = matches.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const safePage = Math.min(page, totalPages);

  return (
    <div className="panel">
      <h2>对局历史</h2>
      {list.length === 0 ? (
        <p className="muted">这个坦克还没有参加过任何对局。</p>
      ) : (
        <>
          <table className="data">
            <thead>
              <tr>
                <th>对局</th>
                <th>对战双方</th>
                <th>类型</th>
                <th>时间</th>
                <th>状态</th>
                <th>结果</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.matchId}>
                  <td>
                    <span className="match-id">
                      <span className="mono">{m.matchId.slice(0, 8)}</span>
                    </span>
                  </td>
                  <td>
                    <Versus m={m} />
                  </td>
                  <td>{m.kind === 'official' ? '正式' : '训练'}</td>
                  <td className="small">{formatTime(m.createdAt)}</td>
                  <td>{m.phase === 'finished' ? '已结束' : m.phase === 'running' ? '进行中' : m.phase}</td>
                  <td>
                    <ResultForSelf m={m} selfId={entrantId} />
                  </td>
                  <td>
                    <a
                      className="btn ghost small-btn"
                      href={href(`/match/${encodeURIComponent(m.matchId)}`)}
                    >
                      观看
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button
              type="button"
              className="ghost small-btn"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← 上一页
            </button>
            <span className="small muted">
              第 {safePage} / {totalPages} 页 · 共 {total} 场
            </span>
            <button
              type="button"
              className="ghost small-btn"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页 →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 对战双方单元格：高亮胜方。 */
function Versus({ m }: { m: MatchSummary }): JSX.Element {
  const winner = m.result?.outcome.kind === 'win' ? m.result.outcome.winner ?? null : null;
  const label = (i: 0 | 1): string => {
    const e = m.entrants[i];
    if (!e) return '—';
    if (e.name) return e.name;
    return e.entrantId.slice(0, 8);
  };
  return (
    <span className="versus">
      <span className={winner === 0 ? 'versus-winner' : undefined}>{label(0)}</span>
      <span className="muted"> vs </span>
      <span className={winner === 1 ? 'versus-winner' : undefined}>{label(1)}</span>
    </span>
  );
}

/** 从自己视角看结果：胜 / 负 / 平 / 无效。 */
function ResultForSelf({ m, selfId }: { m: MatchSummary; selfId: string }): JSX.Element {
  if (!m.result) return <span className="muted">—</span>;
  const o = m.result.outcome;
  if (o.kind === 'invalid') return <span className="muted">无效</span>;
  if (o.kind === 'draw') return <span title={o.reason}>平局</span>;
  const mySide = m.entrants.findIndex((e) => e.entrantId === selfId);
  const won = o.winner === mySide;
  return (
    <span className={won ? 'versus-winner' : 'versus-loser'} title={o.reason}>
      {won ? '胜' : '负'}
    </span>
  );
}

// ---------------------------------------------------------------- 委托 Agent 托管

/**
 * 颁发／吊销参赛对象凭证，把托管权交给外部 AI Agent（ADR 0002）。
 * 明文凭证只展示一次，并提供「复制给 AI 的整段提示词」。
 */
function DelegationPanel({ entrantId }: { entrantId: string }): JSX.Element {
  const isWorkspaceCredential = api.getCredentialKind() === 'workspace';
  const [credential, setCredential] = useState<string | null>(null);
  const [hasCredential, setHasCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<'cred' | 'prompt' | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isWorkspaceCredential) return;
    void api
      .getEntrantCredentialStatus(entrantId)
      .then((r) => setHasCredential(r.hasCredential))
      .catch(() => undefined);
  }, [entrantId, isWorkspaceCredential]);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.issueEntrantCredential(entrantId);
      setCredential(res.credential);
      setHasCredential(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeEntrantCredential(entrantId);
      setCredential(null);
      setHasCredential(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: 'cred' | 'prompt') => {
    // HTTP 部署下剪贴板 API 不可用：失败时把文本塞进只读输入框并全选，用户 Ctrl+C。
    const ok = await api.copyTextToClipboard(text, fallbackRef.current);
    setCopied(ok ? what : null);
    window.setTimeout(() => setCopied(null), 2000);
  };

  const guideUrl = `${window.location.origin}/#/agent-guide`;
  const prompt = [
    '你好，请帮我参加 AI 对战平台的坦克大战比赛。请先完整阅读下面的 Agent 指南：',
    '',
    guideUrl,
    '',
    '认证凭证（放在 HTTP 头 Authorization: Bearer <凭证> 中使用）：',
    credential ?? '<先点击颁发>',
    '',
    '工作流：读上下文 → 写策略 → 试跑 → 发布 → 正式对战。',
  ].join('\n');

  return (
    <div className="panel">
      <h2>委托 AI Agent 托管</h2>
      <p className="small muted">
        给这个参赛对象颁发一份<strong>对象凭证</strong>，把它交给外部 AI
        Agent（如 Cursor / Claude / ChatGPT），Agent 就能代你读上下文、写策略、试跑、发布和发起对战。
        对象凭证只能管理这一个对象，看不到你工作台里的其他参赛对象与它们的策略源码。
      </p>

      {!isWorkspaceCredential && (
        <p className="small">只有工作台凭证可以颁发对象凭证（当前本地保存的是对象凭证）。</p>
      )}

      <div className="row">
        <button className="primary" onClick={issue} disabled={busy || !isWorkspaceCredential}>
          {hasCredential ? '重新颁发对象凭证（作废旧凭证）' : '颁发对象凭证'}
        </button>
        {hasCredential && (
          <button onClick={revoke} disabled={busy}>
            吊销并取消托管
          </button>
        )}
      </div>

      {hasCredential && credential == null && (
        <p className="small muted">
          该参赛对象已有凭证（明文不再显示，已在之前展示时复制给 Agent）。
          如凭证丢失或泄露，点击「重新颁发」作废旧凭证并生成新凭证。
        </p>
      )}

      {error != null && <ErrorBox error={error} />}

      {credential != null && (
        <>
          <p className="small">
            <strong>明文凭证只展示这一次</strong>，关闭/刷新本页后无法再取回（只能重新颁发）；
            请立即复制给 Agent 或保存。泄露时点「重新颁发」即可让旧凭证立即失效。
          </p>
          <pre className="code mono">{credential}</pre>
          <textarea
            ref={fallbackRef}
            className="code mono"
            style={{ display: 'none', width: '100%', minHeight: '8em' }}
            readOnly
          />
          <div className="row">
            <button onClick={() => void copy(credential, 'cred')}>
              {copied === 'cred' ? '已复制' : '复制凭证'}
            </button>
            <button onClick={() => void copy(prompt, 'prompt')}>
              {copied === 'prompt' ? '已复制' : '复制「交给 AI 的提示词」'}
            </button>
            <a href={href('/agent-guide')} target="_blank" rel="noreferrer">
              打开 Agent 指南（给 AI 看）
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 策略版本与发布

function StrategyPanel({ entrantId }: { entrantId: string }): JSX.Element {
  const versions = useAsync(() => api.listStrategies(entrantId), [entrantId]);
  const [source, setSource] = useState('');
  const [publicVisible, setPublicVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [published, setPublished] = useState<StrategyVersion | null>(null);

  const publish = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPublished(null);
    try {
      const result = await api.publishStrategy(entrantId, source, publicVisible);
      setPublished({ versionId: result.versionId, publicVisible: result.publicVisible, createdAt: result.createdAt, source: '' });
      versions.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = useCallback(() => {
    const list = versions.data;
    if (list && list.length > 0) setSource(list[list.length - 1].source);
  }, [versions.data]);

  return (
    <>
      <div className="panel">
        <h2>策略版本</h2>
        {versions.loading && <Loading />}
        {versions.error != null && <ErrorBox error={versions.error} />}
        {versions.data &&
          (versions.data.length === 0 ? (
            <p className="muted">尚未发布任何策略版本。</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>公开性</th>
                  <th>发布时间</th>
                </tr>
              </thead>
              <tbody>
                {versions.data.map((v) => (
                  <tr key={v.versionId}>
                    <td>v{v.versionId}</td>
                    <td>{v.publicVisible ? '公开' : '私密'}</td>
                    <td className="small">{formatTime(v.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>

      <div className="panel">
        <h2>发布新策略</h2>
        <p className="small muted">{STRATEGY_API_DOC}</p>
        <form onSubmit={publish}>
          <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => setSource(DEFAULT_STRATEGY_TEMPLATE)}>
              填入默认模板
            </button>
            <button type="button" onClick={loadLatest} disabled={!versions.data || versions.data.length === 0}>
              载入最新版本源码
            </button>
          </div>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="在此粘贴 onIdle 策略源码…"
            spellCheck={false}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 8 }}>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={publicVisible}
                onChange={(e) => setPublicVisible(e.target.checked)}
              />
              公开该版本源码（默认私密）
            </label>
            <button className="primary" type="submit" disabled={busy || source.trim() === ''}>
              {busy ? '发布中…' : '发布新版本'}
            </button>
          </div>
        </form>
        {error != null && <ErrorBox error={error} />}
        {published && (
          <div className="message ok">
            已发布 v{published.versionId}（{published.publicVisible ? '公开' : '私密'}）。对局创建时使用最新已发布版本。
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 发起对局

function StartMatchPanel({
  entrantId,
  defaultGameId,
}: {
  entrantId: string;
  defaultGameId: string;
}): JSX.Element {
  const [opponentMode, setOpponentMode] = useState<'bot' | 'entrant'>('bot');
  const [opponentBotId, setOpponentBotId] = useState('standard-01');
  const [opponentEntrantId, setOpponentEntrantId] = useState('');
  const [kind, setKind] = useState<'official' | 'training'>('training');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [startedMatchId, setStartedMatchId] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStartedMatchId(null);
    try {
      const result = await api.startMatch({
        gameId: defaultGameId,
        kind,
        myEntrantId: entrantId,
        ...api.buildOpponentPayload(kind, opponentMode, opponentBotId, opponentEntrantId),
      });
      setStartedMatchId(result.matchId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy &&
    !!defaultGameId &&
    (kind === 'official' || opponentMode === 'bot' || opponentEntrantId.trim() !== '');

  return (
    <div className="panel">
      <h2>发起对局</h2>
      <p className="small muted">
        训练可指定对手：内置基准 bot（Standard-01 任何人可用，稳定赢它才算及格），
        或粘贴任意坦克 ID（可在下方「我的参赛对象」点「复制 ID」，也可在排行榜 / 对局页复制，
        同工作台的自家坦克也可以）。训练不计分。
        正式对局不能自选对手，由系统随机匹配积分相近（±50）的对手，计入排行榜
        （同工作台的正式对局不计分）；当前没有合适对手时会提示稍后再试。
      </p>
      <form className="inline" onSubmit={onSubmit}>
        <label className="field">
          类型
          <select value={kind} onChange={(e) => setKind(e.target.value as 'official' | 'training')}>
            <option value="training">训练（不计分，可指定对手）</option>
            <option value="official">正式（计分，随机匹配）</option>
          </select>
        </label>
        {kind === 'training' && (
          <>
            <label className="field">
              对手类型
              <select
                value={opponentMode}
                onChange={(e) => setOpponentMode(e.target.value as 'bot' | 'entrant')}
              >
                <option value="bot">内置基准 bot</option>
                <option value="entrant">指定坦克（粘贴 ID）</option>
              </select>
            </label>
            {opponentMode === 'bot' ? (
              <label className="field">
                基准 bot
                <select value={opponentBotId} onChange={(e) => setOpponentBotId(e.target.value)}>
                  <option value="standard-01">Standard-01（官方基准）</option>
                  <option value="nova-scout">Nova Scout（侦察机动型）</option>
                  <option value="crimson-bastion">Crimson Bastion（堡垒防守型）</option>
                </select>
              </label>
            ) : (
              <label className="field">
                对手坦克 ID
                <input
                  type="text"
                  value={opponentEntrantId}
                  onChange={(e) => setOpponentEntrantId(e.target.value)}
                  placeholder="粘贴对手的坦克 ID"
                  required
                  style={{ width: 320 }}
                />
              </label>
            )}
          </>
        )}
        <div>
          <button className="primary" type="submit" disabled={!canSubmit}>
            {busy ? '发起中…' : kind === 'official' ? '随机匹配对手' : '开始训练'}
          </button>
        </div>
      </form>
      {error != null && <ErrorBox error={error} />}
      {startedMatchId && (
        <div className="message ok">
          对局已创建：
          <button
            className="link mono"
            type="button"
            onClick={() => navigate(`/match/${encodeURIComponent(startedMatchId)}`)}
          >
            {startedMatchId}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 快速试跑

/** 占位 bot 列表（bot 列表端点未就绪时的回退；GET /api/agent/context 可用时取真实列表）。 */
/** 试跑对手下拉的一项：id + 展示名。 */
interface AgentBot {
  id: string;
  label: string;
}

const FALLBACK_BOTS: AgentBot[] = [
  { id: 'standard-01', label: 'Standard-01（官方基准）' },
  { id: 'nova-scout', label: 'Nova Scout（侦察机动型）' },
  { id: 'crimson-bastion', label: 'Crimson Bastion（堡垒防守型）' },
];

type SimSourceMode = 'latest' | 'paste';

function QuickSimPanel({
  entrantId,
}: {
  entrantId: string;
}): JSX.Element {
  const [mode, setMode] = useState<SimSourceMode>('latest');
  const [pasteCode, setPasteCode] = useState('');
  const [opponent, setOpponent] = useState('__random__');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [bots, setBots] = useState<AgentBot[]>(FALLBACK_BOTS);
  const versions = useAsync(() => api.listStrategies(entrantId), [entrantId]);
  const latestSource =
    versions.data && versions.data.length > 0
      ? versions.data[versions.data.length - 1].source
      : null;

  // bot 列表：优先 GET /api/agent/context，失败回退占位
  useEffect(() => {
    let cancelled = false;
    api
      .getAgentContext()
      .then((ctx) => {
        if (cancelled) return;
        const list = Array.isArray(ctx.bots) ? ctx.bots : [];
        // 只有拿到非空真实列表才覆盖；否则保留 FALLBACK_BOTS 占位
        if (list.length > 0) setBots(list.map(botToOption));
      })
      .catch(() => {
        // 端点未就绪 → 保留占位列表
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const code = mode === 'latest' ? latestSource ?? '' : pasteCode;

  const onRun = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.simulate({
        code,
        ...(opponent === '__random__' ? {} : { opponent: { botId: opponent } }),
      });
      setResult(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>快速试跑</h2>
      <p className="small muted">
        不发布、直接在服务端沙箱跑一局坦克对战，返回回放与日志（限流 2 秒 1 次）。
        详细契约见 <a href={href('/agent-guide')}>Agent 指南</a>。
      </p>
      <form className="stack" onSubmit={onRun} style={{ maxWidth: 'none' }}>
        <fieldset className="sim-source">
          <legend className="small muted">策略代码来源</legend>
          <label className="small">
            <input
              type="radio"
              name="sim-source"
              checked={mode === 'latest'}
              onChange={() => setMode('latest')}
              disabled={!latestSource}
            />{' '}
            最新已发布版本
            {latestSource ? '' : '（尚未发布任何版本）'}
          </label>
          <label className="small">
            <input
              type="radio"
              name="sim-source"
              checked={mode === 'paste'}
              onChange={() => setMode('paste')}
            />{' '}
            粘贴代码
          </label>
          {mode === 'paste' && (
            <textarea
              value={pasteCode}
              onChange={(e) => setPasteCode(e.target.value)}
              placeholder="在此粘贴 onIdle 策略源码…（可先在上方发布区填模板）"
              spellCheck={false}
            />
          )}
        </fieldset>
        <label className="field" style={{ maxWidth: 320 }}>
          对手
          <select value={opponent} onChange={(e) => setOpponent(e.target.value)}>
            <option value="__random__">随机</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button className="primary" type="submit" disabled={busy || code.trim() === ''}>
            {busy ? '试跑中…' : '开始试跑'}
          </button>
        </div>
      </form>
      {error != null && (
        <ErrorBox
          error={
            error instanceof api.ApiError && error.status === 429
              ? '试跑冷却中，2 秒 1 次，请稍后再试。'
              : error
          }
        />
      )}
      {result && <SimulateResultView result={result} />}
    </div>
  );
}

/** context 返回的 bot → 下拉项：显示名称，保留 id 作提交值。 */
function botToOption(b: unknown): AgentBot {
  const o = (b ?? {}) as { id?: unknown; botId?: unknown; name?: unknown };
  const id = typeof o.id === 'string' ? o.id : typeof o.botId === 'string' ? o.botId : '';
  const name = typeof o.name === 'string' ? o.name : '';
  return { id, label: name !== '' ? name : id };
}

function SimulateResultView({ result }: { result: SimulateResult }): JSX.Element {
  const stat = (s: unknown): string => {
    if (typeof s === 'object' && s !== null) {
      const v = s as { hp?: unknown; stars?: unknown };
      const hp = typeof v.hp === 'number' ? v.hp : '?';
      const stars = typeof v.stars === 'number' ? v.stars : '?';
      return `HP ${hp} · ⭐×${stars}`;
    }
    return String(s);
  };
  const banner =
    result.outcome.kind === 'invalid'
      ? { cls: 'tag invalid', text: `无效（${result.outcome.reason}）` }
      : result.outcome.winner === 'self'
        ? { cls: 'tag win', text: `我方胜（${result.outcome.reason}）` }
        : result.outcome.winner === 'opponent'
          ? { cls: 'tag invalid', text: `我方负（${result.outcome.reason}）` }
          : { cls: 'tag draw', text: `平局（${result.outcome.reason}）` };

  return (
    <>
      <div className="sim-result-banner">
        <span className={banner.cls}>{banner.text}</span>
        <span className="small muted">
          {result.selfName} vs {result.opponentName} · 共 {result.ticks} tick
        </span>
      </div>
      <div className="sim-stats small">
        <span>
          <strong>{result.selfName}</strong>：{stat(result.selfStats)}
        </span>
        <span>
          <strong>{result.opponentName}</strong>：{stat(result.opponentStats)}
        </span>
      </div>
      <TankReplayPlayer frames={result.frames} title="试跑回放" />
      <div className="sim-logs">
        <div>
          <h3>{result.selfName} · print 日志</h3>
          <pre className="code sim-log">{result.logs.self.join('\n') || '（无日志）'}</pre>
        </div>
        <div>
          <h3>{result.opponentName} · print 日志</h3>
          <pre className="code sim-log">{result.logs.opponent.join('\n') || '（无日志）'}</pre>
        </div>
      </div>
    </>
  );
}
