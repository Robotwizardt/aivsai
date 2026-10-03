/**
 * 工作台服务：邀请码兑换、工作台凭证与恢复码管理（ADR 0002）。
 *
 * SQLite 持久化（workspaces / invite_codes / credentials / recovery_codes 表）。
 * 凭证与恢复码只在创建/重置时以明文返回一次，存储层仅保留 sha256 哈希。
 */

import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SQLiteDatabase } from '../db/database.js';

/** 工作台记录（存储层视角，不含任何凭证哈希与明文）。 */
export interface WorkspaceRecord {
  readonly id: string;
  nickname: string | null;
  readonly createdAt: number;
  /** 首次出厂恢复码是否已被使用过（历史标记，不影响新恢复码继续使用）。 */
  recoveryUsed: boolean;
  status: 'active';
}

/** 兑换/重置成功时一次性返回的明文凭据。 */
export interface CredentialBundle {
  readonly workspaceId: string;
  readonly credential: string;
  readonly recoveryCode: string;
}

export interface WorkspaceServiceDeps {
  /**
   * 工作台凭证恢复时触发的联动失效（ADR 0002 恢复规则）：
   * 作废该工作台下全部对象凭证与既有会话。
   */
  onWorkspaceReset?: (workspaceId: string) => void;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface WorkspaceRow {
  id: string;
  nickname: string | null;
  created_at: number;
  recovery_used: number;
}

export class WorkspaceService {
  private readonly db: SQLiteDatabase;
  private readonly deps: WorkspaceServiceDeps;

  constructor(db: SQLiteDatabase, deps: WorkspaceServiceDeps = {}) {
    this.db = db;
    this.deps = deps;
  }

  private rowToRecord(row: WorkspaceRow): WorkspaceRecord {
    return {
      id: row.id,
      nickname: row.nickname,
      createdAt: row.created_at,
      recoveryUsed: row.recovery_used === 1,
      status: 'active',
    };
  }

  /** 管理员预置邀请码。 */
  addInviteCode(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) throw new Error('邀请码不能为空');
    this.db
      .prepare('INSERT OR IGNORE INTO invite_codes (code, redeemed, workspace_id, created_at) VALUES (?, 0, NULL, ?)')
      .run(trimmed, Date.now());
  }

  /** 管理概览统计（仅计数，不含任何凭证哈希）。 */
  stats(): {
    workspaces: number;
    pendingInviteCodes: number;
    consumedInviteCodes: number;
  } {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      workspaces: count('SELECT COUNT(*) AS n FROM workspaces'),
      pendingInviteCodes: count('SELECT COUNT(*) AS n FROM invite_codes WHERE redeemed = 0'),
      consumedInviteCodes: count('SELECT COUNT(*) AS n FROM invite_codes WHERE redeemed = 1'),
    };
  }

  /** 工作台概览（管理视角，不含凭证）。 */
  listWorkspaces(): Array<{
    id: string;
    nickname: string | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare('SELECT id, nickname, created_at FROM workspaces ORDER BY created_at')
      .all() as WorkspaceRow[];
    return rows.map((r) => ({ id: r.id, nickname: r.nickname, createdAt: r.created_at }));
  }

  /** 未兑换邀请码列表（管理视角；已兑换的码一次性作废，不再返回）。 */
  listPendingInviteCodes(): string[] {
    const rows = this.db
      .prepare('SELECT code FROM invite_codes WHERE redeemed = 0 ORDER BY created_at')
      .all() as Array<{ code: string }>;
    return rows.map((r) => r.code);
  }

  /**
   * 校验邀请码（一次性作废）并创建工作台。
   * 邀请码无效或已被兑换时返回 null。
   */
  createWorkspace(inviteCode: string, nickname?: string | null): CredentialBundle | 'taken' | null {
    const code = typeof inviteCode === 'string' ? inviteCode.trim() : '';
    if (!code) return null;
    // 工作台名唯一（ADR 0010）：兑换时若填了昵称且已被占用，拒绝（返回 'taken'）。
    const trimmedNickname =
      typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null;
    if (trimmedNickname && this.isNicknameTaken(trimmedNickname)) return 'taken';

    const id = randomUUID();
    const credential = nanoid(32);
    const recoveryCode = nanoid(32);
    const now = Date.now();

    // 事务内原子作废邀请码 + 创建工作台 + 写入凭证/恢复码哈希。
    const run = this.db.transaction(() => {
      // 原子兑换：仅当邀请码存在且未兑换时生效，天然防并发重复兑换。
      const redeemed = this.db
        .prepare('UPDATE invite_codes SET redeemed = 1, workspace_id = ? WHERE code = ? AND redeemed = 0')
        .run(id, code);
      if (redeemed.changes !== 1) return null;

      this.db
        .prepare('INSERT INTO workspaces (id, nickname, created_at, recovery_used) VALUES (?, ?, ?, 0)')
        .run(id, typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null, now);
      this.db
        .prepare("INSERT INTO credentials (hash, kind, owner_id, created_at) VALUES (?, 'workspace', ?, ?)")
        .run(sha256(credential), id, now);
      this.db
        .prepare('INSERT INTO recovery_codes (hash, workspace_id, created_at) VALUES (?, ?, ?)')
        .run(sha256(recoveryCode), id, now);
      return true;
    });
    if (run() === null) return null;

    return { workspaceId: id, credential, recoveryCode };
  }

  /**
   * 凭恢复码重置工作台凭证（ADR 0002 恢复规则）：
   * - 验证恢复码哈希，不匹配返回 null；
   * - 生成新工作台凭证与新恢复码，旧凭证/旧恢复码随之失效；
   * - 通过 onWorkspaceReset 联动作废该工作台下全部对象凭证与既有会话。
   *
   * 本实现中凭证为无状态 Bearer（哈希即会话），替换哈希即等于吊销旧会话；
   * 会话表留待引入有状态会话时扩展。
   */
  resetCredential(
    workspaceId: string,
    recoveryCode: string,
    newCredential?: string,
  ): CredentialBundle | null {
    const record = this.get(workspaceId);
    if (!record) return null;
    if (typeof recoveryCode !== 'string' || !recoveryCode) return null;

    const credential = newCredential ?? nanoid(32);
    const nextRecoveryCode = nanoid(32);
    const now = Date.now();

    const run = this.db.transaction(() => {
      // 原子校验并更换恢复码：仅当旧恢复码仍匹配时生效。
      const swapped = this.db
        .prepare('UPDATE recovery_codes SET hash = ?, created_at = ? WHERE workspace_id = ? AND hash = ?')
        .run(sha256(nextRecoveryCode), now, workspaceId, sha256(recoveryCode));
      if (swapped.changes !== 1) return null;
      this.db
        .prepare("DELETE FROM credentials WHERE kind = 'workspace' AND owner_id = ?")
        .run(workspaceId);
      this.db
        .prepare("INSERT INTO credentials (hash, kind, owner_id, created_at) VALUES (?, 'workspace', ?, ?)")
        .run(sha256(credential), workspaceId, now);
      this.db
        .prepare('UPDATE workspaces SET recovery_used = 1 WHERE id = ?')
        .run(workspaceId);
      return true;
    });
    if (run() === null) return null;

    this.deps.onWorkspaceReset?.(workspaceId);

    return { workspaceId, credential, recoveryCode: nextRecoveryCode };
  }

  /** 由明文凭证定位工作台（认证用）。 */
  findByCredential(token: string): WorkspaceRecord | null {
    const row = this.db
      .prepare(
        `SELECT w.id, w.nickname, w.created_at, w.recovery_used
         FROM credentials c JOIN workspaces w ON w.id = c.owner_id
         WHERE c.hash = ? AND c.kind = 'workspace'`,
      )
      .get(sha256(token)) as WorkspaceRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  get(workspaceId: string): WorkspaceRecord | null {
    const row = this.db
      .prepare('SELECT id, nickname, created_at, recovery_used FROM workspaces WHERE id = ?')
      .get(workspaceId) as WorkspaceRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** 该昵称是否已被其他工作台占用（唯一约束，ADR 0010）。 */
  isNicknameTaken(nickname: string, excludeWorkspaceId?: string): boolean {
    const trimmed = nickname.trim();
    if (!trimmed) return false;
    const row = this.db
      .prepare('SELECT id FROM workspaces WHERE nickname = ?')
      .get(trimmed) as { id: string } | undefined;
    return !!row && row.id !== excludeWorkspaceId;
  }

  /**
   * 工作台改名（ADR 0010）：即时生效（名字运行时查，非快照，历史显示自动同步）。
   * 名字已被其他工作台占用时返回 'taken'；成功返回 true；工作台不存在返回 null。
   */
  rename(workspaceId: string, nickname: string): true | 'taken' | null {
    const record = this.get(workspaceId);
    if (!record) return null;
    const trimmed = typeof nickname === 'string' ? nickname.trim() : '';
    if (!trimmed) return 'taken'; // 空名不允许（必须有个唯一名供消歧）
    if (this.isNicknameTaken(trimmed, workspaceId)) return 'taken';
    this.db.prepare('UPDATE workspaces SET nickname = ? WHERE id = ?').run(trimmed, workspaceId);
    return true;
  }
}
