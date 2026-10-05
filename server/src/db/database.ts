import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { customAlphabet } from 'nanoid';

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
    -- archived_at：归档（删除）时间，NULL 表示在役。归档后不再进入列表、匹配池、
    -- 排行榜，也不释放其历史对局（对局与回放引用它，必须保留）。
    CREATE TABLE IF NOT EXISTS entrants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
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

    -- 凭证（哈希存储；对象凭证额外存明文 token，供工作台凭证持有者随时取回）
    CREATE TABLE IF NOT EXISTS credentials (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL, -- workspace | entrant
      owner_id TEXT NOT NULL, -- workspace_id or entrant_id
      created_at INTEGER NOT NULL,
      token TEXT -- 明文，仅 kind = 'entrant' 时写入（ADR 0002 修订）
    );

    -- 恢复码（哈希 + 明文存库：管理员可查看明文，帮用户找回账户；见 ADR 0002 再修订）
    CREATE TABLE IF NOT EXISTS recovery_codes (
      hash TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      token TEXT -- 明文，仅管理路由可读；明文列引入前的存量旧码为 NULL
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_entrants_workspace ON entrants(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_strategy_versions_entrant ON strategy_versions(entrant_id);
    CREATE INDEX IF NOT EXISTS idx_matches_game ON matches(game_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_id);
  `);

  migrate(db);

  return db;
}

/**
 * 增量迁移：`CREATE TABLE IF NOT EXISTS` 不会为已存在的表补列，
 * 所以新增字段要在这里显式补（老库升级路径）。
 */
function migrate(db: Database.Database): void {
  addColumnIfMissing(db, 'entrants', 'archived_at', 'INTEGER');
  // 对象凭证明文列：工作台凭证持有者可随时取回（ADR 0002 修订）。
  addColumnIfMissing(db, 'credentials', 'token', 'TEXT');
  // 恢复码明文列：管理员可查看明文，帮用户找回账户（ADR 0002 再修订）。
  addColumnIfMissing(db, 'recovery_codes', 'token', 'TEXT');
  // 工作台名唯一（ADR 0010）：先给无昵称的自动生成唯一名，再建唯一索引，顺序不可颠倒。
  assignMissingWorkspaceNicknames(db);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_nickname ON workspaces(nickname) WHERE nickname IS NOT NULL',
  );
}

/** 自动昵称后缀：小写字母+数字，5 位。 */
const nicknameSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 5);

/** 给没有昵称的工作台生成「工作台-<短随机后缀>」，保证唯一（为建唯一索引做准备）。 */
function assignMissingWorkspaceNicknames(db: Database.Database): void {
  const rows = db.prepare('SELECT id FROM workspaces WHERE nickname IS NULL').all() as { id: string }[];
  if (rows.length === 0) return;
  const exists = db.prepare('SELECT 1 FROM workspaces WHERE nickname = ?');
  const update = db.prepare('UPDATE workspaces SET nickname = ? WHERE id = ?');
  for (const row of rows) {
    let name: string;
    do {
      name = `工作台-${nicknameSuffix()}`;
    } while (exists.get(name));
    update.run(name, row.id);
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
