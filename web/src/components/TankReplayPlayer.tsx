import { useEffect, useRef, useState } from 'react';
import { renderTankFrame, TANK_SIDE_COLORS } from '../tank-renderer';
import { FrameSnapshot, isTankGameState } from '../types';

/**
 * 坦克回放播放器：以 frames[]（FrameSnapshot 数组）为数据源逐帧播放。
 * 供快速试跑面板使用（复用 v2 渲染器：地形/星星/气泡/徽章）。
 */

const DEFAULT_MS_PER_FRAME = 100;

export function TankLegend(): JSX.Element {
  return (
    <div className="tank-legend">
      {[
        { label: '墙', color: '#4b5563' },
        { label: '土堆（可摧毁）', color: '#c28e3c' },
        { label: '草（隐身）', color: 'rgba(74, 222, 128, 0.45)' },
        { label: '星星', color: '#fbbf24' },
      ].map((item) => (
        <span key={item.label} className="tank-legend-item">
          <span className="tank-legend-swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function TankReplayPlayer({
  frames,
  title = '回放',
}: {
  frames: ReadonlyArray<FrameSnapshot>;
  title?: string;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [msPerFrame, setMsPerFrame] = useState(DEFAULT_MS_PER_FRAME);

  // 只有一帧时无内容可播放：不进入播放态，避免“点了播放立刻又暂停”
  const playable = frames.length > 1;

  // 数据源更新时重置到开头并自动播放
  useEffect(() => {
    setIndex(0);
    setPlaying(playable);
  }, [frames, playable]);

  // 播放循环
  useEffect(() => {
    if (!playing || !playable) return;
    if (index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex((i) => Math.min(i + 1, frames.length - 1)), msPerFrame);
    return () => window.clearTimeout(timer);
  }, [playing, playable, index, frames, msPerFrame]);

  // 渲染当前帧
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const frame = frames[Math.min(index, frames.length - 1)];
    if (frame && isTankGameState(frame.state)) renderTankFrame(ctx, frame.state);
  }, [frames, index]);

  if (frames.length === 0) {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <p className="muted">无回放帧数据。</p>
      </div>
    );
  }

  const frame = frames[Math.min(index, frames.length - 1)];
  const state = frame && isTankGameState(frame.state) ? frame.state : null;
  const atEnd = index >= frames.length - 1;

  return (
    <div className="panel">
      <div className="replay-head">
        <h3>{title}</h3>
        <span className="small muted">
          tick {state ? state.tick : (frame?.tick ?? '—')} · 帧 {index + 1}/{frames.length}
        </span>
      </div>
      <div className="canvas-wrap">
        <canvas ref={canvasRef} className="arena" width={612} height={462} />
      </div>
      {playable ? (
        <div className="replay-controls">
          <button type="button" onClick={() => setIndex(0)} disabled={index === 0}>
            ⏮ 重置
          </button>
          <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
            ◀ 上一帧
          </button>
          <button
            className="primary"
            type="button"
            onClick={() => {
              if (atEnd) setIndex(0);
              setPlaying(atEnd ? true : (p) => !p);
            }}
          >
            {playing ? '⏸ 暂停' : atEnd ? '↺ 重播' : '▶ 播放'}
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))}
            disabled={atEnd}
          >
            下一帧 ▶
          </button>
          <label className="small muted replay-speed">
            速度
            <input
              type="range"
              min={40}
              max={400}
              step={20}
              value={440 - msPerFrame}
              onChange={(e) => setMsPerFrame(440 - Number(e.target.value))}
            />
          </label>
        </div>
      ) : (
        <p className="small muted">只有单帧快照，无需播放控制。</p>
      )}
      <TankLegend />
      {state && (
        <div className="hp-bars">
          {[0, 1].map((side) => {
            const tank = state.tanks[side];
            if (!tank) return null;
            const hp = Math.max(0, tank.hp);
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
                    {typeof tank.stars === 'number' ? ` · ⭐×${tank.stars}` : ''}
                  </span>
                </div>
                <div className="hp-track">
                  <div className="hp-fill" style={{ width: `${hp}%`, background: TANK_SIDE_COLORS[side] }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
