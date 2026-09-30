import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { href } from '../router';
import { ErrorBox, formatTime, Loading, MatchPhaseTag, OutcomeTag, useAsync } from '../components';
import { renderTankFrame, TANK_SIDE_COLORS } from '../tank-renderer';
import { TankLegend } from '../components/TankReplayPlayer';
import { FrameSnapshot, isTankGameState, MatchResult, TankGameState } from '../types';

/**
 * 对局观看页：
 * - 先拉摘要（kind/phase/result）；
 * - tank 游戏 → canvas 逐帧渲染（official 用 SSE，training fetch 流式/轮询兜底）；
 * - 其他游戏 / 未知 state → JSON 文本展示；
 * - 结束后显示结果。
 */
export function MatchViewPage({ matchId }: { matchId: string }): JSX.Element {
  const summary = useAsync(() => api.getMatch(matchId), [matchId]);

  if (summary.loading) return <Loading text="加载对局…" />;
  if (summary.error) {
    return (
      <>
        <a className="back-link" href={href('/')}>
          ← 返回
        </a>
        <div className="panel">
          <ErrorBox error={summary.error} />
        </div>
      </>
    );
  }

  const match = summary.data;
  if (!match) return <div className="panel">对局不存在。</div>;

  return (
    <>
      <a className="back-link" href={href(`/game/${encodeURIComponent(match.gameId)}`)}>
        ← 返回游戏
      </a>
      <div className="panel">
        <h2 className="match-headline">对局 {match.matchId.slice(0, 8)}…</h2>
        <p className="small muted">
          游戏 {match.gameId} ·{' '}
          <span className={`tag ${match.kind}`}>{match.kind === 'official' ? '正式' : '训练'}</span>{' '}
          · 创建于 {formatTime(match.createdAt)}
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <MatchPhaseTag phase={match.phase} />
          {match.result && <OutcomeTag outcome={match.result.outcome} />}
          {match.result && (
            <span className="small muted">{match.result.outcome.reason}</span>
          )}
        </div>
      </div>

      {match.gameId === 'tank' ? (
        <TankLiveView matchId={matchId} kind={match.kind} phase={match.phase} result={match.result} />
      ) : (
        <GenericLiveView matchId={matchId} kind={match.kind} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- tank 直播

function TankLiveView({
  matchId,
  kind,
  phase,
  result,
}: {
  matchId: string;
  kind: 'official' | 'training';
  phase: string;
  result: MatchResult | null;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [latest, setLatest] = useState<FrameSnapshot | null>(null);
  const [ended, setEnded] = useState<MatchResult | null>(result);

  const draw = (frame: FrameSnapshot) => {
    setLatest(frame);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (isTankGameState(frame.state)) {
      renderTankFrame(ctx, frame.state);
    }
  };

  useEffect(() => {
    // 无论对局是否已结束都订阅：已结束时会一次性回放全部帧（LiveHub subscribe
    // 重放历史帧后立即回调 onEnd），实现回放效果。
    let closed = false;
    const handle = api.openFramesStream(
      matchId,
      kind,
      (frame) => {
        if (!closed) draw(frame);
      },
      (endResult) => {
        if (closed) return;
        setEnded(endResult ?? { outcome: { kind: 'invalid', reason: '对局已结束' } });
      },
    );
    return () => {
      closed = true;
      handle.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId, kind]);

  // 初始渲染空场（等首帧）
  useEffect(() => {
    if (latest) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderTankFrame(ctx, {
      tick: 0,
      arena: { width: 20, height: 15 },
      tanks: [
        { x: 2, y: 7, direction: 1, hp: 100, cooldown: 0 },
        { x: 17, y: 7, direction: 3, hp: 100, cooldown: 0 },
      ],
      bullets: [],
      walls: [],
      events: [],
    } satisfies TankGameState);
  }, [latest]);

  const state = latest && isTankGameState(latest.state) ? latest.state : null;

  return (
    <div className="panel">
      <h2>直播画面</h2>
      <div className="canvas-wrap">
        <canvas ref={canvasRef} className="arena" width={612} height={462} />
      </div>
      <TankLegend />
      <div className="hp-bars">
        {[0, 1].map((side) => {
          const tank = state?.tanks[side];
          const hp = tank ? Math.max(0, tank.hp) : 100;
          return (
            <div className="hp-bar" key={side}>
              <div className="hp-label">
                <span>
                  <span
                    className="entrant-swatch"
                    style={{ background: TANK_SIDE_COLORS[side], display: 'inline-block', marginRight: 6 }}
                  />
                  参赛方 {side}
                </span>
                <span>
                  HP {hp}
                  {tank ? ` · 冷却 ${tank.cooldown}` : ''}
                  {tank && typeof tank.stars === 'number' ? ` · ⭐×${tank.stars}` : ''}
                </span>
              </div>
              <div className="hp-track">
                <div
                  className="hp-fill"
                  style={{ width: `${hp}%`, background: TANK_SIDE_COLORS[side] }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="small muted">
        tick：{state ? state.tick : '—'} / 300{latest ? ` · 子弹 ${state ? state.bullets.length : 0}` : ''}
      </p>
      {ended && (
        <div className="message info">
          <strong>对局已结束。</strong>
          {ended.outcome.kind === 'win' && typeof ended.outcome.winner === 'number' && (
            <> 胜方：参赛方 {ended.outcome.winner}（{ended.outcome.reason}）</>
          )}
          {ended.outcome.kind === 'draw' && <> 平局（{ended.outcome.reason}）</>}
          {ended.outcome.kind === 'invalid' && <> 无效对局（{ended.outcome.reason}）</>}
          {ended.outcome.kind !== 'invalid' &&
            ended.failures &&
            ended.failures.length > 0 && (
              <div className="small">
                策略故障诊断（仅管理者视角）：{' '}
                {ended.failures.map((f) => `参赛方 ${f.entrant}: ${f.message}`).join('；')}
              </div>
            )}
        </div>
      )}
      {phase === 'running' && !ended && <p className="small muted">正在直播…</p>}
    </div>
  );
}

// ---------------------------------------------------------------- 其他游戏：JSON 展示

function GenericLiveView({ matchId, kind }: { matchId: string; kind: 'official' | 'training' }): JSX.Element {
  const [frames, setFrames] = useState<FrameSnapshot[]>([]);
  const [ended, setEnded] = useState<MatchResult | null>(null);

  useEffect(() => {
    let closed = false;
    const handle = api.openFramesStream(
      matchId,
      kind,
      (frame) => {
        if (closed) return;
        setFrames((prev) => [...prev, frame]);
      },
      (result) => {
        if (closed) return;
        setEnded(result);
      },
    );
    return () => {
      closed = true;
      handle.close();
    };
  }, [matchId, kind]);

  const last = frames.length > 0 ? frames[frames.length - 1] : null;

  return (
    <div className="panel">
      <h2>对局帧数据（该游戏暂无专用渲染器）</h2>
      {ended && (
        <div className="message info">
          对局已结束：{ended.outcome.kind}
          {ended.outcome.reason ? `（${ended.outcome.reason}）` : ''}
        </div>
      )}
      <p className="small muted">已接收 {frames.length} 帧{last ? `，当前 tick ${last.tick}` : ''}。</p>
      {last && (
        <pre className="code">{JSON.stringify(last.state, null, 2)}</pre>
      )}
    </div>
  );
}
