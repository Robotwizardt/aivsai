import { useEffect, useRef } from 'react';
import { href } from '../../router';
import { MatchSummary } from '../../types';
import { MatchResultBanner } from '../../components/MatchResultBanner';
import { BoardCanvas, BoardGameId, capturedBySide, pieceChar, useBoardMatch } from './model';
import './board-match.css';

/** 棋类解说台：对阵、棋盘与棋谱分区展示，帧数不充当手数。 */
export function BoardMatchView({ match, gameId }: { match: MatchSummary; gameId: BoardGameId }): JSX.Element {
  const vm = useBoardMatch(match, gameId);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [vm.moves.length]);

  const lost = capturedBySide(vm.moves);
  const last = vm.moves[vm.moves.length - 1];
  const rounds = new Map<number, typeof vm.moves>();
  for (const move of vm.moves) {
    const round = Math.ceil(move.no / 2);
    rounds.set(round, [...(rounds.get(round) ?? []), move]);
  }
  const winner = vm.ended?.outcome.kind === 'win' ? vm.ended.outcome.winner : null;
  const status = vm.ended || vm.match.phase === 'finished' || vm.match.phase === 'invalid'
    ? '已结束' : vm.match.phase === 'queued' ? '等待开局' : '直播中';
  const kindLabel = { exhibition: '表演赛', official: '正式对局', training: '训练' }[match.kind];
  const player = (side: 0 | 1) => {
    const active = vm.isLive && (vm.latest?.currentSide ?? 0) === side;
    const count = vm.latest?.board.flat().filter(cell => typeof cell === 'number' ? cell === side : cell?.side === side).length;
    return (
      <div className={`board-player${active ? ' is-active' : ''}`}>
        <div className="board-player-row">
          <span className="board-player-dot" style={{ background: vm.colors[side] }} aria-hidden />
          <span className="board-player-name" title={vm.names[side]}>{vm.names[side]}</span>
          {winner === side && <span className="board-win-badge">胜</span>}
        </div>
        <div className="board-player-sub">{vm.sideLabels[side]}{count !== undefined ? ` · ${gameId === 'xiangqi' ? '剩 ' : ''}${count} 子` : ''}</div>
        {active && <div className="board-turn">轮到落子</div>}
      </div>
    );
  };

  return (
    <section className="board-match" aria-label="棋类观战解说台">
      <a className="back-link" href={href(match.kind === 'exhibition' ? '/live' : `/game/${gameId}`)}>
        ← {match.kind === 'exhibition' ? '直播大厅' : '返回游戏'}
      </a>
      <div className="board-match-grid">
        <aside className="board-match-left" aria-label="对阵与结果">
          <div className="board-card">
            <div className="board-kicker">{gameId === 'xiangqi' ? '中国象棋' : '五子棋'} · {kindLabel}</div>
            <div className="board-status" role="status">{vm.isLive && <span className="board-live-dot" aria-hidden />}{status}</div>
            {player(1)}
            <div className="board-vs">VS</div>
            {player(0)}
            <div className="board-match-id" title={match.matchId}>对局 {match.matchId.slice(0, 8)}</div>
          </div>
          {vm.ended && <MatchResultBanner result={vm.ended} names={vm.names} colors={vm.colors} />}
        </aside>
        <div className="board-match-stage" aria-label="棋盘">
          <BoardCanvas gameId={gameId} state={vm.latest} className="board-match-canvas" />
          <p className="board-position-label">{vm.latest ? `第 ${vm.latest.moveCount} 手` : '等待首帧 · 开局示意'}</p>
        </div>
        <aside className="board-match-right" aria-label="棋谱与吃子统计">
          <div className="board-card board-record">
            <h2 className="board-card-title">棋谱 <span>· {vm.latest?.moveCount ?? 0} 手</span></h2>
            <div className="board-record-head" aria-hidden><span>回合</span><span>{vm.sideLabels[0]}</span><span>{vm.sideLabels[1]}</span></div>
            <div className="board-moves" ref={listRef} tabIndex={0} aria-label="按回合排列的棋谱"
              onScroll={() => {
                const list = listRef.current;
                if (list) followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
              }}>
              {!vm.moves.length && <p className="small muted">尚无落子记录</p>}
              {Array.from(rounds, ([round, moves]) => (
                <div className="board-round" key={round}>
                  <span className="board-round-no">{round}.</span>
                  {([0, 1] as const).map(side => {
                    const move = moves.find(item => item.side === side);
                    return <span key={side} className={move && move === last ? 'is-last' : undefined} aria-current={move && move === last ? 'step' : undefined}>{move?.text ?? '—'}</span>;
                  })}
                </div>
              ))}
            </div>
          </div>
          {gameId === 'xiangqi' && <div className="board-card">
            <h2 className="board-card-title">吃子</h2>
            {([0, 1] as const).map(side => (
              <div className="board-captures" key={side}>
                <span className="board-capture-label">{vm.sideLabels[side]}吃</span>
                {!lost[side === 0 ? 1 : 0].length && <span className="muted small">—</span>}
                {lost[side === 0 ? 1 : 0].map((piece, index) => <span className={`board-captured-piece side-${piece.side}`} key={index}>{pieceChar(piece)}</span>)}
              </div>
            ))}
          </div>}
        </aside>
      </div>
    </section>
  );
}
