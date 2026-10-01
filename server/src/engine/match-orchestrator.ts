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
import type { MatchStore } from './match-store.js';
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

/** 发起对局请求。发起者凭证已由路由层校验过归属。 */
export interface StartMatchInput {
  readonly gameId: string;
  readonly kind: 'official' | 'training';
  /** 发起方的参赛对象（必须属于发起者工作台）。 */
  readonly myEntrantId: string;
  /** 对手参赛对象。与 opponentBotId 二选一。 */
  readonly opponentEntrantId?: string;
  /** 对手为内置 bot（如 standard-01 基准）。与 opponentEntrantId 二选一。 */
  readonly opponentBotId?: string;
  /** 发起者工作台（用于调度限额与同工作台不计分）。 */
  readonly workspaceId: string;
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

  constructor(deps: MatchOrchestratorDeps) {
    this.deps = deps;
  }

  async start(input: StartMatchInput): Promise<StartResult> {
    const { gameId, kind, myEntrantId } = input;

    if (!this.deps.games.has(gameId)) return err(400, '游戏不存在');

    const mine = this.deps.entrantService.get(myEntrantId);
    if (!mine) return err(404, '参赛对象不存在');
    if (mine.workspaceId !== input.workspaceId) return err(401, '无权管理该参赛对象');
    if (mine.gameId !== gameId) return err(400, '参赛对象不属于该游戏');

    // 创建时锁定双方策略版本：取各自最新已发布版本（ADR 0004）。
    const myVersions = this.deps.strategyService.listVersions(myEntrantId);
    const myVersion = myVersions[myVersions.length - 1];
    if (!myVersion) return err(400, '我方参赛对象尚无已发布策略');

    // 对手二选一：内置 bot（虚拟参赛方，不落库不占配额）或真实参赛对象。
    let opponentEntrantId: string;
    let opponentSource: string;
    if (input.opponentBotId !== undefined) {
      const bot = this.deps.bots?.find((b) => b.id === input.opponentBotId);
      if (!bot) return err(400, 'botId 无效');
      opponentEntrantId = `bot:${bot.id}`;
      opponentSource = bot.code;
    } else {
      if (!input.opponentEntrantId) return err(400, 'opponentEntrantId 无效');
      const opponent = this.deps.entrantService.get(input.opponentEntrantId);
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

    // 注意：workspaceId 记发起者的（调度与限流口径）；对手所在工作台
    // 在计分时由 RankingService 通过 getWorkspaceId 判定同工作台跳过。
    // bot 对手（虚拟参赛方）不进入计分：基准是用来测的，不是用来爬分的。
    const credited = input.opponentBotId === undefined;
    const queued = this.deps.scheduler.enqueue({
      kind,
      workspaceId: input.workspaceId,
      run: async () => {
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
