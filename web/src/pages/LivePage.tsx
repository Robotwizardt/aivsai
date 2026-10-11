import { FormEvent, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { href } from '../router';
import { CopyButton, ErrorBox, useAsync } from '../components';
import type { GameInfo } from '../types';

/**
 * 表演赛页（#/live）：公开表演赛列表（直播大厅）+ 登录用户的创建入口与我的对局管理。
 * ADR 0017：创建后返回两个座位链接（只此一次），人发给两个外部 AI。
 */
export function LivePage(): JSX.Element {
  // 表演赛可用游戏（含象棋等 exhibitionOnly 游戏；ADR 0018，不用常规 /api/games）。
  const games = useAsync(() => api.listExhibitionGames(), []);
  const publicList = useAsync(() => api.listExhibitions(), []);
  const mine = useAsync(
    () => (api.getToken() ? api.listMyExhibitions() : Promise.resolve(null)),
    [],
  );

  return (
    <>
      <div className="panel">
        <h2>表演赛直播大厅</h2>
        <p className="small muted">
          表演赛是人与 AI 共同参与的公开对局：创建者发起对局，把两个座位链接分别交给两个外部
          AI（任何能调 HTTP 的 Agent），它们轮流出手，观众在此观看直播。
        </p>
        {publicList.loading ? (
          <p className="small muted">加载中…</p>
        ) : publicList.error ? (
          <ErrorBox error={publicList.error} />
        ) : (
          <PublicList exhibitions={publicList.data ?? []} reload={publicList.reload} />
        )}
      </div>

      {api.getToken() !== null && (
        <>
          <CreatePanel games={games.data ?? []} onCreated={() => { publicList.reload(); mine.reload(); }} />
          {mine.loading ? (
            <p className="small muted">我的表演赛加载中…</p>
          ) : mine.error ? (
            <ErrorBox error={mine.error} />
          ) : (
            <MineList exhibitions={mine.data ?? []} onChanged={() => { publicList.reload(); mine.reload(); }} />
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 公开列表

function PublicList({
  exhibitions,
  reload,
}: {
  exhibitions: api.ExhibitionSummary[];
  reload: () => void;
}): JSX.Element | null {
  // 10s 轮询刷新（直播大厅视角；帧流在观战页走 SSE）。
  useInterval(reload, 10_000);
  if (exhibitions.length === 0) {
    return (
      <p className="small muted">
        还没有公开的表演赛。<a href={href('/login')}>登录</a>后创建一场，把座位链接发给你的外部 Agent。
      </p>
    );
  }
  return (
    <table className="data">
      <thead>
        <tr>
          <th>标题</th>
          <th>游戏</th>
          <th>座位</th>
          <th>状态</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {exhibitions.map((ex) => (
          <tr key={ex.matchId}>
            <td>{ex.title || `表演赛 ${ex.matchId.slice(0, 8)}`}</td>
            <td>{ex.gameId}</td>
            <td className="small muted">
              {seatLabel(ex.seatNames[0], '红')} vs {seatLabel(ex.seatNames[1], '黑')}
            </td>
            <td>{ex.finishedAt ? '已结束' : ex.voidedAt ? '已解散' : ex.paused ? '暂停中' : '进行中'}</td>
            <td>
              <a className="btn ghost small-btn" href={href(`/match/${encodeURIComponent(ex.matchId)}`)}>
                观战
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function seatLabel(name: string | null, fallback: string): string {
  return name || fallback;
}

// ---------------------------------------------------------------- 创建

function CreatePanel({
  games,
  onCreated,
}: {
  games: GameInfo[];
  onCreated: () => void;
}): JSX.Element {
  const [gameId, setGameId] = useState(games[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<api.CreateExhibitionResult | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createExhibition({
        gameId,
        ...(title.trim() !== '' ? { title: title.trim() } : {}),
        perMoveTimeoutMinutes: timeoutMinutes,
        isPublic,
      });
      setCreated(result);
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="panel">
        <h2>表演赛已创建</h2>
        <p className="small muted">
          把两个座位链接分别发给两个 AI（浏览器打开 <span className="mono">#/seat/&lt;密钥&gt;</span>{' '}
          可看人话版操作卡）。密钥只在创建时展示这一次，也可随时在本页「我的表演赛」中重新查看。
        </p>
        {created.seatLinks.map((link) => (
          <div key={link.side} className="seat-link-row">
            <span className="tag">{link.side === 0 ? '红方座位' : '黑方座位'}</span>
            <code className="mono seat-key">{link.key}</code>
            <CopyButton text={link.key} label="复制密钥" />
            <CopyButton
              text={link.url}
              label="复制链接"
            />
          </div>
        ))}
        <p className="small muted">
          观战与分享：<code className="mono">{`#/match/${created.matchId}`}</code>{' '}
          <CopyButton text={`#/match/${created.matchId}`} label="复制" />
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="btn primary" href={href(`/match/${encodeURIComponent(created.matchId)}`)}>
            去观战
          </a>
          <button className="btn" type="button" onClick={() => setCreated(null)}>
            再创建一场
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>创建表演赛</h2>
      <form className="stack" onSubmit={onSubmit}>
        <label className="field">
          游戏
          <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          标题（可选）
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：Kimi vs 豆包"
            maxLength={100}
          />
        </label>
        <label className="field">
          每步时限（分钟，超时判负）
          <input
            type="number"
            min={1}
            max={1440}
            value={timeoutMinutes}
            onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
          />
        </label>
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          公开（进入直播大厅；不勾则仅凭链接观战）
        </label>
        <div>
          <button className="primary" type="submit" disabled={busy || gameId === ''}>
            {busy ? '创建中…' : '创建对局，生成座位链接'}
          </button>
        </div>
      </form>
      {error != null && <ErrorBox error={error} />}
    </div>
  );
}

// ---------------------------------------------------------------- 我的管理

function MineList({
  exhibitions,
  onChanged,
}: {
  exhibitions: api.ExhibitionSummary[];
  onChanged: () => void;
}): JSX.Element | null {
  if (exhibitions.length === 0) return null;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [shownKeys, setShownKeys] = useState<Record<string, Array<{ side: 0 | 1; key: string; url: string }>>>({});

  const act = async (matchId: string, op: 'pause' | 'resume' | 'dissolve') => {
    setBusyId(matchId);
    setError(null);
    try {
      if (op === 'pause') await api.pauseExhibition(matchId);
      else if (op === 'resume') await api.resumeExhibition(matchId);
      else await api.dissolveExhibition(matchId);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  const viewKeys = async (matchId: string) => {
    setBusyId(matchId);
    setError(null);
    try {
      const links = await api.getSeatKeys(matchId);
      setShownKeys((prev) => ({ ...prev, [matchId]: links }));
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <h2>我的表演赛</h2>
      {error != null && <ErrorBox error={error} />}
      <table className="data">
        <thead>
          <tr>
            <th>标题</th>
            <th>游戏</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {exhibitions.map((ex) => {
            const finished = ex.finishedAt !== null || ex.voidedAt !== null;
            return (
              <tr key={ex.matchId}>
                <td>{ex.title || `表演赛 ${ex.matchId.slice(0, 8)}`}</td>
                <td>{ex.gameId}</td>
                <td>
                  {finished ? '已结束' : ex.paused ? '暂停中' : '进行中'}
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <a className="btn ghost small-btn" href={href(`/match/${encodeURIComponent(ex.matchId)}`)}>
                    观战
                  </a>
                  {!finished && (
                    <>
                      <button
                        className="btn ghost small-btn"
                        type="button"
                        disabled={busyId === ex.matchId}
                        onClick={() => void viewKeys(ex.matchId)}
                      >
                        密钥
                      </button>
                      <button
                        className="btn ghost small-btn"
                        type="button"
                        disabled={busyId === ex.matchId}
                        onClick={() => void act(ex.matchId, ex.paused ? 'resume' : 'pause')}
                      >
                        {ex.paused ? '恢复' : '暂停'}
                      </button>
                      <button
                        className="btn ghost small-btn"
                        type="button"
                        disabled={busyId === ex.matchId}
                        onClick={() => void act(ex.matchId, 'dissolve')}
                      >
                        解散
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.entries(shownKeys).map(([matchId, links]) =>
        links.length === 0 ? null : (
          <div key={matchId} className="seat-link-row" style={{ marginTop: 8 }}>
            <span className="small muted">{matchId.slice(0, 8)} 座位密钥：</span>
            {links.map((l) => (
              <code key={l.side} className="mono seat-key" style={{ marginLeft: 8 }}>
                {l.side === 0 ? '红' : '黑'} {l.key}
              </code>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 工具

/** 轮询 hook：每 ms 毫秒执行一次 callback；卸载时自动清理。 */
function useInterval(callback: () => void, ms: number): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    const id = window.setInterval(() => saved.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}
