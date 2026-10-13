import { useState } from 'react';
import * as api from '../api';
import { href } from '../router';
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
  reversi: '◑',
};

function gameIcon(gameId: string): string {
  return GAME_ICONS[gameId] ?? '🎮';
}

export function HomePage(): JSX.Element {
  const games = useAsync(() => api.listGames());
  const exhibitions = useAsync(() => api.listExhibitionGames());
  // 表演赛游戏只进展示目录，不混入正式对局筛选与参赛对象创建列表。
  const directory = [...(games.data ?? []), ...(exhibitions.data ?? []).filter(g => g.id === 'reversi' && !games.data?.some(regular => regular.id === g.id))];

  const hasCredential = api.getToken() !== null;
  const isGuest = !hasCredential;

  // 令牌失效被清掉时的说明（读取后清空，只提示一次）
  const staleNotice = api.takeUnauthorizedNotice();

  return (
    <>
      {staleNotice != null && <div className="message error">{staleNotice}</div>}

      {isGuest ? (
        <>
          {/* 游客视角：hero + 登录入口 */}
          <div className="hero">
            <div className="hero-copy">
              <h1>
                写出策略
                <br />
                <span className="hero-accent">赢下对战</span>
              </h1>
              <p className="hero-sub">
                写一段代码，让你的 AI 上场对战。
              </p>
              <div className="hero-secondary">
                <a className="btn primary" href={href('/login')}>
                  登录
                </a>
                <a className="btn" href={href('/register')}>
                  注册（需邀请码）
                </a>
              </div>
              <div className="hero-secondary">
                <button
                  type="button"
                  className="hero-link"
                  onClick={() =>
                    document
                      .getElementById('matches-anchor')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  观战最近对局 <span aria-hidden>›</span>
                </button>
              </div>
            </div>
            <div className="hero-visual" aria-hidden>
              <img src="/assets/hero-flat-v2.png" alt="" />
            </div>
          </div>

          <section className="section steps-section">
            <div className="section-head">
              <h2>三步，开始对战</h2>
              <p className="section-sub">不用装环境，一段 JavaScript 就是你的 AI。</p>
            </div>
            <div className="steps-grid">
              <div className="step-card">
                <div className="step-num">1</div>
                <div className="step-title">编写策略代码</div>
                <div className="step-desc">在编辑器里写一段 JavaScript，决定你的坦克每一步怎么走、朝哪打。</div>
                <div className="step-visual">
                  <pre className="step-code" aria-hidden>{`// 你的坦克大脑
function tick({ me, enemy }) {
  if (me.canShoot(enemy)) {
    return me.fire(enemy);
  }
  return me.chase(enemy);
}`}</pre>
                </div>
              </div>
              <div className="step-card">
                <div className="step-num">2</div>
                <div className="step-title">创建你的 Agent</div>
                <div className="step-desc">把策略发布成一个参赛对象，取个名字、选个颜色，它就代表你出战。</div>
                <div className="step-visual">
                  <div className="step-mock" aria-hidden>
                    <span className="step-mock-tank" />
                    <span className="step-mock-name mono">深蓝突袭者</span>
                    <span className="step-mock-dot" style={{ background: '#0071e3' }} />
                    <span className="step-mock-dot" style={{ background: '#34c759' }} />
                    <span className="step-mock-dot" style={{ background: '#ff9500' }} />
                  </div>
                  <div className="step-mock">
                    <span className="step-mock-tank" style={{ background: '#34c759' }} />
                    <span className="step-mock-name mono">疾风猎手</span>
                    <span className="step-mock-meta small muted">已发布 v3</span>
                  </div>
                </div>
              </div>
              <div className="step-card">
                <div className="step-num">3</div>
                <div className="step-title">匹配对战</div>
                <div className="step-desc">与其他 Agent 或内置基准对战，看直播、查回放、冲排行榜。</div>
                <div className="step-visual">
                  <div className="step-mock step-mock-match" aria-hidden>
                    <span className="step-mock-vs">
                      <span className="step-mock-side" style={{ background: '#0071e3' }} />
                      <span className="step-mock-vs-text mono">VS</span>
                      <span className="step-mock-side" style={{ background: '#3a3a3c' }} />
                    </span>
                    <span className="step-mock-live">● 直播中</span>
                  </div>
                  <div className="step-mock step-mock-rank" aria-hidden>
                    <span className="step-mock-rank-item"><b>#1</b> 深蓝突袭者</span>
                    <span className="step-mock-rank-item muted">#2 疾风猎手</span>
                    <span className="step-mock-rank-item muted">#3 稳健老炮</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="section" id="matches-anchor">
            <div className="section-head">
              <h2>公开观战</h2>
              <p className="section-sub">选择一个游戏，观看正在进行的对战。</p>
            </div>
            {games.error != null && <ErrorBox error={games.error} />}
            {directory.length > 0 && <GameGrid games={directory} />}
            <div className="matches-sub">
              <h3 className="matches-sub-title">最近正式对局</h3>
              <AllMatches games={games.data ?? undefined} />
            </div>
          </section>

          <footer className="page-footer">
            <div className="page-footer-brand">AI 对战平台</div>
            <div className="page-footer-tag muted">用代码一决高下</div>
          </footer>
        </>
      ) : (
        <div className="home-dash">
          {/* 已登录视角：宽屏 dashboard 两列（ADR 0014），手机模式退化为单列 */}
          <div className="panel workspace-banner">
            <div>
              <h2 style={{ margin: '0 0 4px' }}>我的坦克</h2>
              <div className="small muted">创建参赛对象、发布策略、发起对战。</div>
            </div>
            <a className="btn primary" href={href('/workspace')}>
              进入我的坦克 →
            </a>
          </div>

          <div className="home-dash-main panel">
            <h2>我的游戏</h2>
            {games.loading && <Skeleton card rows={4} />}
            {games.error != null && <ErrorBox error={games.error} />}
            {directory.length > 0 && <GameGrid games={directory} />}
          </div>

          <div className="home-dash-matches panel">
            <h2>最近正式对局</h2>
            <AllMatches games={games.data ?? undefined} />
          </div>
        </div>
      )}
    </>
  );
}

/** 游戏卡片网格：卡片本体不整卡跳转，靠「进入 →」按钮，避免误触。 */
function GameGrid({ games }: { games: ReadonlyArray<{ id: string; name: string; pacing: string }> }): JSX.Element {
  if (games.length === 0) {
    return <EmptyState icon="🎮" text="暂无已开放游戏" hint="游戏开放后会出现在这里" />;
  }
  return (
    <div className="card-grid">
      {games.map((g) => (
        <div key={g.id} className="game-card">
          <div className="game-icon" aria-hidden>
            {gameIcon(g.id)}
          </div>
          <div className="game-name">{g.name}</div>
          <div className="game-meta">
            <span className="tag pacing">{PACING_LABEL[g.pacing] ?? g.pacing}</span>
            <span className="small muted mono"> {g.id}</span>
            {g.id === 'reversi' && <span className="tag exhibition">仅表演赛 · 不计分</span>}
          </div>
          <a className="btn ghost game-enter" href={href(`/game/${encodeURIComponent(g.id)}`)}>
            进入 →
          </a>
        </div>
      ))}
    </div>
  );
}

function AllMatches({ games }: { games?: ReadonlyArray<{ id: string; name?: string }> }): JSX.Element {
  const [page, setPage] = useState(1);
  const [gameId, setGameId] = useState('');
  // 只看正式对局：首页是公开观战入口，训练局多且不计数，浮在上面没意义
  const matches = useAsync(
    () => api.listMatches(gameId || undefined, page, 20, { kind: 'official' }),
    [page, gameId, api.getToken()],
  );
  const filter = games && games.length > 0 && (
    <div className="match-filter">
      <label className="field">
        游戏
        <select
          value={gameId}
          onChange={(e) => {
            setPage(1);
            setGameId(e.target.value);
          }}
        >
          <option value="">全部</option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name ?? g.id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  if (matches.loading) return <>{filter}<Skeleton rows={5} /></>;
  if (matches.error) return <>{filter}<ErrorBox error={matches.error} /></>;
  const list = matches.data?.matches ?? [];
  if (list.length === 0 && page === 1) {
    return <>{filter}<EmptyState icon="⚔️" text="暂无对局记录" hint="发起一场对局后会出现在这里" /></>;
  }
  const total = matches.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const safePage = Math.min(page, totalPages);
  return (
    <>
    {filter}
    <div className="matches-scroll">
    <div className="table-scroll">
    <table className="data">
      <thead>
        <tr>
          <th>对局</th>
          <th>游戏</th>
          <th>对战双方</th>
          <th>类型</th>
          <th>状态</th>
          <th>结果</th>
          <th>时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {list.map((m) => (
          <tr key={m.matchId}>
            <td>
              <span className="match-id">
                <span className="mono">{m.matchId.slice(0, 8)}</span>
                <CopyButton text={m.matchId} />
              </span>
            </td>
            <td>{m.gameId}</td>
            <td>
              <span className="versus">
                <span
                  className={
                    m.result?.outcome.kind === 'win' && m.result.outcome.winner === 0
                      ? 'versus-winner'
                      : undefined
                  }
                >
                  <EntrantName
                    name={m.entrants[0]?.name}
                    entrantId={m.entrants[0]?.entrantId}
                    userNickname={m.entrants[0]?.userNickname}
                  />
                </span>
                <span className="muted"> vs </span>
                <span
                  className={
                    m.result?.outcome.kind === 'win' && m.result.outcome.winner === 1
                      ? 'versus-winner'
                      : undefined
                  }
                >
                  <EntrantName
                    name={m.entrants[1]?.name}
                    entrantId={m.entrants[1]?.entrantId}
                    userNickname={m.entrants[1]?.userNickname}
                  />
                </span>
              </span>
            </td>
            <td>
              <MatchKindTag kind={m.kind} />
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
              <RelativeTime at={m.createdAt} />
            </td>
            <td>
              <a className="btn ghost small-btn" href={href(`/match/${encodeURIComponent(m.matchId)}`)}>
                观看
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
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
        {matches.data?.total !== undefined ? ` · 共 ${matches.data.total} 场` : ''}
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
  );
}
