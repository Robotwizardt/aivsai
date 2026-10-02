/**
 * 对局编排：API 请求 → 调度队列 → MatchRunner（ADR 0003 / 0004）。
 *
 * 职责：
 * - 校验发起者对参赛对象的管理权、对手存在且有已发布策略；
 * - 创建对局时锁定双方策略版本（取各自最新已发布版本）；
 * - official 经 Scheduler 排队（official 优先）；training 快速跑完；
 * - 结束后向 RankingService 结算（只对 official 且 finished 生效）。
 */

import { randomUUID } from 'node:crypto';
import type { MatchRecord } from '../engine/match-contracts.js';
import { MatchRunner } from './match-runner.js';
import { matchStoreHasLiveMatch, type MatchStore } from './match-store.js';
import type { Scheduler } from './scheduler.js';
import type { GamePackage } from '../games/contracts.js';
import type { TankBot } from '../games/tank/bots.js';
import type { EntrantService } from '../services/entrant-service.js';
import type { StrategyService } from '../services/strategy-service.js';
import type { RankingService } from '../services/ranking-service.js';

export interface MatchOrchestratorDeps {
  games: Map<string, GamePackage>;
  entrantService: EntrantService;
  strategyService: StrategyService;
  rankingService: RankingService;
  runner: MatchRunner;
  store: MatchStore;
  scheduler: Scheduler;
  /** 内置 bot 列表（对局对手可为 bot，见 bots.ts）。 */
  bots?: readonly TankBot[];
}

/**
 * 随机匹配的分差上限（ADR 0006：official 只能随机匹配积分相近者）。
 * 匹配池为空时报错，不自动放宽——避免与实力悬殊者对战影响积分公平性。
 */
const MATCH_RATING_WINDOW = 50;

/** 发起对局请求。发起者凭证已由路由层校验过归属。 */
export interface StartMatchInput {
  readonly gameId: string;
  readonly kind: 'official' | 'training';
  /** 发起方的参赛对象（必须属于发起者工作台）。 */
  readonly myEntrantId: string;
  /**
   * 对手参赛对象。仅 training 可用（粘贴任意坦克 ID）。
   * official 会忽略此字段并改用随机匹配。与 opponentBotId 二选一。
   */
  readonly opponentEntrantId?: string;
  /** 对手为内置 bot（如 standard-01 基准）。二选一。 */
  readonly opponentBotId?: string;
  /** 发起者工作台（用于调度限额与同工作台不计分）。 */
  readonly workspaceId: string;
  /** 注入随机源，测试用。 */
  readonly random?: () => number;
}

export interface StartMatchError {
  readonly status: number;
  readonly message: string;
}

type StartResult = { ok: true; matchId: string } | { ok: false; error: StartMatchError };

function err(status: number, message: string): { ok: false; error: StartMatchError } {
  return { ok: false, error: { status, message } };
}

export class MatchOrchestrator {
  private readonly deps: MatchOrchestratorDeps;

  /**
   * 已入队（queued）但 runner 还没落库的对局，在各参赛对象上各有多少场。
   * 对局表在开跑那一刻才有记录，这个排队窗口里的对象只有靠它才查得到，
   * 否则「有对局进行中就不能删」会漏掉排队中的那些（见 hasLiveMatch）。
   * 用计数而非集合：同一对象可能同时有多场排队/进行中的对局，
   * 先结束的那场不能把还在排队的另一场一并放行。
   */
  private readonly queuedMatchesPerEntrant = new Map<string, number>();

  constructor(deps: MatchOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * 该参赛对象是否还在某场对局里：已落库的进行中对局，或已受理但还在排队的对局。
   * 删除参赛对象前的守卫问的就是这个（ADR 0008）——两个来源都算「进行中」。
   */
  hasLiveMatch(entrantId: string): boolean {
    return matchStoreHasLiveMatch(this.deps.store, entrantId) || this.queuedCount(entrantId) > 0;
  }

  /** 该参赛对象已入队、还没开跑的对局场数。 */
  private queuedCount(entrantId: string): number {
    return this.queuedMatchesPerEntrant.get(entrantId) ?? 0;
  }

  private addQueued(entrantId: string): void {
    this.queuedMatchesPerEntrant.set(entrantId, this.queuedCount(entrantId) + 1);
  }

  private removeQueued(entrantId: string): void {
    const left = this.queuedCount(entrantId) - 1;
    if (left > 0) this.queuedMatchesPerEntrant.set(entrantId, left);
    else this.queuedMatchesPerEntrant.delete(entrantId);
  }

  /**
   * official 随机匹配：在同游戏、有已发布策略、非自己的对象中，
   * 取积分差 ≤ MATCH_RATING_WINDOW 者，等概率随机选一个。
   * 候选池不区分工作台：同工作台与其他工作台的对手都进池
   * （同工作台对局由 RankingService 跳过计分，见 ADR 0004/0007）。
   * 池为空则报错（不自动放宽），提示稍后再试。
   */
  private pickRandomOpponent(
    mine: { id: string; workspaceId: string },
    gameId: string,
    random: () => number,
  ): { ok: true; entrantId: string; source: string } | { ok: false; error: StartMatchError } {
    // 双方用同一口径：查不到积分时一律按初始分 1000 计（与候选侧一致）。
    const scoreOf = (entrantId: string): number =>
      this.deps.rankingService.getScore(gameId, entrantId) ?? 1000;
    const myScore = scoreOf(mine.id);

    // 先筛出“可对战”的对象（同游戏、非自己、有已发布策略），
    // 再按分差过滤——这样能区分“根本没对手”和“有对手但分差太大”两种空池原因。
    const eligible = this.deps.entrantService
      .listAll()
      .filter((e) => e.gameId === gameId)
      .filter((e) => e.id !== mine.id)
      .filter((e) => this.deps.strategyService.listVersions(e.id).length > 0);
    const candidates = eligible.filter(
      (e) => Math.abs(scoreOf(e.id) - myScore) <= MATCH_RATING_WINDOW,
    );

    if (candidates.length === 0) {
      return err(
        409,
        eligible.length === 0
          ? '暂无可匹配的对手（需要有其他已发布策略的参赛对象），请稍后再试'
          : `暂无积分相近（±${MATCH_RATING_WINDOW}）的对手，请稍后再试`,
      );
    }

    // Math.min/Math.max 是防御注入的随机源返回越界值（负数、>1、NaN），
    // Math.random() 本身不会越界；注入源越界时把索引夹回合法范围，不崩不提。
    const raw = Math.floor(random() * candidates.length);
    const index = Number.isFinite(raw)
      ? Math.min(candidates.length - 1, Math.max(0, raw))
      : 0;
    const picked = candidates[index];
    if (!picked) return err(500, '匹配池读取失败');
    // 候选已在上面 filter 过“有已发布策略”，此处必然非空；仍守卫一次避免沉默崩溃。
    const versions = this.deps.strategyService.listVersions(picked.id);
    const version = versions[versions.length - 1];
    if (!version) return err(500, '对手策略版本缺失');
    return { ok: true, entrantId: picked.id, source: version.source };
  }

  async start(input: StartMatchInput): Promise<StartResult> {
    const { gameId, kind, myEntrantId } = input;

    if (!this.deps.games.has(gameId)) return err(400, '游戏不存在');

    const mine = this.deps.entrantService.getActive(myEntrantId);
    if (!mine) return err(404, '参赛对象不存在');
    if (mine.workspaceId !== input.workspaceId) return err(401, '无权管理该参赛对象');
    if (mine.gameId !== gameId) return err(400, '参赛对象不属于该游戏');

    // 创建时锁定双方策略版本：取各自最新已发布版本（ADR 0004）。
    const myVersions = this.deps.strategyService.listVersions(myEntrantId);
    const myVersion = myVersions[myVersions.length - 1];
    if (!myVersion) return err(400, '我方参赛对象尚无已发布策略');

    // 对手解析：official 只能随机匹配（忽略调用方传入的对手），
    // training 可粘贴任意坦克 ID 指定对手，或选内置 bot。
    let opponentEntrantId: string;
    let opponentSource: string;
    /** 对手是否为内置 bot：虚拟参赛方，没有参赛对象行，不计分也不登记排队。 */
    let opponentIsBot = false;
    if (kind === 'official') {
      const picked = this.pickRandomOpponent(mine, gameId, input.random ?? Math.random);
      if (!picked.ok) return picked;
      opponentEntrantId = picked.entrantId;
      opponentSource = picked.source;
    } else if (input.opponentBotId !== undefined) {
      const bot = this.deps.bots?.find((b) => b.id === input.opponentBotId);
      if (!bot) return err(400, 'botId 无效');
      opponentEntrantId = `bot:${bot.id}`;
      opponentSource = bot.code;
      opponentIsBot = true;
    } else {
      if (!input.opponentEntrantId) return err(400, 'opponentEntrantId 无效');
      const opponent = this.deps.entrantService.getActive(input.opponentEntrantId);
      if (!opponent) return err(404, '对手参赛对象不存在');
      if (opponent.gameId !== gameId) return err(400, '对手参赛对象不属于该游戏');
      if (opponent.id === mine.id) return err(400, '不能与自己对战');
      const opVersions = this.deps.strategyService.listVersions(input.opponentEntrantId);
      const opVersion = opVersions[opVersions.length - 1];
      if (!opVersion) return err(400, '对手参赛对象尚无已发布策略');
      opponentEntrantId = input.opponentEntrantId;
      opponentSource = opVersion.source;
    }

    const matchId = randomUUID();

    // 注意：workspaceId 记发起者的（调度与限流口径）；同工作台对局
    // 由 RankingService 通过 getWorkspaceId 判定后跳过计分（ADR 0004）。
    // bot 对手（虚拟参赛方）不进入计分：基准是用来测的，不是用来爬分的。
    const credited = !opponentIsBot;
    // 排队登记：排队窗口里对局表还查不到这些对象，删除守卫靠它拦人（ADR 0008）。
    const queuedIds = opponentIsBot ? [myEntrantId] : [myEntrantId, opponentEntrantId];
    for (const id of queuedIds) this.addQueued(id);

    const queued = this.deps.scheduler.enqueue({
      kind,
      workspaceId: input.workspaceId,
      run: async () => {
        try {
          const record: MatchRecord = await this.deps.runner.run({
            matchId,
            gameId,
            kind,
            entrants: [
              {
                entrantId: myEntrantId,
                strategyVersionId: String(myVersion.versionId),
                source: myVersion.source,
              },
              {
                entrantId: opponentEntrantId,
                strategyVersionId: 'bot',
                source: opponentSource,
              },
            ],
          });
          // 结算：只对 finished 的 official 对局计分（内部再套限额规则）。
          if (credited && record.kind === 'official' && record.phase === 'finished') {
            this.deps.rankingService.applyResult(record.gameVersionId, record);
          }
        } finally {
          // 开跑后（或开跑失败）由对局表接管，本场在排队登记里减一场。
          for (const id of queuedIds) this.removeQueued(id);
        }
      },
    });

    // official 在后台排队直播推进，start 立即返回 matchId；
    // training 快速跑完，等待其完成再返回（训练结果立即可查）。
    if (kind === 'training') {
      await queued;
    }

    return { ok: true, matchId };
  }
}
