/**
 * 策略服务：草稿保存与不可变的策略版本（ADR 0002 / 0004）。
 *
 * - 策略源码默认私密；公开是版本级选择（publish 的 publicVisible，默认 false）。
 * - 对局创建时固定策略版本（版本不可变），后续发布不影响既有版本。
 * - SQLite 持久化（strategy_versions / strategy_drafts 表）。
 */

import type { SQLiteDatabase } from '../db/database.js';

export interface StrategyVersion {
  /** 从 1 开始递增。 */
  readonly versionId: number;
  readonly entrantId: string;
  readonly source: string;
  /** 版本级可见性：默认 false（源码私密，ADR 0002）。 */
  readonly publicVisible: boolean;
  readonly createdAt: number;
}

export interface EntrantDraft {
  readonly entrantId: string;
  source: string;
  readonly updatedAt: number;
}

interface VersionRow {
  entrant_id: string;
  version: number;
  source: string;
  public_visible: number;
  created_at: number;
}

export class StrategyService {
  private readonly db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  private rowToVersion(row: VersionRow): StrategyVersion {
    return {
      versionId: row.version,
      entrantId: row.entrant_id,
      source: row.source,
      publicVisible: row.public_visible === 1,
      createdAt: row.created_at,
    };
  }

  /** 保存草稿（不产生版本，不参与对局，可反复覆盖）。 */
  saveDraft(entrantId: string, source: string): EntrantDraft {
    const draft: EntrantDraft = { entrantId, source, updatedAt: Date.now() };
    this.db
      .prepare(
        `INSERT INTO strategy_drafts (entrant_id, source, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(entrant_id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(entrantId, source, draft.updatedAt);
    return draft;
  }

  /** 发布策略：生成新版本（versionId 递增），版本内容不可变。 */
  publish(entrantId: string, source: string, publicVisible = false): StrategyVersion {
    const next =
      (
        this.db
          .prepare('SELECT MAX(version) AS v FROM strategy_versions WHERE entrant_id = ?')
          .get(entrantId) as { v: number | null }
      ).v ?? 0;
    const version: StrategyVersion = {
      versionId: next + 1,
      entrantId,
      source,
      publicVisible,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO strategy_versions (id, entrant_id, version, source, public_visible, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(`${entrantId}:${version.versionId}`, entrantId, version.versionId, source, publicVisible ? 1 : 0, version.createdAt);
    return version;
  }

  listVersions(entrantId: string): StrategyVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM strategy_versions WHERE entrant_id = ? ORDER BY version')
      .all(entrantId) as VersionRow[];
    return rows.map((r) => this.rowToVersion(r));
  }

  /** 全平台已发布版本总数（管理概览用）。 */
  countAllVersions(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM strategy_versions').get() as { n: number }).n;
  }

  getVersion(entrantId: string, versionId: number): StrategyVersion | null {
    const row = this.db
      .prepare('SELECT * FROM strategy_versions WHERE entrant_id = ? AND version = ?')
      .get(entrantId, versionId) as VersionRow | undefined;
    return row ? this.rowToVersion(row) : null;
  }

  getDraft(entrantId: string): EntrantDraft | null {
    const row = this.db
      .prepare('SELECT * FROM strategy_drafts WHERE entrant_id = ?')
      .get(entrantId) as { entrant_id: string; source: string; updated_at: number } | undefined;
    if (!row) return null;
    return { entrantId: row.entrant_id, source: row.source, updatedAt: row.updated_at };
  }
}
