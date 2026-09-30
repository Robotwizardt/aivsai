/**
 * 对局记录内存存储（ADR 0003：直播帧流与回放记录）。
 *
 * 单进程内存实现；持久化由后续版本替换，接口保持不变。
 */

import type { FrameSnapshot, MatchResult } from '../games/contracts.js';
import type { MatchRecord } from './match-contracts.js';

/** 创建对局记录所需字段（create 时即锁定双方策略版本，见 ADR 0004）。 */
export interface CreateMatchInput {
  readonly matchId: string;
  readonly gameId: string;
  /** 未提供时默认取 gameId（当前游戏包尚无独立版本 ID，见 ADR 0004 实施注记）。 */
  readonly gameVersionId?: string;
  readonly entrants: readonly [
    { entrantId: string; strategyVersionId: string },
    { entrantId: string; strategyVersionId: string },
  ];
  readonly kind: 'official' | 'training';
}

/** 列表查询过滤条件。 */
export interface ListMatchFilter {
  readonly gameId?: string;
}

/** 对局摘要：不含 frames（列表页不需要完整过程）。 */
export interface MatchSummary {
  readonly matchId: string;
  readonly gameId: string;
  readonly gameVersionId: string;
  readonly entrants: MatchRecord['entrants'];
  readonly kind: 'official' | 'training';
  readonly createdAt: number;
  readonly phase: MatchRecord['phase'];
  readonly frameCount: number;
  readonly result: MatchResult | null;
}

/** 对局记录存储接口——MatchRunner 依赖此抽象而非具体实现。 */
export interface MatchStore {
  create(input: CreateMatchInput): MatchRecord;
  get(id: string): MatchRecord | undefined;
  updateFrame(id: string, frame: FrameSnapshot): void;
  finish(id: string, result: MatchResult, phase: 'finished' | 'invalid'): void;
  list(filter?: ListMatchFilter): MatchSummary[];
}

/** 内存实现：Map<matchId, MatchRecord>。单线程事件循环内使用，无需加锁。 */
export class InMemoryMatchStore implements MatchStore {
  private readonly records = new Map<string, MatchRecord>();

  create(input: CreateMatchInput): MatchRecord {
    if (this.records.has(input.matchId)) {
      throw new Error(`对局已存在: ${input.matchId}`);
    }
    const record: MatchRecord = {
      matchId: input.matchId,
      gameId: input.gameId,
      gameVersionId: input.gameVersionId ?? input.gameId,
      entrants: [
        { ...input.entrants[0] },
        { ...input.entrants[1] },
      ],
      kind: input.kind,
      createdAt: Date.now(),
      // runner 创建后立即开始执行，直接进入 running（queued 由调度层语义承担）。
      phase: 'running',
      frames: [],
      result: null,
    };
    this.records.set(record.matchId, record);
    return record;
  }

  get(id: string): MatchRecord | undefined {
    return this.records.get(id);
  }

  updateFrame(id: string, frame: FrameSnapshot): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`对局不存在: ${id}`);
    record.frames.push(frame);
  }

  finish(id: string, result: MatchResult, phase: 'finished' | 'invalid'): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`对局不存在: ${id}`);
    record.result = result;
    record.phase = phase;
  }

  list(filter?: ListMatchFilter): MatchSummary[] {
    const out: MatchSummary[] = [];
    for (const r of this.records.values()) {
      if (filter?.gameId !== undefined && r.gameId !== filter.gameId) continue;
      out.push({
        matchId: r.matchId,
        gameId: r.gameId,
        gameVersionId: r.gameVersionId,
        entrants: r.entrants,
        kind: r.kind,
        createdAt: r.createdAt,
        phase: r.phase,
        frameCount: r.frames.length,
        result: r.result,
      });
    }
    return out;
  }
}
