import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SQLiteDatabase = Database.Database;

/**
 * 初始化 SQLite 数据库（自动创建目录与表结构）。
 * @param path 数据库文件路径，":memory:" 表示内存数据库（测试用）
 */
export function initDatabase(path: string): SQLiteDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL'); // 提升并发性能

  // 旧库清零必须先于 DDL：CREATE INDEX 引用旧表缺失列会直接抛错（ADR 0015）
  dropLegacyTablesIfPresent(db);

  db.exec(`
    -- 用户（ADR 0015：账号密码体系取代无账号凭证体系）
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      nickname TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', -- user | admin
      banned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- 会话令牌（哈希存库，可随时吊销；ADR 0015）
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 邀请码（兑换注册资格；一次性作废）
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      redeemed INTEGER NOT NULL DEFAULT 0,
      user_id TEXT,
      created_at INTEGER NOT NULL
    );

    -- 参赛对象
    -- archived_at：归档（删除）时间，NULL 表示在役。归档后不再进入列表、匹配池、
    -- 排行榜，也不释放其历史对局（对局与回放引用它，必须保留）。
    CREATE TABLE IF NOT EXISTS entrants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      appearance TEXT NOT NULL, -- JSON
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    -- 策略版本
    CREATE TABLE IF NOT EXISTS strategy_versions (
      id TEXT PRIMARY KEY,
      entrant_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      source TEXT NOT NULL,
      public_visible INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(entrant_id, version)
    );

    -- 策略草稿（每对象一份，可覆盖）
    CREATE TABLE IF NOT EXISTS strategy_drafts (
      entrant_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 对局
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      game_version_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      phase TEXT NOT NULL,
      entrants TEXT NOT NULL, -- JSON [{entrantId, strategyVersionId}]
      result TEXT, -- JSON
      frames TEXT NOT NULL, -- JSON (回放帧数组)
      created_at INTEGER NOT NULL
    );

    -- API 令牌（原「对象凭证」，ADR 0016：哈希 + 明文并存，供用户随时取回复制给 Agent）
    CREATE TABLE IF NOT EXISTS api_tokens (
      hash TEXT PRIMARY KEY,
      entrant_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      token TEXT -- 明文本份（取回用）
    );

    -- 恢复码（哈希 + 明文存库：管理员可查看明文，帮用户找回账号；ADR 0015）
    CREATE TABLE IF NOT EXISTS recovery_codes (
      hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      token TEXT -- 明文，仅管理路由可读
    );

    -- 表演赛（ADR 0017：座位交给外部 AI 直接对弈的不计分对局）
    CREATE TABLE IF NOT EXISTS exhibitions (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      creator_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      per_move_timeout_ms INTEGER NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 1,
      seat_name_0 TEXT, -- 红方（先手）自报名称；NULL = 未自报
      seat_name_1 TEXT, -- 黑方（后手）自报名称
      paused INTEGER NOT NULL DEFAULT 0,
      voided_at INTEGER, -- 创建后 1 小时无第一手自动作废
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    -- 座位密钥（一场两把，对局结束即失效 = 行删除；ADR 0017）
    CREATE TABLE IF NOT EXISTS seat_keys (
      key TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      side INTEGER NOT NULL, -- 0 = 红方，1 = 黑方
      created_at INTEGER NOT NULL
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_entrants_user ON entrants(user_id);
    CREATE INDEX IF NOT EXISTS idx_strategy_versions_entrant ON strategy_versions(entrant_id);
    CREATE INDEX IF NOT EXISTS idx_matches_game ON matches(game_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_entrant ON api_tokens(entrant_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_exhibitions_creator ON exhibitions(creator_user_id);
    CREATE INDEX IF NOT EXISTS idx_seat_keys_match ON seat_keys(match_id);
  `);

  migrate(db);

  return db;
}

/**
 * 增量迁移（ADR 0015）：旧库的 workspaces/credentials 表已被 users/sessions/api_tokens
 * 取代，存量数据清零重来（开发期无真实用户数据），直接丢弃旧表。
 * 旧 schema 的 entrants（workspace_id 列）、recovery_codes、invite_codes 同属被取代
 * 结构，一并丢弃重建——DROP 必须先于 DDL 执行，否则 CREATE INDEX 引用旧表会直接抛错。
 * 新库列增量仍走 addColumnIfMissing。
 */
function migrate(db: Database.Database): void {
  addColumnIfMissing(db, 'entrants', 'archived_at', 'INTEGER');
}

/**
 * 检测旧 schema（workspaces 表存在）并丢弃全部结构已变的旧表，置于 DDL 之前执行。
 * 新库或空库不会命中任何 DROP，行为不变。
 */
function dropLegacyTablesIfPresent(db: Database.Database): void {
  const legacy = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'`)
    .get() as { name: string } | undefined;
  if (!legacy) return;
  // 结构已变、必须清零重来的表（ADR 0015：开发期无真实数据，不写迁移脚本）
  for (const table of ['entrants', 'recovery_codes', 'invite_codes', 'workspaces', 'credentials']) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}



function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
