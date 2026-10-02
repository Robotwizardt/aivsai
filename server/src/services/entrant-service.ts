/**
 * 参赛对象服务：工作台内按配额创建参赛对象、对象凭证的颁发与吊销（ADR 0002）。
 *
 * 外观 appearance 仅存储展示信息，不参与战斗（由界面层决定）。
 * SQLite 持久化（entrants / credentials 表）。
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
  readonly workspaceId: string;
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
  constructor(readonly workspaceId: string, readonly quota: number) {
    super(`参赛对象配额已满（上限 ${quota}）`);
    this.name = 'EntrantQuotaExceededError';
  }
}

export interface EntrantServiceDeps {
  /** 每工作台参赛对象配额，默认 10。 */
  defaultQuota?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface EntrantRow {
  id: string;
  workspace_id: string;
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
      workspaceId: row.workspace_id,
      gameId: row.game_id,
      name: row.name,
      appearance: JSON.parse(row.appearance) as Appearance,
      createdAt: row.created_at,
      archivedAt: row.archived_at ?? null,
    };
  }

  /** 在工作台下创建参赛对象（受配额限制）。 */
  createEntrant(workspaceId: string, input: CreateEntrantInput): EntrantRecord {
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM entrants WHERE workspace_id = ? AND archived_at IS NULL')
        .get(workspaceId) as { n: number }
    ).n;
    if (count >= this.quota) {
      throw new EntrantQuotaExceededError(workspaceId, this.quota);
    }
    const record: EntrantRecord = {
      id: randomUUID(),
      workspaceId,
      gameId: input.gameId,
      name: input.name,
      appearance: input.appearance,
      createdAt: Date.now(),
      archivedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO entrants (id, workspace_id, game_id, name, appearance, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(record.id, workspaceId, record.gameId, record.name, JSON.stringify(record.appearance), record.createdAt);
    return record;
  }

  /** 工作台的在役参赛对象（已归档的不出现——列表、配额、匹配池共用此口径）。 */
  listByWorkspace(workspaceId: string): EntrantRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM entrants WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at')
      .all(workspaceId) as EntrantRow[];
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

  /** 工作台在役参赛对象数（配额口径；归档即释放名额）。 */
  countByWorkspace(workspaceId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM entrants WHERE workspace_id = ? AND archived_at IS NULL')
        .get(workspaceId) as { n: number }
    ).n;
  }

  /**
   * 归档（删除）参赛对象，不可恢复。
   *
   * - 行保留（历史对局/回放要引用它，名字也要能解析）；
   * - 同时吊销该对象的全部凭证：归档即终止对 Agent 的委派，否则 Agent 还能继续提交策略；
   * - 已归档或不存在的对象返回 null（调用方转 404）。
   *
   * 调用方负责前置校验："有对局进行中"由路由层用 matchStoreHasLiveMatch 拦下（409）。
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
   * 为参赛对象颁发对象凭证（委托外部 Agent 管理该对象时使用的凭据）。
   * 明文只返回一次，存储层仅保留哈希；归属该对象所在工作台。
   * 若该对象已有凭证，重新颁发会先吊销旧凭证（rotate）。
   */
  issueEntrantCredential(entrantId: string): string | null {
    // 已归档的对象不能再取得新凭证（归档即终止委派）。
    if (!this.getActive(entrantId)) return null;
    // rotate：旧的先失效
    this.revokeEntrantCredentials(entrantId);
    const token = nanoid(32);
    this.db
      .prepare("INSERT INTO credentials (hash, kind, owner_id, created_at) VALUES (?, 'entrant', ?, ?)")
      .run(sha256(token), entrantId, Date.now());
    return token;
  }

  /** 是否已有活跃凭证（有则 UI 显示"已颁发，点击重新颁发"）。 */
  hasActiveCredential(entrantId: string): boolean {
    return (
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM credentials WHERE kind = 'entrant' AND owner_id = ?")
          .get(entrantId) as { n: number }
      ).n > 0
    );
  }

  /** 吊销该参赛对象的全部对象凭证。 */
  revokeEntrantCredentials(entrantId: string): void {
    this.db
      .prepare("DELETE FROM credentials WHERE kind = 'entrant' AND owner_id = ?")
      .run(entrantId);
  }

  /** 工作台凭证恢复时联动吊销（ADR 0002）：作废该工作台下全部对象凭证。 */
  revokeAllForWorkspace(workspaceId: string): void {
    this.db
      .prepare(
        `DELETE FROM credentials WHERE kind = 'entrant' AND owner_id IN
         (SELECT id FROM entrants WHERE workspace_id = ?)`,
      )
      .run(workspaceId);
  }

  /** 由明文对象凭证定位参赛对象；无效返回 null。 */
  findByCredential(token: string): { entrantId: string; workspaceId: string } | null {
    const row = this.db
      .prepare(
        `SELECT e.id, e.workspace_id
         FROM credentials c JOIN entrants e ON e.id = c.owner_id
         WHERE c.hash = ? AND c.kind = 'entrant'`,
      )
      .get(sha256(token)) as { id: string; workspace_id: string } | undefined;
    if (!row) return null;
    return { entrantId: row.id, workspaceId: row.workspace_id };
  }
}
