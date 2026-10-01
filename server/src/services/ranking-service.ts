/**
 * 排名服务：按游戏版本分别维护的 Elo 积分（ADR 0004 计分规则）。
 *
 * - 初始 1000，K=32；胜 1 / 平 0.5 / 负 0（可配置，修改不追溯）。
 * - 同一工作台所属参赛对象之间的对局不计分。
 * - 同一无序对手对在滚动 24h 内最多 3 场计分，超出仅跳过计分（对局照常记录）。
 * - 积分缓存在内存；rebuild() 可从 matches 表重算（启动时恢复，见 rebuildOnStart）。
 */

import type { MatchRecord } from '../engine/match-contracts.js';
import type { MatchStore } from '../engine/match-store.js';

export interface LeaderboardEntry {
  entrantId: string;
  score: number;
  wins: number;
  losses: number;
  draws: number;
}

interface RatingRow {
  score: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface RankingServiceDeps {
  initialScore?: number;
  kFactor?: number;
  /** 滚动窗口（毫秒）内同一无序对手对的计分上限。 */
  windowMs?: number;
  maxScoredPerPair?: number;
  /** 查询参赛对象归属的工作台（同工作台不计分）。 */
  getWorkspaceId?: (entrantId: string) => string | null;
  /** 注入时钟，测试用。 */
  now?: () => number;
  /**
   * 若为 true，构造时调用 rebuild() 从 matchStore 重算全部积分（服务重启恢复用）。
   * 滚动 24h 限额窗口不持久化，重启后重新计数。
   */
  rebuildOnStart?: boolean;
  /** rebuild() 的数据源。 */
  matchStore?: MatchStore;
}

export class RankingService {
  private readonly initialScore: number;
  private readonly kFactor: number;
  private readonly windowMs: number;
  private readonly maxScoredPerPair: number;
  private readonly getWorkspaceId: (entrantId: string) => string | null;
  private readonly now: () => number;

  /** gameVersionId -> entrantId -> 战绩行 */
  private readonly rows = new Map<string, Map<string, RatingRow>>();
  /** gameVersionId -> 无序对手对（排序拼接）-> 已计分对局的完成时间列表 */
  private readonly scoredTimestamps = new Map<string, Map<string, number[]>>();
  private readonly matchStore?: MatchStore;

  constructor(deps: RankingServiceDeps = {}) {
    this.initialScore = deps.initialScore ?? 1000;
    this.kFactor = deps.kFactor ?? 32;
    this.windowMs = deps.windowMs ?? 24 * 60 * 60 * 1000;
    this.maxScoredPerPair = deps.maxScoredPerPair ?? 3;
    this.getWorkspaceId = deps.getWorkspaceId ?? (() => null);
    this.now = deps.now ?? (() => Date.now());
    this.matchStore = deps.matchStore;
    if (deps.rebuildOnStart) this.rebuild();
  }

  /**
   * 结算一场已结束的对局：
   * - training / invalid 不计分；
   * - 同工作台对局跳过；
   * - 超出 24h 滚动限额的对跳过（返回 false，对局记录本身不受影响）。
   *
   * 返回是否实际计入积分。
   */
  applyResult(gameVersionId: string, matchRecord: MatchRecord): boolean {
    if (matchRecord.phase !== 'finished') return false;
    if (matchRecord.kind !== 'official') return false;
    const result = matchRecord.result;
    if (!result) return false;
    const outcome = result.outcome;
    if (outcome.kind === 'invalid') return false;

    const [a, b] = matchRecord.entrants;
    if (a.entrantId === b.entrantId) return false;

    // 同一工作台所属参赛对象之间的对局不计积分（ADR 0004）。
    const wsA = this.getWorkspaceId(a.entrantId);
    const wsB = this.getWorkspaceId(b.entrantId);
    if (wsA !== null && wsA === wsB) return false;

    // 同一无序对手对滚动 24h 内最多 3 场计分，超出跳过。
    const finishedAt = this.now();
    const pairKey = [a.entrantId, b.entrantId].sort().join('|');
    const history = this.getPairHistory(gameVersionId, pairKey);
    // 修剪窗口外的旧记录，再判断窗口内已计分场数。
    const inWindow = history.filter((t) => finishedAt - t < this.windowMs);
    history.length = 0;
    history.push(...inWindow);
    if (history.length >= this.maxScoredPerPair) return false;
    history.push(finishedAt);

    // Elo 期望得分（标准公式）。
    const table = this.getRows(gameVersionId);
    const rowA = this.getRow(table, a.entrantId);
    const rowB = this.getRow(table, b.entrantId);
    const expectedA = 1 / (1 + 10 ** ((rowB.score - rowA.score) / 400));

    let scoreA: number;
    if (outcome.kind === 'draw') {
      scoreA = 0.5;
      rowA.draws += 1;
      rowB.draws += 1;
    } else {
      const aWon = outcome.winner === 0;
      scoreA = aWon ? 1 : 0;
      if (aWon) {
        rowA.wins += 1;
        rowB.losses += 1;
      } else {
        rowB.wins += 1;
        rowA.losses += 1;
      }
    }
    const delta = this.kFactor * (scoreA - expectedA);
    rowA.score += delta;
    rowB.score -= delta;
    return true;
  }

  /** 按积分降序返回排行榜（胜负平另行展示）。 */
  getLeaderboard(gameVersionId: string): LeaderboardEntry[] {
    const table = this.rows.get(gameVersionId);
    if (!table) return [];
    return [...table.entries()]
      .map(([entrantId, row]) => ({
        entrantId,
        score: row.score,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
      }))
      .sort((x, y) => y.score - x.score || x.entrantId.localeCompare(y.entrantId));
  }

  getScore(gameVersionId: string, entrantId: string): number | null {
    return this.rows.get(gameVersionId)?.get(entrantId)?.score ?? null;
  }

  /** 测试辅助：重置滚动窗口记录（不影响积分）。 */
  clearWindow(): void {
    this.scoredTimestamps.clear();
  }

  /**
   * 从 matchStore 重算全部积分：按时间顺序回放所有已结束的 official 对局。
   * 跳过无结果的记录；training/invalid 由 applyResult 内部规则跳过。
   * 无 matchStore 时仅清空当前缓存。
   */
  rebuild(): void {
    this.rows.clear();
    this.scoredTimestamps.clear();
    if (!this.matchStore) return;
    const summaries = this.matchStore
      .list()
      .filter((s) => s.phase === 'finished' && s.kind === 'official' && s.result !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const summary of summaries) {
      const record = this.matchStore.get(summary.matchId);
      if (record) this.applyResult(record.gameVersionId, record);
    }
  }

  private getRows(gameVersionId: string): Map<string, RatingRow> {
    let table = this.rows.get(gameVersionId);
    if (!table) {
      table = new Map();
      this.rows.set(gameVersionId, table);
    }
    return table;
  }

  private getRow(table: Map<string, RatingRow>, entrantId: string): RatingRow {
    let row = table.get(entrantId);
    if (!row) {
      row = {
        score: this.initialScore,
        wins: 0,
        losses: 0,
        draws: 0,
      };
      table.set(entrantId, row);
    }
    return row;
  }

  private getPairHistory(gameVersionId: string, pairKey: string): number[] {
    let pairs = this.scoredTimestamps.get(gameVersionId);
    if (!pairs) {
      pairs = new Map();
      this.scoredTimestamps.set(gameVersionId, pairs);
    }
    let history = pairs.get(pairKey);
    if (!history) {
      history = [];
      pairs.set(pairKey, history);
    }
    return history;
  }
}
