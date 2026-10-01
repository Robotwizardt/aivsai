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

  db.exec(`
    -- 工作台
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      nickname TEXT,
      created_at INTEGER NOT NULL,
      recovery_used INTEGER NOT NULL DEFAULT 0
    );

    -- 邀请码
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      redeemed INTEGER NOT NULL DEFAULT 0,
      workspace_id TEXT,
      created_at INTEGER NOT NULL
    );

    -- 参赛对象
    CREATE TABLE IF NOT EXISTS entrants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      appearance TEXT NOT NULL, -- JSON
      created_at INTEGER NOT NULL
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

    -- 凭证（哈希存储）
    CREATE TABLE IF NOT EXISTS credentials (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL, -- workspace | entrant
      owner_id TEXT NOT NULL, -- workspace_id or entrant_id
      created_at INTEGER NOT NULL
    );

    -- 恢复码（哈希存储）
    CREATE TABLE IF NOT EXISTS recovery_codes (
      hash TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_entrants_workspace ON entrants(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_strategy_versions_entrant ON strategy_versions(entrant_id);
    CREATE INDEX IF NOT EXISTS idx_matches_game ON matches(game_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_id);
  `);

  return db;
}
