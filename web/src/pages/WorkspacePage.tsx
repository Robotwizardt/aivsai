import { FormEvent, useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { href, navigate } from '../router';
import { ErrorBox, formatTime, Loading, useAsync } from '../components';
import { Entrant, StrategyVersion } from '../types';
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
    return (
      <div className="panel">
        <h2>我的工作台</h2>
        <p className="muted">
          尚未兑换工作台。请回到<a href={href('/')}>首页</a>输入邀请码，或用{' '}
          <a href={href('/recover')}>恢复码</a> 找回已有工作台。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <h2>我的参赛对象</h2>
        {entrants.loading && <Loading />}
        {entrants.error != null && <ErrorBox error={entrants.error} />}
        {entrants.data &&
          (entrants.data.length === 0 ? (
            <p className="muted">还没有参赛对象，先在下方创建一个。</p>
          ) : (
            <div className="entrant-list">
              {entrants.data.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`entrant-item${selectedId === e.id ? ' selected' : ''}`}
                  onClick={() => setSelectedId(e.id)}
                >
                  <span className="entrant-swatch" style={{ background: e.appearance.color }} />
                  <span>
                    <div className="entrant-name">{e.name}</div>
                    <div className="entrant-meta">
                      {e.appearance.name} · {e.appearance.preset} · 游戏 {e.gameId} ·{' '}
                      <span className="mono">{e.id.slice(0, 8)}…</span>
                    </div>
                  </span>
                </button>
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

      {selectedId && entrants.data && (
        <EntrantDetail
          entrant={entrants.data.find((e) => e.id === selectedId) ?? null}
          entrantId={selectedId}
        />
      )}
    </>
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

function EntrantDetail({ entrant, entrantId }: { entrant: Entrant | null; entrantId: string }): JSX.Element {
  return (
    <>
      <div className="panel">
        <h2>{entrant ? entrant.name : entrantId}</h2>
        {entrant && (
          <p className="small muted">
            游戏 {entrant.gameId} · 外观 {entrant.appearance.preset}（{entrant.appearance.name}）· 创建于{' '}
            {formatTime(entrant.createdAt)}
          </p>
        )}
      </div>
      <StrategyPanel entrantId={entrantId} />
      <StartMatchPanel entrantId={entrantId} defaultGameId={entrant?.gameId ?? ''} />
    </>
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
        opponentEntrantId: opponentEntrantId.trim(),
      });
      setStartedMatchId(result.matchId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>发起对局</h2>
      <p className="small muted">
        对手需为同游戏下已有已发布策略的参赛对象（可在排行榜中复制其 ID）。训练不计分；正式对局计入排行榜。
      </p>
      <form className="inline" onSubmit={onSubmit}>
        <label className="field">
          对手参赛对象 ID
          <input
            type="text"
            value={opponentEntrantId}
            onChange={(e) => setOpponentEntrantId(e.target.value)}
            placeholder="粘贴对手 entrantId"
            required
            style={{ width: 320 }}
          />
        </label>
        <label className="field">
          类型
          <select value={kind} onChange={(e) => setKind(e.target.value as 'official' | 'training')}>
            <option value="training">训练（不计分）</option>
            <option value="official">正式（计分）</option>
          </select>
        </label>
        <div>
          <button
            className="primary"
            type="submit"
            disabled={busy || opponentEntrantId.trim() === '' || !defaultGameId}
          >
            {busy ? '发起中…' : '发起'}
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
