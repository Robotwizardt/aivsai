import * as api from '../api';
import { href } from '../router';
import { ErrorBox, formatTime, Loading, MatchPhaseTag, OutcomeTag, useAsync } from '../components';

const PACING_LABEL: Record<string, string> = {
  instant: '即时制',
  'turn-based': '回合制',
};

export function GameDetailPage({ gameId }: { gameId: string }): JSX.Element {
  const games = useAsync(() => api.listGames(), [gameId]);
  const board = useAsync(() => api.getLeaderboard(gameId), [gameId]);
  const matches = useAsync(() => api.listMatches(gameId), [gameId]);

  const game = games.data?.find((g) => g.id === gameId);

  return (
    <>
      <a className="back-link" href={href('/')}>
        ← 返回游戏列表
      </a>

      <div className="panel">
        <h2>{game ? game.name : gameId}</h2>
        <p className="small muted">
          ID：{gameId}
          {game ? ` · ${PACING_LABEL[game.pacing] ?? game.pacing}` : ''}
        </p>
      </div>

      <div className="panel">
        <h2>排行榜</h2>
        {board.loading && <Loading />}
        {board.error != null && <ErrorBox error={board.error} />}
        {board.data &&
          (board.data.entries.length === 0 ? (
            <p className="muted">暂无排名（需要有已计分的正式对局）。</p>
          ) : (
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
                    <td>{i + 1}</td>
                    <td className="mono">{entry.entrantId}</td>
                    <td>{Math.round(entry.score)}</td>
                    <td>{entry.wins}</td>
                    <td>{entry.losses}</td>
                    <td>{entry.draws}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>

      <div className="panel">
        <h2>该游戏的对局</h2>
        {matches.loading && <Loading />}
        {matches.error != null && <ErrorBox error={matches.error} />}
        {matches.data &&
          (matches.data.length === 0 ? (
            <p className="muted">暂无对局。</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>对局</th>
                  <th>类型</th>
                  <th>创建时间</th>
                  <th>状态</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {matches.data.map((m) => (
                  <tr key={m.matchId}>
                    <td>
                      <a href={href(`/match/${encodeURIComponent(m.matchId)}`)} className="mono">
                        {m.matchId.slice(0, 8)}…
                      </a>
                    </td>
                    <td>
                      <span className={`tag ${m.kind}`}>{m.kind === 'official' ? '正式' : '训练'}</span>
                    </td>
                    <td className="small">{formatTime(m.createdAt)}</td>
                    <td>
                      <MatchPhaseTag phase={m.phase} />
                    </td>
                    <td>
                      <OutcomeTag outcome={m.result ? m.result.outcome : null} />
                      {m.result && m.result.outcome.kind !== 'invalid' && (
                        <div className="small muted">{m.result.outcome.reason}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </>
  );
}
