/**
 * 表演赛存储（ADR 0017）：exhibitions + seat_keys 两张表，SQLite 持久化。
 *
 * - 座位密钥明文存库（nanoid）：用途就是内嵌在座位链接里复制给外部 AI，
 *   与 API 令牌同样的取回语义（ADR 0016 的沿用）；
 * - 对局结束/作废后密钥行删除——「一次性密钥，对局结束即失效」由行存在性保证；
 * - 限额（每用户 3 / 全站 30）在创建时检查，口径 = 未结束且未作废。
 */

import { nanoid } from 'nanoid';
import type { SQLiteDatabase } from '../db/database.js';
import {
  DEFAULT_PER_MOVE_TIMEOUT_MS,
  PER_USER_ACTIVE_LIMIT,
  SITE_WIDE_ACTIVE_LIMIT,
  exhibitionIsActive,
  type ExhibitionRecord,
  type SeatKeyRecord,
  type SeatPrincipal,
} from './exhibition-contracts.js';

export interface CreateExhibitionInput {
  readonly gameId: string;
  readonly creatorUserId: string;
  /** 展示标题；缺省自动生成（含对局短 id）。 */
  readonly title?: string;
  /** 每步时限（毫秒）；缺省 30 分钟。 */
  readonly perMoveTimeoutMs?: number;
  /** 公开（进直播大厅）/ 私密（凭链接观战）；默认公开。 */
  readonly isPublic?: boolean;
}

interface ExhibitionRow {
  id: string;
  game_id: string;
  creator_user_id: string;
  title: string;
  per_move_timeout_ms: number;
  is_public: number;
  seat_name_0: string | null;
  seat_name_1: string | null;
  paused: number;
  voided_at: number | null;
  created_at: number;
  finished_at: number | null;
}

interface SeatKeyRow {
  key: string;
  match_id: string;
  side: number;
  created_at: number;
}

/** 座位名称长度上限（自报名称防刷屏）。 */
const SEAT_NAME_MAX = 64;

export class ExhibitionStore {
  private readonly db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  private rowToRecord(row: ExhibitionRow): ExhibitionRecord {
    return {
      matchId: row.id,
      gameId: row.game_id,
      creatorUserId: row.creator_user_id,
      title: row.title,
      perMoveTimeoutMs: row.per_move_timeout_ms,
      isPublic: row.is_public === 1,
      seatNames: [row.seat_name_0, row.seat_name_1],
      paused: row.paused === 1,
      voidedAt: row.voided_at,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  /**
   * 创建表演赛：校验双限额 → 落库 → 生成两把座位密钥。
   * 限额超限时抛 Error（路由层转 429）。
   */
  create(input: CreateExhibitionInput): ExhibitionRecord {
    const now = Date.now();
    const mine = this.countActiveByUser(input.creatorUserId);
    if (mine >= PER_USER_ACTIVE_LIMIT) {
      throw new Error(`每用户同时最多 ${PER_USER_ACTIVE_LIMIT} 场未结束表演赛`);
    }
    if (this.countActive() >= SITE_WIDE_ACTIVE_LIMIT) {
      throw new Error(`全站同时最多 ${SITE_WIDE_ACTIVE_LIMIT} 场未结束表演赛`);
    }

    const matchId = nanoid(16);
    const title =
      input.title !== undefined && input.title.trim() !== ''
        ? input.title.trim().slice(0, 100)
        : `表演赛 ${matchId.slice(0, 6)}`;
    const record: ExhibitionRecord = {
      matchId,
      gameId: input.gameId,
      creatorUserId: input.creatorUserId,
      title,
      perMoveTimeoutMs: input.perMoveTimeoutMs ?? DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: input.isPublic ?? true,
      seatNames: [null, null],
      paused: false,
      voidedAt: null,
      createdAt: now,
      finishedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO exhibitions
         (id, game_id, creator_user_id, title, per_move_timeout_ms, is_public,
          seat_name_0, seat_name_1, paused, voided_at, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, NULL)`,
      )
      .run(
        record.matchId,
        record.gameId,
        record.creatorUserId,
        record.title,
        record.perMoveTimeoutMs,
        record.isPublic ? 1 : 0,
        record.createdAt,
      );

    const insertKey = this.db.prepare(
      'INSERT INTO seat_keys (key, match_id, side, created_at) VALUES (?, ?, ?, ?)',
    );
    for (const side of [0, 1] as const) {
      insertKey.run(nanoid(32), record.matchId, side, now);
    }
    return record;
  }

  get(matchId: string): ExhibitionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM exhibitions WHERE id = ?')
      .get(matchId) as ExhibitionRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** 座位密钥列表（创建者/管理员查看座位链接用）。对局结束后依然可查（观察期）。 */
  listSeatKeys(matchId: string): SeatKeyRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM seat_keys WHERE match_id = ? ORDER BY side')
      .all(matchId) as SeatKeyRow[];
    return rows.map((r) => ({
      key: r.key,
      matchId: r.match_id,
      side: r.side === 1 ? 1 : 0,
      createdAt: r.created_at,
    }));
  }

  /** 明文座位密钥 → 认证主体；密钥无效返回 null（结束后仍在，见 finish 注释）。 */
  authenticateSeat(key: string): SeatPrincipal | null {
    const row = this.db
      .prepare('SELECT match_id, side FROM seat_keys WHERE key = ?')
      .get(key) as { match_id: string; side: number } | undefined;
    if (!row) return null;
    return { matchId: row.match_id, side: row.side === 1 ? 1 : 0 };
  }

  /**
   * 结束表演赛：置 finishedAt。幂等（已结束返回 false）。
   *
   * ADR 0017：座位密钥不随对局结束删除，而是进入「观察期」——结束后
   * observe 仍能凭原密钥拿到 finished + 终局信息，外部 AI 才能自己收摊；
   * 作废同理（observe 得 finished + hint）。密钥只在 exhibitions 行本身不存在时失效。
   * 结束后 act 由服务层拦为 409「对局已结束」，不是 401。
   */
  finish(matchId: string): boolean {
    const changed = this.db
      .prepare('UPDATE exhibitions SET finished_at = ? WHERE id = ? AND finished_at IS NULL AND voided_at IS NULL')
      .run(Date.now(), matchId).changes;
    return changed > 0;
  }

  /** 作废表演赛（1 小时无第一手 / 创建者解散）：同 finish 语义但语义为「作废」。 */
  void(matchId: string): boolean {
    const changed = this.db
      .prepare('UPDATE exhibitions SET voided_at = ? WHERE id = ? AND finished_at IS NULL AND voided_at IS NULL')
      .run(Date.now(), matchId).changes;
    return changed > 0;
  }

  /** 暂停/恢复；对局不存在或已结束返回 false。 */
  setPaused(matchId: string, paused: boolean): boolean {
    return (
      this.db
        .prepare(
          'UPDATE exhibitions SET paused = ? WHERE id = ? AND finished_at IS NULL AND voided_at IS NULL',
        )
        .run(paused ? 1 : 0, matchId).changes > 0
    );
  }

  /** 座位自报名称（ADR 0017：AI 首手可自报，如 DeepSeek-R1）。 */
  setSeatName(matchId: string, side: 0 | 1, name: string): boolean {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > SEAT_NAME_MAX) return false;
    const column = side === 0 ? 'seat_name_0' : 'seat_name_1';
    const changed = this.db
      .prepare(
        `UPDATE exhibitions SET ${column} = ? WHERE id = ? AND finished_at IS NULL AND voided_at IS NULL`,
      )
      .run(trimmed, matchId).changes;
    return changed > 0;
  }

  /** 公开表演赛列表（直播大厅；最新在前）。 */
  listPublic(): ExhibitionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM exhibitions WHERE is_public = 1 AND finished_at IS NULL AND voided_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all() as ExhibitionRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 全量列表（管理端，含私密与已结束）。 */
  listAll(): ExhibitionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM exhibitions ORDER BY created_at DESC')
      .all() as ExhibitionRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 按创建者过滤（我的表演赛；含私密与已结束）。 */
  listByCreator(userId: string): ExhibitionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM exhibitions WHERE creator_user_id = ? ORDER BY created_at DESC')
      .all(userId) as ExhibitionRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /** 全站活跃（未结束未作废）计数。 */
  countActive(): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM exhibitions WHERE finished_at IS NULL AND voided_at IS NULL')
        .get() as { n: number }
    ).n;
  }

  /** 用户活跃计数（限额口径）。 */
  countActiveByUser(userId: string): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM exhibitions WHERE creator_user_id = ? AND finished_at IS NULL AND voided_at IS NULL',
        )
        .get(userId) as { n: number }
    ).n;
  }
}
