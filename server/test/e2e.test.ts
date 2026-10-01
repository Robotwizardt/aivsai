/**
 * 端到端集成测试：真实 QuickJS 沙箱 + 坦克游戏包 + API 全链路。
 * 验证：兑换工作台 → 创建参赛对象 → 发布策略 → 发起对局 →
 * 直播帧流/结果 → 排行榜积分。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { initDatabase } from '../src/db/database.js';
import { QuickJsSandboxFactory } from '../src/engine/quickjs-sandbox.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';
import { LiveHub } from '../src/engine/live-hub.js';
import { MatchRunner } from '../src/engine/match-runner.js';
import { Scheduler } from '../src/engine/scheduler.js';
import { MatchOrchestrator } from '../src/engine/match-orchestrator.js';
import { WorkspaceService } from '../src/services/workspace-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import { tankGamePackage } from '../src/games/tank/tank-game.js';
import { tankBots } from '../src/games/tank/bots.js';
import type { GameDefinition } from '../src/games/contracts.js';

/** 简单策略：朝敌人方向开火（出生即面对面，静止连发）。 */
const SIMPLE_STRATEGY = `
function onIdle(me, enemy, game) {
  // 双方出生在中央走廊两端且相向：静止持续开火即可命中
  if (me.cooldown === 0 && me.bullet === null) {
    me.fire();
  }
  me.speak('开火！');
}
`;

/** 崩溃策略：立即抛错。 */
const BROKEN_STRATEGY = `
function onIdle(me, enemy, game) {
  throw new Error('boom');
}
`;

interface Ctx {
  app: ReturnType<Awaited<ReturnType<typeof buildApp>> extends never ? never : never> | {
    inject: (opts: Record<string, unknown>) => Promise<{ statusCode: number; json(): unknown; body: string }>;
  };
}

const ctx: { app: Ctx['app'] } = { app: null as unknown as Ctx['app'] };

beforeAll(async () => {
  const gamePackages = new Map([['tank', tankGamePackage]]);
  const games = new Map<string, GameDefinition>(
    [...gamePackages.entries()].map(([id, pkg]) => [id, pkg.definition]),
  );
  const db = initDatabase(':memory:');
  const entrantService = new EntrantService(db);
  const workspaceService = new WorkspaceService(db);
  for (let i = 1; i <= 10; i++) workspaceService.addInviteCode(`E2E-CODE-${i}`);
  const strategyService = new StrategyService(db);
  const rankingService = new RankingService({
    getWorkspaceId: (id) => entrantService.get(id)?.workspaceId ?? null,
  });
  const store = new SQLiteMatchStore(db);
  const liveHub = new LiveHub();
  const runner = new MatchRunner({
    games: gamePackages,
    sandboxes: new QuickJsSandboxFactory(),
    store,
    liveHub,
    officialTickDelayMs: 0, // 测试不等节拍
  });
  const scheduler = new Scheduler({ pollMs: 0 });
  const orchestrator = new MatchOrchestrator({
    games: gamePackages,
    entrantService,
    strategyService,
    rankingService,
    runner,
    store,
    scheduler,
    bots: tankBots,
  });
  ctx.app = (await buildApp({
    workspaceService,
    entrantService,
    strategyService,
    rankingService,
    games,
    getMatch: (id) => store.get(id),
    listMatches: (gameId) => store.list(gameId ? { gameId } : undefined),
    liveHub,
    orchestrator,
    adminKey: 'test-admin',
  })) as unknown as Ctx['app'];
});

const auth = (credential: string) => ({ authorization: `Bearer ${credential}` });

let inviteSeq = 0;
function nextInviteCode(): string {
  inviteSeq += 1;
  if (inviteSeq > 10) throw new Error('测试邀请码耗尽');
  return `E2E-CODE-${inviteSeq}`;
}

async function createWorkspaceWithEntrant(
  source: string,
  entrantName: string,
): Promise<{ credential: string; entrantId: string }> {
  const inviteCode = nextInviteCode();
  const redeem = await ctx.app.inject({
    method: 'POST',
    url: '/api/workspaces/redeem',
    payload: { inviteCode, nickname: entrantName },
  });
  expect(redeem.statusCode).toBe(200);
  const ws = redeem.json() as { credential: string };
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/entrants',
    payload: {
      gameId: 'tank',
      name: entrantName,
      appearance: { preset: 'basic', color: '#3366cc', name: entrantName },
    },
    headers: auth(ws.credential),
  });
  expect(created.statusCode).toBe(201);
  const entrant = created.json() as { id: string };
  const published = await ctx.app.inject({
    method: 'POST',
    url: `/api/entrants/${entrant.id}/strategies/publish`,
    payload: { source },
    headers: auth(ws.credential),
  });
  expect(published.statusCode).toBe(200);
  return { credential: ws.credential, entrantId: entrant.id };
}

async function waitForMatchFinished(
  matchId: string,
  timeoutMs = 20_000,
): Promise<{ phase: string; result: { outcome: { kind: string } } | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    if (res.statusCode !== 200) throw new Error(`对局查询失败: ${res.statusCode}`);
    const summary = res.json() as { phase: string; result: { outcome: { kind: string } } | null };
    if (summary.phase === 'finished' || summary.phase === 'invalid') return summary;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('等待对局结束超时');
}

describe('端到端：工作台 → 参赛对象 → 策略 → 对局 → 排行榜', () => {
  it('训练对局全链路（training 快速完成）', async () => {
    const a = await createWorkspaceWithEntrant(SIMPLE_STRATEGY, 'alice-tank');
    const b = await createWorkspaceWithEntrant(SIMPLE_STRATEGY, 'bob-tank');

    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'training', myEntrantId: a.entrantId, opponentEntrantId: b.entrantId },
      headers: auth(a.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };

    const summary = await waitForMatchFinished(matchId);
    expect(summary.phase).toBe('finished');
    expect(['win', 'draw']).toContain(summary.result!.outcome.kind);

    // 训练对局对无凭证访客不可见（403）
    const frames = await ctx.app.inject({
      method: 'GET',
      url: `/api/matches/${matchId}/frames`,
    });
    expect(frames.statusCode).toBe(403);
  });

  it('正式对局计分入排行榜', async () => {
    // 正式对局不能自选对手，由系统随机匹配。
    // 注意：运行到本用例时库里已有此前用例建立的对象，候选不止一个，
    // 所以不能假设 a 一定会匹配到 b（bob-2）。只断言“我方被正确计分”，
    // 再依实际匹配到的对手分别校验胜/平两种合法结果。
    const a = await createWorkspaceWithEntrant(SIMPLE_STRATEGY, 'alice-2');
    const b = await createWorkspaceWithEntrant(BROKEN_STRATEGY, 'bob-2');

    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: a.entrantId },
      headers: auth(a.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };
    await waitForMatchFinished(matchId);

    const board = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard/tank' });
    expect(board.statusCode).toBe(200);
    const entries = (
      board.json() as {
        entries: Array<{ entrantId: string; score: number; wins: number; losses: number; draws: number }>;
      }
    ).entries;
    const mine = entries.find((e) => e.entrantId === a.entrantId);
    expect(mine).toBeDefined();
    // 我方恰好打完一场正式对局，无论胜负平都被计入
    expect(mine!.wins + mine!.losses + mine!.draws).toBe(1);

    const matchedBroken = entries.some((e) => e.entrantId === b.entrantId);
    if (matchedBroken) {
      // 匹配到崩溃策略：我方必胜、对方必掉分
      expect(mine!.wins).toBe(1);
      expect(mine!.score).toBeGreaterThan(1000);
    } else {
      // 匹配到同为 SIMPLE 的对象：平局（双方策略相同），我方积分不变
      expect(mine!.draws).toBe(1);
    }
  }, 30_000);

  it('崩溃策略被判负', async () => {
    const a = await createWorkspaceWithEntrant(BROKEN_STRATEGY, 'alice-3');
    const b = await createWorkspaceWithEntrant(SIMPLE_STRATEGY, 'bob-3');

    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'training', myEntrantId: a.entrantId, opponentEntrantId: b.entrantId },
      headers: auth(a.credential),
    });
    const { matchId } = started.json() as { matchId: string };
    const summary = await waitForMatchFinished(matchId);
    expect(summary.phase).toBe('finished');
    expect(summary.result!.outcome.kind).toBe('win');
  });

  it('重复使用已兑换的邀请码被拒', async () => {
    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'E2E-CODE-1' },
    });
    expect(redeem.statusCode).toBe(400);
  });

  it('任何人可用内置基准 bot 发起对局（standard-01）', async () => {
    const a = await createWorkspaceWithEntrant(SIMPLE_STRATEGY, 'bench-challenger');

    // 公开游戏列表携带基准 bot（无需认证）
    const games = await ctx.app.inject({ method: 'GET', url: '/api/games' });
    const gameList = (games.json() as { games: Array<{ id: string; bots?: Array<{ id: string }> }> })
      .games;
    const tank = gameList.find((g) => g.id === 'tank');
    expect(tank?.bots?.some((b) => b.id === 'standard-01')).toBe(true);

    // 与基准 bot 打训练对局：能创建、能跑完、对手方记为 bot:standard-01
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: a.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(a.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };
    const summary = await waitForMatchFinished(matchId);
    expect(summary.phase).toBe('finished');
    expect(summary.entrants[1]?.entrantId).toBe('bot:standard-01');
    expect(['win', 'draw']).toContain(summary.result!.outcome.kind);

    // botId 与 opponentEntrantId 同时指定 → 400
    const both = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: a.entrantId,
        opponentBotId: 'standard-01',
        opponentEntrantId: a.entrantId,
      },
      headers: auth(a.credential),
    });
    expect(both.statusCode).toBe(400);

    // botId 与 opponentEntrantId 都不指定 → 400
    const neither = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'training', myEntrantId: a.entrantId },
      headers: auth(a.credential),
    });
    expect(neither.statusCode).toBe(400);

    // 无效 botId → 400
    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: a.entrantId,
        opponentBotId: 'no-such-bot',
      },
      headers: auth(a.credential),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('基准 bot 不能用于正式对局（基准是用来测的，不是用来爬分的）', async () => {
    const before = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard/tank' });
    const beforeEntries = (
      before.json() as { entries: Array<{ entrantId: string; score: number }> }
    ).entries;
    expect(beforeEntries.some((e) => e.entrantId.startsWith('bot:'))).toBe(false);

    const a = await createWorkspaceWithEntrant(SIMPLE_STRATEGY, 'bench-ranker');
    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'official',
        myEntrantId: a.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(a.credential),
    });
    // 正式对局只能随机匹配真人对手，指定 bot 被拒 → 排行榜不受影响
    expect(started.statusCode).toBe(400);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard/tank' });
    const afterEntries = (
      after.json() as { entries: Array<{ entrantId: string; score: number }> }
    ).entries;
    expect(afterEntries.some((e) => e.entrantId.startsWith('bot:'))).toBe(false);
    expect(afterEntries.length).toBe(beforeEntries.length);
  });
});
