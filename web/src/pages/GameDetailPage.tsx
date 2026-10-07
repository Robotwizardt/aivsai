import { FormEvent, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { href } from '../router';
import { renderTankFrame, TERRAIN_LEGEND } from '../tank-renderer';
import { TANK_MAP_ARENA, TANK_MAP_PREVIEWS, TankMapPreview } from '../tank-maps';
import { Entrant, TankGameState } from '../types';
import {
  CopyButton,
  EmptyState,
  EntrantName,
  ErrorBox,
  MatchKindTag,
  MatchPhaseTag,
  OutcomeTag,
  RelativeTime,
  Skeleton,
  useAsync,
} from '../components';

const PACING_LABEL: Record<string, string> = {
  instant: '即时制',
  'turn-based': '回合制',
};

const GAME_ICONS: Record<string, string> = {
  tank: '🛡️',
  gomoku: '⬛',
};

function gameIcon(gameId: string): string {
  return GAME_ICONS[gameId] ?? '🎮';
}

const RANK_BADGES = ['🥇', '🥈', '🥉'];

function rankBadge(index: number): JSX.Element {
  if (index < RANK_BADGES.length) {
    return (
      <span className="rank-badge" aria-label={`第 ${index + 1} 名`}>
        {RANK_BADGES[index]}
      </span>
    );
  }
  return <span className="rank-num">{index + 1}</span>;
}

export function GameDetailPage({ gameId }: { gameId: string }): JSX.Element {
  const games = useAsync(() => api.listGames(), [gameId]);
  const board = useAsync(() => api.getLeaderboard(gameId), [gameId]);
  const hasCredential = api.getCredential() !== null;

  const game = games.data?.find((g) => g.id === gameId);

  return (
    <>
      <a className="back-link" href={href('/')}>
        ← 返回游戏列表
      </a>

      {/* 顶部：游戏概览 */}
      <div className="panel game-header">
        <div className="game-icon large" aria-hidden>
          {gameIcon(gameId)}
        </div>
        <div className="game-header-info">
          <h2>{game ? game.name : gameId}</h2>
          <p className="small muted" style={{ margin: 0 }}>
            <span className="tag pacing">{game ? PACING_LABEL[game.pacing] ?? game.pacing : '…'}</span>
            {' · '}ID：<span className="mono">{gameId}</span>{' '}
            <CopyButton text={gameId} />
          </p>
        </div>
      </div>

      {/* 我的参赛对象（已绑定工作台时） */}
      {hasCredential && <MyEntrantsPanel gameId={gameId} />}

      {/* 地图（游戏内部战场布局预览，仅坦克大战有预设地图池） */}
      {gameId === 'tank' && <MapPreviewSection />}

      {/* 排行榜 */}
      <div className="panel">
        <h2>排行榜</h2>
        {board.loading && <Skeleton rows={5} />}
        {board.error != null && <ErrorBox error={board.error} />}
        {board.data &&
          (board.data.entries.length === 0 ? (
            <EmptyState
              icon="🏆"
              text="暂无排名"
              hint="需要有已计分的正式对局后才会产生排名"
            />
          ) : (
            <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>参赛对象</th>
                  <th>积分</th>
                  <th>胜</th>
                  <th>负</th>
                  <th>平</th>
                </tr>
              </thead>
              <tbody>
                {board.data.entries.map((entry, i) => (
                  <tr key={entry.entrantId}>
                    <td>{rankBadge(i)}</td>
                    <td>
                      <span className="match-id">
                        <EntrantName
                          name={entry.name}
                          entrantId={entry.entrantId}
                          workspaceNickname={entry.workspaceNickname}
                        />
                        <CopyButton text={entry.entrantId} />
                      </span>
                    </td>
                    <td>
                      <strong>{Math.round(entry.score)}</strong>
                    </td>
                    <td>{entry.wins}</td>
                    <td>{entry.losses}</td>
                    <td>{entry.draws}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ))}
      </div>

      <MatchHistoryPanel gameId={gameId} />
    </>
  );
}

// ---------------------------------------------------------------- 地图预览

/** 地图一节：把 4 张预设地图画成缩略图（只画地形，不画坦克/星星/HP）。 */
function MapPreviewSection(): JSX.Element {
  const terrainLegend = TERRAIN_LEGEND.filter((t) => t.key !== 'star');
  return (
    <div className="panel">
      <h2>地图</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        每场对局从这 4 张预设地图与随机布局中确定一张战场。
      </p>
      <div className="map-preview-grid">
        {TANK_MAP_PREVIEWS.map((map) => (
          <MapThumbnail key={map.id} map={map} />
        ))}
      </div>
      <div className="map-legend">
        {terrainLegend.map((t) => (
          <span key={t.key} className="map-legend-item">
            <span className="map-legend-swatch" style={{ background: t.color }} aria-hidden />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 单张地图缩略图：用 renderTankFrame 画空对局地形的 canvas（CSS 缩到小图尺寸）。 */
function MapThumbnail({ map }: { map: TankMapPreview }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    // 空 state：无坦克/子弹/星星，只渲染地形；renderTankFrame 会按 arena 重设 canvas 尺寸。
    const state: TankGameState = {
      tick: 0,
      arena: { width: TANK_MAP_ARENA.width, height: TANK_MAP_ARENA.height },
      tanks: [],
      bullets: [],
      terrain: map.terrain,
      star: null,
    };
    renderTankFrame(ctx, state);
  }, [map]);

  return (
    <figure className="map-preview-card">
      <canvas ref={ref} className="map-preview-canvas" aria-label={`地图：${map.name}`} />
      <figcaption className="map-preview-name">{map.name}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- 对局历史（分页）

const MATCH_PAGE_SIZE = 20;

function MatchHistoryPanel({ gameId }: { gameId: string }): JSX.Element {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<'' | 'official' | 'training'>('');
  const matches = useAsync(
    () => api.listMatches(gameId, page, MATCH_PAGE_SIZE, kind ? { kind } : undefined),
    [gameId, page, kind],
  );
  // 数据量变短时（如切游戏/切类型）避免停在高页码
  const total = matches.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MATCH_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  return (
      <div className="panel">
        <h2>对局历史</h2>
        {/* 筛选：按类型（训练/正式） */}
        <div className="match-filter">
          <label className="field">
            类型
            <select
              value={kind}
              onChange={(e) => {
                setPage(1);
                setKind(e.target.value as '' | 'official' | 'training');
              }}
            >
              <option value="">全部</option>
              <option value="official">正式</option>
              <option value="training">训练</option>
            </select>
          </label>
        </div>
        {matches.loading && <Skeleton rows={5} />}
        {matches.error != null && <ErrorBox error={matches.error} />}
        {matches.data &&
          (matches.data.matches.length === 0 ? (
            <EmptyState icon="⚔️" text="暂无对局" hint="发起一场对局后会出现在这里" />
          ) : (
            <>
            <div className="table-scroll">
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
                {matches.data.matches.map((m) => (
                  <tr key={m.matchId}>
                    <td>
                      <span className="match-id">
                        <span className="mono">{m.matchId.slice(0, 8)}</span>
                        <CopyButton text={m.matchId} />
                      </span>
                    </td>
                    <td>
                      <VersusCell
                        a={{
                          name: m.entrants[0]?.name ?? null,
                          id: m.entrants[0]?.entrantId ?? '',
                          ws: m.entrants[0]?.workspaceNickname ?? null,
                        }}
                        b={{
                          name: m.entrants[1]?.name ?? null,
                          id: m.entrants[1]?.entrantId ?? '',
                          ws: m.entrants[1]?.workspaceNickname ?? null,
                        }}
                        winner={
                          m.result?.outcome.kind === 'win' ? m.result.outcome.winner ?? null : null
                        }
                      />
                    </td>
                    <td>
                      <MatchKindTag kind={m.kind} />
                    </td>
                    <td>
                      <RelativeTime at={m.createdAt} />
                    </td>
                    <td>
                      <MatchPhaseTag phase={m.phase} />
                    </td>
                    <td>
                      {m.result ? (
                        <span title={m.result.outcome.reason}>
                          <OutcomeTag outcome={m.result.outcome} />
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
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
            </div>
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
                第 {safePage} / {totalPages} 页
                {matches.data.total !== undefined ? ` · 共 ${matches.data.total} 场` : ''}
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
          ))}
      </div>
  );
}

/** 对战双方单元格：「名字@工作台」+ 胜者标记；名字缺失时退回 ID 前 8 位。 */
function VersusCell({
  a,
  b,
  winner,
}: {
  a: { name: string | null; id: string; ws?: string | null };
  b: { name: string | null; id: string; ws?: string | null };
  winner: 0 | 1 | null;
}): JSX.Element {
  const side = (s: 0 | 1) => (s === 0 ? a : b);
  return (
    <span className="versus">
      <span className={winner === 0 ? 'versus-winner' : undefined}>
        <EntrantName name={side(0).name} entrantId={side(0).id} workspaceNickname={side(0).ws} />
      </span>
      <span className="muted"> vs </span>
      <span className={winner === 1 ? 'versus-winner' : undefined}>
        <EntrantName name={side(1).name} entrantId={side(1).id} workspaceNickname={side(1).ws} />
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- 我的参赛对象

function MyEntrantsPanel({ gameId }: { gameId: string }): JSX.Element {
  const entrants = useAsync(() => api.listMyEntrants(), [gameId]);
  const [matchingEntrant, setMatchingEntrant] = useState<Entrant | null>(null);
  const mine = entrants.data?.filter((e) => e.gameId === gameId) ?? [];

  return (
    <div className="panel">
      <h2>我的参赛对象</h2>
      {entrants.loading && <Skeleton rows={2} />}
      {entrants.error != null && <ErrorBox error={entrants.error} />}
      {entrants.data &&
        (mine.length === 0 ? (
          <EmptyState
            icon="🤖"
            text="你在该游戏下还没有参赛对象"
            hint="前往工作台创建参赛对象并发布策略"
          />
        ) : (
          <div className="entrant-card-grid">
            {mine.map((e) => (
              <div key={e.id} className="entrant-card">
                <span
                  className="entrant-swatch"
                  style={{ background: e.appearance.color }}
                  aria-hidden
                />
                <div className="entrant-card-body">
                  <div className="entrant-name">{e.name}</div>
                  <div className="entrant-meta">
                    {e.appearance.name} · {e.appearance.preset}
                  </div>
                </div>
                <div className="entrant-card-actions">
                  <button type="button" className="primary" onClick={() => setMatchingEntrant(e)}>
                    发起对局
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      <p className="small muted" style={{ marginBottom: 0 }}>
        需要新建对象或发布策略？<a href={href('/workspace')}>前往工作台 →</a>
      </p>
      {matchingEntrant && (
        <QuickMatchModal entrant={matchingEntrant} onClose={() => setMatchingEntrant(null)} />
      )}
    </div>
  );
}

/** 快速发起对局：内置基准 bot 做对手，无需离开本页。 */
function QuickMatchModal({
  entrant,
  onClose,
}: {
  entrant: Entrant;
  onClose: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<'official' | 'training'>('training');
  const [botId, setBotId] = useState('standard-01');
  // 训练对手来源：内置 bot 或粘贴任意坦克 ID
  const [opponentMode, setOpponentMode] = useState<'bot' | 'entrant'>('bot');
  const [opponentEntrantId, setOpponentEntrantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [startedMatchId, setStartedMatchId] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // 正式对局不传对手（由系统随机匹配积分相近者）；训练需指定 bot 或坦克 ID。
      const result = await api.startMatch({
        gameId: entrant.gameId,
        kind,
        myEntrantId: entrant.id,
        ...api.buildOpponentPayload(kind, opponentMode, botId, opponentEntrantId),
      });
      setStartedMatchId(result.matchId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>发起对局 · {entrant.name}</h3>
          <button type="button" className="ghost close-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {startedMatchId ? (
          <div>
            <div className="message ok">对局已创建。</div>
            <div className="flex-row">
              <a className="btn primary" href={href(`/match/${encodeURIComponent(startedMatchId)}`)}>
                前往观看 →
              </a>
              <button type="button" className="ghost" onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        ) : (
          <form className="stack" onSubmit={onSubmit}>
            <label className="field">
              对局类型
              <select value={kind} onChange={(e) => setKind(e.target.value as 'official' | 'training')}>
                <option value="training">训练（不计分，可指定对手）</option>
                <option value="official">正式（计分，随机匹配）</option>
              </select>
            </label>

            {kind === 'official' ? (
              <p className="small muted" style={{ margin: 0 }}>
                正式对局由系统<strong>随机匹配积分相近</strong>（±50）的对手，不能自选。
                同工作台的坦克也在匹配池内，但同工作台的正式对局不计分。
                当前没有合适对手时会提示稍后再试。
              </p>
            ) : (
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
                    <select value={botId} onChange={(e) => setBotId(e.target.value)}>
                      <option value="standard-01">Standard-01（官方基准）</option>
                      <option value="nova-scout">Nova Scout（侦察机动型）</option>
                      <option value="crimson-bastion">Crimson Bastion（堡垒防守型）</option>
                    </select>
                  </label>
                ) : (
                  <label className="field">
                    对手坦克 ID
                    <input
                      value={opponentEntrantId}
                      onChange={(e) => setOpponentEntrantId(e.target.value)}
                      placeholder="粘贴对手的坦克 ID（可在工作台 / 排行榜 / 对局页复制）"
                      spellCheck={false}
                    />
                  </label>
                )}
                <p className="small muted" style={{ margin: 0 }}>
                  训练不计分。可挑战任意已发布策略的坦克；不能挑战自己工作台的坦克。
                </p>
              </>
            )}

            <div className="flex-row">
              <button
                className="primary"
                type="submit"
                disabled={busy || (kind === 'training' && opponentMode === 'entrant' && !opponentEntrantId.trim())}
              >
                {busy ? '创建中…' : kind === 'official' ? '随机匹配对手' : '开始训练'}
              </button>
              <button type="button" className="ghost" onClick={onClose}>
                取消
              </button>
            </div>
            {error != null && <ErrorBox error={error} />}
          </form>
        )}
      </div>
    </div>
  );
}
