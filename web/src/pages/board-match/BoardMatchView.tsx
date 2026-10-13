import { useEffect, useMemo, useRef, useState } from 'react';
import { href } from '../../router';
import { isReversiState, MatchSummary } from '../../types';
import { initialReversiState } from '../../reversi-renderer';
import { gameName } from '../../game-labels';
import { MatchResultBanner } from '../../components/MatchResultBanner';
import { BoardCanvas, BoardGameId, capturedBySide, pieceChar, useBoardMatch } from './model';
import './board-match.css';

/** 棋类解说台：对阵、棋盘与棋谱分区展示，帧数不充当手数。 */
export function BoardMatchView({ match, gameId }: { match: MatchSummary; gameId: BoardGameId }): JSX.Element {
  const vm = useBoardMatch(match, gameId);
  // 黑白棋回放按原始帧保留 counts / lastFlipped / passedSide，不由手数奇偶重建。
  const timeline = useMemo(() => gameId === 'reversi' ? [initialReversiState(), ...vm.states] : [], [gameId, vm.states]);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const index = replayIndex === null ? timeline.length - 1 : Math.min(replayIndex, timeline.length - 1);
  const position = gameId === 'reversi' ? timeline[index] : vm.latest;
  const reversi = isReversiState(position) ? position : null;
  const visibleMoves = gameId === 'reversi' ? vm.moves.filter(move => move.no <= (position?.moveCount ?? 0)) : vm.moves;
  const seek = (next: number) => { setPlaying(false); setReplayIndex(next); };
  useEffect(() => {
    if (!playing) return;
    if (index >= timeline.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setReplayIndex(index + 1), 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, timeline.length, speed]);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [visibleMoves.length]);

  const lost = capturedBySide(vm.moves);
  const last = visibleMoves[visibleMoves.length - 1];
  const rounds = new Map<number, typeof vm.moves>();
  for (const move of gameId === 'reversi' ? [] : vm.moves) {
    const round = Math.ceil(move.no / 2);
    rounds.set(round, [...(rounds.get(round) ?? []), move]);
  }
  const winner = vm.ended?.outcome.kind === 'win' ? vm.ended.outcome.winner : null;
  const status = vm.ended || vm.match.phase === 'finished' || vm.match.phase === 'invalid'
    ? '已结束' : vm.paused ? '暂停中' : vm.match.phase === 'queued' ? '等待开局' : '直播中';
  const kindLabel = { exhibition: '表演赛', official: '正式对局', training: '训练' }[match.kind];
  const player = (side: 0 | 1) => {
    const active = vm.isLive && replayIndex === null && (position?.currentSide ?? 0) === side;
    const count = reversi ? reversi.counts[side] : position?.board.flat().filter(cell => typeof cell === 'number' ? cell === side : cell?.side === side).length;
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
            <div className="board-kicker">{gameName(gameId)} · {kindLabel}</div>
            <div className="board-status" role="status">{vm.isLive && <span className="board-live-dot" aria-hidden />}{status}</div>
            {player(1)}
            <div className="board-vs">VS</div>
            {player(0)}
            <div className="board-match-id" title={match.matchId}>对局 {match.matchId.slice(0, 8)}</div>
          </div>
          {vm.ended && <MatchResultBanner result={vm.ended} names={vm.names} colors={vm.colors} />}
        </aside>
        <div className="board-match-stage" aria-label="棋盘">
          <BoardCanvas gameId={gameId} state={gameId === 'reversi' && !vm.latest ? null : position} className="board-match-canvas" />
          <div className="board-stage-info">
            <p className="board-position-label">{vm.latest ? `第 ${position?.moveCount ?? 0} 手${replayIndex !== null ? ' · 回看' : ''}` : '等待首帧 · 开局示意'}</p>
            {reversi && <>
              <p className="board-position-label">金圈：本手落子 · 蓝框：本手翻转 {reversi.lastFlipped.length} 子 · 坐标 [列,行] 从 0 起</p>
              {reversi.passedSide !== null && <p className="board-pass" role="status">{vm.sideLabels[reversi.passedSide]}无合法落点，自动跳过；{vm.sideLabels[reversi.currentSide]}继续落子（不额外计手）</p>}
            </>}
            {gameId === 'reversi' && vm.states.length > 0 && <div aria-label="黑白棋回放控制">
              <div className="replay-timeline">
                <input type="range" className="replay-scrubber" min={0} max={timeline.length - 1} step={1} value={index}
                  aria-label="回放进度" onChange={e => seek(Number(e.target.value))} />
              </div>
              <div className="replay-controls">
                <button type="button" onClick={() => seek(0)} disabled={index === 0}>开局</button>
                <button type="button" onClick={() => seek(index - 1)} disabled={index === 0}>上一帧</button>
                <button type="button" className="primary" onClick={() => {
                  if (playing) setPlaying(false);
                  else { setReplayIndex(index >= timeline.length - 1 ? 0 : index); setPlaying(true); }
                }}>{playing ? '暂停' : index >= timeline.length - 1 ? '重播' : '播放'}</button>
                <button type="button" onClick={() => seek(index + 1)} disabled={index >= timeline.length - 1}>下一帧</button>
                <label className="small replay-speed">速度 <select value={speed} onChange={e => setSpeed(Number(e.target.value))}>
                  <option value={.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
                </select></label>
                <button type="button" onClick={() => { setPlaying(false); setReplayIndex(null); }}>{vm.ended ? '终局' : '最新局面'}</button>
              </div>
              <p className="board-position-label">帧 {index}/{timeline.length - 1} · 手数仅计成功落子，跳过与拒绝均不计手</p>
            </div>}
          </div>
        </div>
        <aside className="board-match-right" aria-label={gameId === 'reversi' ? '逐手棋谱与翻转记录' : '棋谱与吃子统计'}>
          <div className="board-card board-record">
            <h2 className="board-card-title">棋谱 <span>· {position?.moveCount ?? 0} 手</span></h2>
            {gameId === 'reversi'
              ? <div className="board-record-head reversi-record-row" aria-hidden><span>手数</span><span>行动方</span><span>落子 / 翻转</span></div>
              : <div className="board-record-head" aria-hidden><span>回合</span><span>{vm.sideLabels[0]}</span><span>{vm.sideLabels[1]}</span></div>}
            <div className="board-moves" ref={listRef} tabIndex={0} aria-label={gameId === 'reversi' ? '按真实手数顺序排列的棋谱' : '按回合排列的棋谱'}
              onScroll={() => {
                const list = listRef.current;
                if (list) followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
              }}>
              {!visibleMoves.length && <p className="small muted">尚无落子记录</p>}
              {gameId === 'reversi' && visibleMoves.map(move => (
                <div className="board-round reversi-record-row" key={move.no}>
                  <span className="board-round-no">{move.no}.</span>
                  <span>{vm.sideLabels[move.side]}</span>
                  <span className={move === last ? 'is-last' : undefined} aria-current={move === last ? 'step' : undefined}>
                    {move.text} · 翻 {move.flipped} 子
                    {move.passedSide != null && <small className="reversi-pass-record">{vm.sideLabels[move.passedSide]}跳过</small>}
                  </span>
                </div>
              ))}
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
