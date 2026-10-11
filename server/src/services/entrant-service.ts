/**
 * 参赛对象服务：用户内按配额创建参赛对象、API 令牌的颁发与吊销（ADR 0015/0016）。
 *
 * 外观 appearance 仅存储展示信息，不参与战斗（由界面层决定）。
 * SQLite 持久化（entrants / api_tokens 表）。
 */

import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SQLiteDatabase } from '../db/database.js';

/** 参赛对象外观：仅影响展示，不参与战斗。 */
export interface Appearance {
  preset: string;
  color: string;
  name: string;
  customImageUrl?: string;
}

export interface EntrantRecord {
  readonly id: string;
  readonly userId: string;
  readonly gameId: string;
  name: string;
  appearance: Appearance;
  readonly createdAt: number;
  /** 归档（删除）时间，null 表示在役。归档不可恢复。 */
  readonly archivedAt: number | null;
}

export interface CreateEntrantInput {
  gameId: string;
  name: string;
  appearance: Appearance;
}

export class EntrantQuotaExceededError extends Error {
  constructor(readonly userId: string, readonly quota: number) {
    super(`参赛对象配额已满（上限 ${quota}）`);
    this.name = 'EntrantQuotaExceededError';
  }
}

export interface EntrantServiceDeps {
  /** 每用户参赛对象配额，默认 10。 */
  defaultQuota?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface EntrantRow {
  id: string;
  user_id: string;
  game_id: string;
  name: string;
  appearance: string;
  created_at: number;
  archived_at: number | null;
}

export class EntrantService {
  private readonly db: SQLiteDatabase;
  private readonly quota: number;

  constructor(db: SQLiteDatabase, deps: EntrantServiceDeps = {}) {
    this.db = db;
    this.quota = deps.defaultQuota ?? 10;
  }

  private rowToRecord(row: EntrantRow): EntrantRecord {
    return {
      id: row.id,
      userId: row.user_id,
      gameId: row.game_id,
      name: row.name,
      appearance: JSON.parse(row.appearance) as Appearance,
      createdAt: row.created_at,
      archivedAt: row.archived_at ?? null,
    };
  }

  /** 在用户下创建参赛对象（受配额限制）。 */
  createEntrant(userId: string, input: CreateEntrantInput): EntrantRecord {
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM entrants WHERE user_id = ? AND archived_at IS NULL')
        .get(userId) as { n: number }
    ).n;
    if (count >= this.quota) {
      throw new EntrantQuotaExceededError(userId, this.quota);
    }
    const record: EntrantRecord = {
      id: randomUUID(),
      userId,
      gameId: input.gameId,
      name: input.name,
      appearance: input.appearance,
      createdAt: Date.now(),
      archivedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO entrants (id, user_id, game_id, name, appearance, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(record.id, userId, record.gameId, record.name, JSON.stringify(record.appearance), record.createdAt);
    return record;
  }

  /** 用户的在役参赛对象（已归档的不出现——列表、配额、匹配池共用此口径）。 */
  listByUser(userId: string): EntrantRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM entrants WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at')
      .all(userId) as EntrantRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * 用户的全集参赛对象（含已归档，按创建时间；管理端展开明细用）。
   */
  listAllByUser(userId: string): EntrantRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM entrants WHERE user_id = ? ORDER BY created_at')
      .all(userId) as EntrantRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * 按 ID 取参赛对象（**包含已归档的**）。
   *
   * 保留归档记录是为了历史对局/回放能继续解析出对局双方的名字；
   * 需要“只拿在役对象”的写操作与匹配池请用 getActive()。
   */
  get(entrantId: string): EntrantRecord | null {
    const row = this.db
      .prepare('SELECT * FROM entrants WHERE id = ?')
      .get(entrantId) as EntrantRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** 按 ID 取「在役」参赛对象；不存在或已归档都返回 null。写操作与匹配池用这个。 */
  getActive(entrantId: string): EntrantRecord | null {
    const record = this.get(entrantId);
    return record && record.archivedAt === null ? record : null;
  }

  /** 全部在役参赛对象（匹配池/管理统计用；已归档的不参与）。 */
  listAll(): EntrantRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM entrants WHERE archived_at IS NULL ORDER BY created_at')
      .all() as EntrantRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * 在役参赛对象数（配额口径，与 listByUser 同源：归档即释放名额）。
   * 不传 userId 即全平台。
   */
  countInService(userId?: string): number {
    return this.countWhere('archived_at IS NULL', userId);
  }

  /** 已归档（已删除）参赛对象数。不传 userId 即全平台。 */
  countArchived(userId?: string): number {
    return this.countWhere('archived_at IS NOT NULL', userId);
  }

  /** 两个计数共用一段口径，避开「在役」「已归档」各写一套查询而逐渐漂移。 */
  private countWhere(archivedClause: string, userId?: string): number {
    const row =
      userId === undefined
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM entrants WHERE ${archivedClause}`).get()
        : this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM entrants WHERE user_id = ? AND ${archivedClause}`,
            )
            .get(userId);
    return (row as { n: number }).n;
  }

  /**
   * 归档（删除）参赛对象，不可恢复。
   *
   * - 行保留（历史对局/回放要引用它，名字也要能解析）；
   * - 同时吊销该对象的全部凭证：归档即终止对 Agent 的委派，否则 Agent 还能继续提交策略；
   * - 已归档或不存在的对象返回 null（调用方转 404）。
   *
   * 调用方负责前置校验："有对局进行中"由路由层用 hasLiveMatch 拦下（409），
   * 它同时覆盖已落库的对局与调度器已受理、还在排队的对局。
   */
  archiveEntrant(entrantId: string): EntrantRecord | null {
    const record = this.get(entrantId);
    if (!record || record.archivedAt !== null) return null;
    const archivedAt = Date.now();
    this.db
      .prepare('UPDATE entrants SET archived_at = ? WHERE id = ?')
      .run(archivedAt, entrantId);
    this.revokeEntrantCredentials(entrantId);
    return { ...record, archivedAt };
  }

  /**
   * 为参赛对象颁发 API 令牌（委托外部 Agent 管理该对象时使用的凭据，ADR 0016）。
   * 哈希 + 明文本份都存库（哈希用于认证，明文供用户随时取回）；
   * 归属该对象所在用户。若该对象已有令牌，重新颁发会先吊销旧令牌（rotate）。
   */
  issueEntrantCredential(entrantId: string): string | null {
    // 已归档的对象不能再取得新令牌（归档即终止委派）。
    if (!this.getActive(entrantId)) return null;
    // rotate：旧的先失效
    this.revokeEntrantCredentials(entrantId);
    const token = nanoid(32);
    this.db
      .prepare('INSERT INTO api_tokens (hash, entrant_id, created_at, token) VALUES (?, ?, ?, ?)')
      .run(sha256(token), entrantId, Date.now(), token);
    return token;
  }

  /**
   * 取回该参赛对象当前活跃 API 令牌的明文。
   * 只有用户会话可调用（路由层已校验）；无活跃令牌返回 null（调用方转 404）。
   */
  getEntrantCredential(entrantId: string): string | null {
    const row = this.db
      .prepare('SELECT token FROM api_tokens WHERE entrant_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(entrantId) as { token: string | null } | undefined;
    return row?.token ?? null;
  }

  /** 是否已有活跃令牌（有则 UI 显示"已颁发，点击重新颁发"）。 */
  hasActiveCredential(entrantId: string): boolean {
    return (
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE entrant_id = ?')
          .get(entrantId) as { n: number }
      ).n > 0
    );
  }

  /** 吊销该参赛对象的全部 API 令牌。 */
  revokeEntrantCredentials(entrantId: string): void {
    this.db.prepare('DELETE FROM api_tokens WHERE entrant_id = ?').run(entrantId);
  }

  /** 由明文 API 令牌定位参赛对象；无效返回 null。 */
  findByCredential(token: string): { entrantId: string; userId: string } | null {
    const row = this.db
      .prepare(
        `SELECT e.id, e.user_id
         FROM api_tokens t JOIN entrants e ON e.id = t.entrant_id
         WHERE t.hash = ?`,
      )
      .get(sha256(token)) as { id: string; user_id: string } | undefined;
    if (!row) return null;
    return { entrantId: row.id, userId: row.user_id };
  }
}
