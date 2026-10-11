/**
 * 用户服务：注册（邀请码）、登录（会话令牌）、恢复码重置密码、
 * 管理员管理（角色/封禁/兜底重置）（ADR 0015）。
 *
 * 密码用 node:crypto scrypt 哈希（盐 + N 参数内嵌在哈希字符串中）；
 * 会话令牌 sha256 存库、可随时吊销；恢复码哈希 + 明文并存
 * （明文仅管理路由可查，帮用户找回账号）。
 */

import { createHash, randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SQLiteDatabase } from '../db/database.js';

export type UserRole = 'user' | 'admin';

/** 用户记录（不含密码哈希的对外视角）。 */
export interface UserRecord {
  readonly id: string;
  readonly username: string;
  nickname: string | null;
  readonly role: UserRole;
  readonly banned: boolean;
  readonly createdAt: number;
}

/** 注册成功一次性返回。 */
export interface RegisterResult {
  readonly userId: string;
  readonly username: string;
  readonly recoveryCode: string;
}

/** 登录成功返回的会话凭据。 */
export interface SessionToken {
  readonly token: string;
  readonly userId: string;
}

/** 管理员兜底重置一次性返回。 */
export interface AdminResetResult {
  readonly userId: string;
  readonly newPassword: string;
  readonly recoveryCode: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** scrypt 密码哈希：`scrypt:<salt-hex>:<hash-hex>`。 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

interface UserRow {
  id: string;
  username: string;
  nickname: string | null;
  password_hash: string;
  role: string;
  banned: number;
  created_at: number;
}

export class UserService {
  private readonly db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  private rowToRecord(row: UserRow): UserRecord {
    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      role: row.role === 'admin' ? 'admin' : 'user',
      banned: row.banned === 1,
      createdAt: row.created_at,
    };
  }

  private getUserRow(userId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  }

  // ---------------------------------------------------------------- 邀请码

  /** 管理员预置邀请码。 */
  addInviteCode(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) throw new Error('邀请码不能为空');
    this.db
      .prepare('INSERT OR IGNORE INTO invite_codes (code, redeemed, user_id, created_at) VALUES (?, 0, NULL, ?)')
      .run(trimmed, Date.now());
  }

  /** 管理员撤销未兑换邀请码（已兑换的不可撤回，返回是否真正撤销）。 */
  revokeInviteCode(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed) return false;
    const result = this.db
      .prepare('DELETE FROM invite_codes WHERE code = ? AND redeemed = 0')
      .run(trimmed);
    return result.changes === 1;
  }

  /** 未兑换邀请码列表（管理视角）。 */
  listPendingInviteCodes(): string[] {
    const rows = this.db
      .prepare('SELECT code FROM invite_codes WHERE redeemed = 0 ORDER BY created_at')
      .all() as Array<{ code: string }>;
    return rows.map((r) => r.code);
  }

  /** 管理概览统计（仅计数）。 */
  stats(): { users: number; pendingInviteCodes: number; consumedInviteCodes: number } {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      users: count('SELECT COUNT(*) AS n FROM users'),
      pendingInviteCodes: count('SELECT COUNT(*) AS n FROM invite_codes WHERE redeemed = 0'),
      consumedInviteCodes: count('SELECT COUNT(*) AS n FROM invite_codes WHERE redeemed = 1'),
    };
  }

  // ---------------------------------------------------------------- 注册与查询

  /**
   * 凭邀请码注册用户（ADR 0015）：一次性作废邀请码；用户名唯一。
   * 返回一次性恢复码（请用户抄写保管，不落前端持久化）。
   */
  register(
    inviteCode: string,
    username: string,
    password: string,
    nickname?: string | null,
  ): RegisterResult | 'taken' | null {
    const code = typeof inviteCode === 'string' ? inviteCode.trim() : '';
    const name = typeof username === 'string' ? username.trim() : '';
    const pass = typeof password === 'string' ? password : '';
    // 用户名规则与前端一致：3–32 位字母/数字/下划线（ADR 0015）。
    if (!/^[A-Za-z0-9_]{3,32}$/.test(name) || pass.length < 6) return null;
    if (this.getByUsername(name)) return 'taken';

    const id = randomUUID();
    const recoveryCode = nanoid(32);
    const now = Date.now();
    const trimmedNickname =
      typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null;

    const run = this.db.transaction(() => {
      // 原子兑换：仅当邀请码存在且未兑换时生效，天然防并发重复兑换。
      const redeemed = this.db
        .prepare('UPDATE invite_codes SET redeemed = 1, user_id = ? WHERE code = ? AND redeemed = 0')
        .run(id, code);
      if (redeemed.changes !== 1) return null;

      this.db
        .prepare('INSERT INTO users (id, username, nickname, password_hash, role, banned, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(id, name, trimmedNickname, hashPassword(pass), 'user', now);
      this.db
        .prepare('INSERT INTO recovery_codes (hash, username, created_at, token) VALUES (?, ?, ?, ?)')
        .run(sha256(recoveryCode), name, now, recoveryCode);
      return true;
    });
    if (run() === null) return null;

    return { userId: id, username: name, recoveryCode };
  }

  get(userId: string): UserRecord | null {
    const row = this.getUserRow(userId);
    return row ? this.rowToRecord(row) : null;
  }

  getByUsername(username: string): UserRecord | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** 管理视角用户列表。 */
  listUsers(): Array<UserRecord & { sessionCount: number }> {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY created_at')
      .all() as UserRow[];
    return rows.map((r) => ({
      ...this.rowToRecord(r),
      sessionCount: (this.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
        .get(r.id) as { n: number }).n,
    }));
  }

  // ---------------------------------------------------------------- 会话

  /** 登录：校验密码并签发会话令牌。封禁用户拒绝。 */
  login(username: string, password: string): SessionToken | null {
    const name = typeof username === 'string' ? username.trim() : '';
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(name) as UserRow | undefined;
    if (!row) return null;
    if (row.banned === 1) return null;
    if (!verifyPassword(password, row.password_hash)) return null;

    const token = nanoid(32);
    this.db
      .prepare('INSERT INTO sessions (hash, user_id, created_at) VALUES (?, ?, ?)')
      .run(sha256(token), row.id, Date.now());
    return { token, userId: row.id };
  }

  /** 由会话令牌定位用户（认证用）；无效或用户已封禁返回 null。 */
  findBySessionToken(token: string): UserRecord | null {
    const row = this.db
      .prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?',
      )
      .get(sha256(token)) as UserRow | undefined;
    if (!row) return null;
    if (row.banned === 1) return null;
    return this.rowToRecord(row);
  }

  /** 吊销一个会话（登出）。返回是否存在该会话。 */
  logout(token: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha256(token));
    return result.changes === 1;
  }

  /** 吊销某用户全部会话（封禁/重置密码/兜底重置时联动）。 */
  revokeAllSessions(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // ---------------------------------------------------------------- 恢复码

  /**
   * 凭恢复码自助重置密码（ADR 0015）：
   * - 校验恢复码，不匹配返回 false；
   * - 新密码生效、旧会话全部吊销、恢复码轮换（旧的作废、生成新的）。
   */
  resetPasswordByRecoveryCode(username: string, recoveryCode: string, newPassword: string): boolean {
    const name = typeof username === 'string' ? username.trim() : '';
    const user = this.getByUsername(name);
    if (!user) return false;
    if (typeof recoveryCode !== 'string' || !recoveryCode) return false;
    if (typeof newPassword !== 'string' || !newPassword) return false;

    const nextRecoveryCode = nanoid(32);
    const now = Date.now();
    const run = this.db.transaction(() => {
      // 原子校验并轮换：仅当旧恢复码匹配时生效。
      const swapped = this.db
        .prepare('UPDATE recovery_codes SET hash = ?, created_at = ?, token = ? WHERE username = ? AND hash = ?')
        .run(sha256(nextRecoveryCode), now, nextRecoveryCode, name, sha256(recoveryCode));
      if (swapped.changes !== 1) return false;
      this.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword(newPassword), user.id);
      return true;
    });
    if (!run()) return false;

    this.revokeAllSessions(user.id);
    return true;
  }

  /**
   * 管理员查看某用户当前恢复码明文（帮用户找回账号）。
   * 每个用户同一时刻只有一条有效恢复码。返回 null 表示无明文可查。
   */
  getRecoveryCode(username: string): string | null {
    const row = this.db
      .prepare('SELECT token FROM recovery_codes WHERE username = ? ORDER BY created_at DESC LIMIT 1')
      .get(username) as { token: string | null } | undefined;
    return row?.token ?? null;
  }

  /**
   * 管理员兜底重置（ADR 0015：用户名与恢复码都丢了）：
   * 生成一次性新密码与新恢复码返回，转交给用户；旧会话吊销。
   */
  adminResetPassword(userId: string): AdminResetResult | null {
    const user = this.get(userId);
    if (!user) return null;

    const newPassword = nanoid(16);
    const nextRecoveryCode = nanoid(32);
    const now = Date.now();

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM recovery_codes WHERE username = ?').run(user.username);
      this.db
        .prepare('INSERT INTO recovery_codes (hash, username, created_at, token) VALUES (?, ?, ?, ?)')
        .run(sha256(nextRecoveryCode), user.username, now, nextRecoveryCode);
      this.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword(newPassword), userId);
    })();

    this.revokeAllSessions(userId);
    return { userId, newPassword, recoveryCode: nextRecoveryCode };
  }

  // ---------------------------------------------------------------- 管理操作

  /**
   * 种子首个管理员（环境变量注入；幂等）。
   * 已存在同名账号时：重置其密码并强制恢复 admin 角色且解封——环境变量是部署侧的
   * 最终事实，重启后覆盖运行期的降级/封禁（单管理员部署语义）。
   */
  seedAdmin(username: string, password: string): boolean {
    const name = username.trim();
    const pass = password;
    if (!name || !pass) return false;
    const existing = this.getByUsername(name);
    if (existing) {
      this.db
        .prepare('UPDATE users SET password_hash = ?, role = ?, banned = 0 WHERE id = ?')
        .run(hashPassword(pass), 'admin', existing.id);
      return true;
    }
    this.db
      .prepare('INSERT INTO users (id, username, nickname, password_hash, role, banned, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(randomUUID(), name, name, hashPassword(pass), 'admin', Date.now());
    return true;
  }

  /** 角色切换（提权/降级）。不存在返回 null。 */
  setRole(userId: string, role: UserRole): true | null {
    const user = this.get(userId);
    if (!user) return null;
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    return true;
  }

  /** 封禁/解封（ADR 0015：封禁无法登录、数据保留）。封禁时联动吊销全部会话。 */
  setBanned(userId: string, banned: boolean): true | null {
    const user = this.get(userId);
    if (!user) return null;
    this.db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, userId);
    if (banned) this.revokeAllSessions(userId);
    return true;
  }

  // ---------------------------------------------------------------- 昵称

  /** 改昵称（展示用，不要求唯一）。空昵称拒绝；用户不存在返回 null。 */
  rename(userId: string, nickname: string): true | false | null {
    const user = this.get(userId);
    if (!user) return null;
    const trimmed = typeof nickname === 'string' ? nickname.trim() : '';
    if (!trimmed) return false;
    this.db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(trimmed, userId);
    return true;
  }
}
