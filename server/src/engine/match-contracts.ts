/**
 * 对局记录契约：直播帧流与回放（ADR 0003 / 0004）。
 * 回放播放已记录的帧，不重新运行策略。
 */

import type { FrameSnapshot, MatchResult } from '../games/contracts.js';

export type MatchPhase = 'queued' | 'running' | 'finished' | 'invalid';

export interface MatchRecord {
  readonly matchId: string;
  readonly gameId: string;
  readonly gameVersionId: string;
  /** 双方参赛对象 ID 与创建时锁定的策略版本（ADR 0004）。 */
  readonly entrants: readonly [
    { entrantId: string; strategyVersionId: string },
    { entrantId: string; strategyVersionId: string },
  ];
  readonly kind: 'official' | 'training';
  readonly createdAt: number;
  phase: MatchPhase;
  frames: FrameSnapshot[];
  result: MatchResult | null;
}

/** 直播订阅：推送到目前为止的帧，之后增量推送。 */
export interface LiveFeed {
  /** 从 fromTick 起的历史帧（追进度用）。 */
  framesFrom(fromTick: number): FrameSnapshot[];
  /** 订阅增量帧与结束信号；返回取消函数。 */
  subscribe(
    onFrame: (frame: FrameSnapshot) => void,
    onEnd: (result: MatchResult | null) => void,
  ): () => void;
}
