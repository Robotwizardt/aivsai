/**
 * 对局记录存储（ADR 0003：直播帧流与回放记录）。
 *
 * SQLite 持久化实现：matches 表（frames/result/entrants 存 JSON 字符串）。
 * 正在进行的对局在内存中维护 frames 数组（保证 get 返回稳定引用、
 * 直播订阅读到最新帧），同时逐帧同步落库；已结束对局直接从 DB 读取。
 */

import type { FrameSnapshot, MatchResult } from '../games/contracts.js';
import type { SQLiteDatabase } from '../db/database.js';
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
  /** 对局类型：只看正式（official）或训练（training）。 */
  readonly kind?: 'official' | 'training';
  /** 只看某个参赛对象参与的对局（含 bot:xxx）。 */
  readonly entrantId?: string;
  /** 分页：返回第 limit 条起的 offset 条（SQL 语义）。 */
  readonly limit?: number;
  readonly offset?: number;
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

interface MatchRow {
  id: string;
  game_id: string;
  game_version_id: string;
  kind: string;
  phase: string;
  entrants: string;
  result: string | null;
  frames: string;
  created_at: number;
}

/**
 * SQLite 实现。
 *
 * - running：内存缓存可变 MatchRecord（get 返回同一对象引用，MatchRunner 依赖
 *   此语义：updateFrame/finish 直接改该对象），同时逐帧同步落库；
 * - finished/invalid：从内存缓存移除，读取直接走 DB。
 */
export class SQLiteMatchStore implements MatchStore {
  private readonly db: SQLiteDatabase;
  /** 进行中对局的可变记录缓存（与内存实现同语义：create 返回的对象即运行期真源）。 */
  private readonly active = new Map<string, MatchRecord>();

  constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  private rowToRecord(row: MatchRow): MatchRecord {
    return {
      matchId: row.id,
      gameId: row.game_id,
      gameVersionId: row.game_version_id,
      entrants: JSON.parse(row.entrants) as MatchRecord['entrants'],
      kind: row.kind as MatchRecord['kind'],
      createdAt: row.created_at,
      phase: row.phase as MatchRecord['phase'],
      frames: JSON.parse(row.frames) as FrameSnapshot[],
      result: row.result ? (JSON.parse(row.result) as MatchResult) : null,
    };
  }

  create(input: CreateMatchInput): MatchRecord {
    const existing = this.db
      .prepare('SELECT 1 FROM matches WHERE id = ?')
      .get(input.matchId);
    if (existing) {
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
    this.db
      .prepare(
        `INSERT INTO matches (id, game_id, game_version_id, kind, phase, entrants, result, frames, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, NULL, '[]', ?)`,
      )
      .run(
        record.matchId,
        record.gameId,
        record.gameVersionId,
        record.kind,
        JSON.stringify(record.entrants),
        record.createdAt,
      );
    this.active.set(record.matchId, record);
    return record;
  }

  get(id: string): MatchRecord | undefined {
    const active = this.active.get(id);
    if (active) return active;
    const row = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as
      | MatchRow
      | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  updateFrame(id: string, frame: FrameSnapshot): void {
    const record = this.active.get(id);
    if (!record) {
      if (!this.db.prepare('SELECT 1 FROM matches WHERE id = ?').get(id)) {
        throw new Error(`对局不存在: ${id}`);
      }
      throw new Error(`对局已结束，无法追加帧: ${id}`);
    }
    record.frames.push(frame);
    this.db
      .prepare('UPDATE matches SET frames = ? WHERE id = ?')
      .run(JSON.stringify(record.frames), id);
  }

  finish(id: string, result: MatchResult, phase: 'finished' | 'invalid'): void {
    const record = this.active.get(id);
    if (!record) {
      if (!this.db.prepare('SELECT 1 FROM matches WHERE id = ?').get(id)) {
        throw new Error(`对局不存在: ${id}`);
      }
      throw new Error(`对局已结束，无法重复结束: ${id}`);
    }
    record.result = result;
    record.phase = phase;
    this.db
      .prepare('UPDATE matches SET phase = ?, result = ?, frames = ? WHERE id = ?')
      .run(phase, JSON.stringify(result), JSON.stringify(record.frames), id);
    this.active.delete(id);
  }

  list(filter?: ListMatchFilter): MatchSummary[] {
    // 最新在前（列表页直觉：新对局排最上面）；分页由调用方传 limit/offset。
    const limit = filter?.limit !== undefined && Number.isFinite(filter.limit) && filter.limit >= 0
      ? ` LIMIT ${Math.floor(filter.limit)}`
      : '';
    const offset =
      filter?.offset !== undefined && Number.isFinite(filter.offset) && filter.offset > 0
        ? ` OFFSET ${Math.floor(filter.offset)}`
        : '';
    // 动态拼 WHERE：gameId / kind / entrantId（JSON 串 LIKE 匹配，参赛对象 ID 是 UUID 不含 %，安全）
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.gameId !== undefined) {
      where.push('game_id = ?');
      params.push(filter.gameId);
    }
    if (filter?.kind === 'official' || filter?.kind === 'training') {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter?.entrantId !== undefined) {
      where.push("entrants LIKE '%\"' || ? || '\"%'");
      params.push(filter.entrantId);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM matches${whereSql} ORDER BY created_at DESC${limit}${offset}`)
      .all(...params) as MatchRow[];
    return rows.map((r) => ({
      matchId: r.id,
      gameId: r.game_id,
      gameVersionId: r.game_version_id,
      entrants: JSON.parse(r.entrants) as MatchRecord['entrants'],
      kind: r.kind as MatchRecord['kind'],
      createdAt: r.created_at,
      phase: r.phase as MatchRecord['phase'],
      frameCount: (this.active.get(r.id)?.frames ?? (JSON.parse(r.frames) as FrameSnapshot[]))
        .length,
      result: r.result ? (JSON.parse(r.result) as MatchResult) : null,
    }));
  }

  /** 总条数（分页用）。 */
  count(filter?: { gameId?: string; kind?: 'official' | 'training'; entrantId?: string }): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.gameId !== undefined) {
      where.push('game_id = ?');
      params.push(filter.gameId);
    }
    if (filter?.kind === 'official' || filter?.kind === 'training') {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter?.entrantId !== undefined) {
      where.push("entrants LIKE '%\"' || ? || '\"%'");
      params.push(filter.entrantId);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM matches${whereSql}`)
      .get(...params) as { n: number };
    return row.n;
  }
}

/**
 * 该参赛对象是否有未结束（queued/running）的对局。
 *
 * 用 MatchStore 的公开 list（最新在前）判断，不依赖具体实现：未结束的对局必然是
 * 最新的若干条，取前 100 条足以覆盖（列表页入参上限同量级）。
 */
export function matchStoreHasLiveMatch(store: MatchStore, entrantId: string): boolean {
  return store
    .list({ entrantId, limit: 100 })
    .some((m) => m.phase === 'queued' || m.phase === 'running');
}

/** 兼容别名：历史名称（内存实现已由 SQLite 实现替代）。 */
export { SQLiteMatchStore as InMemoryMatchStore };
