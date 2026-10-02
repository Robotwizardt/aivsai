/**
 * 删除（归档）参赛对象测试。
 *
 * 被测接缝：HTTP `DELETE /api/entrants/:id`，以及受归档影响的读侧——
 * `GET /api/entrants`、`POST /api/matches`、`GET /api/leaderboard/:gameId`、
 * `GET /api/matches/:id`（历史对局）、`POST /api/entrants/:id/strategies/publish`。
 *
 * 已定语义（用户拍板）：
 * - 归档 = 不可恢复，只为误删留数据，不提供恢复入口；
 * - 留对局（历史对局/回放完整保留、名字仍在）、移排行榜（含启动重算后不复活）；
 * - 有进行中的对局 → 409 拒绝，提示稍后再试；
 * - 只有工作台凭证可以删（对象凭证 401）。
 *
 * 每个用例独立建库（fresh in-memory），不依赖任何只有测试才用的生产代码入口。
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { initDatabase } from '../src/db/database.js';
import { QuickJsSandboxFactory } from '../src/engine/quickjs-sandbox.js';
import { SQLiteMatchStore, matchStoreHasLiveMatch } from '../src/engine/match-store.js';
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

/** 静止开火策略（能跑完对局）。 */
const SIMPLE_STRATEGY = `
function onIdle(me, enemy, game) {
  if (me.cooldown === 0 && me.bullet === null) me.fire();
}
`;

/** 崩溃策略：立即抛错 → 被判负。用于让正式对局强制分出胜负。 */
const BROKEN_STRATEGY = `
function onIdle(me, enemy, game) {
  throw new Error('boom');
}
`;

interface TestApp {
  app: {
    inject: (opts: {
      method: string;
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }) => Promise<{ statusCode: number; json(): unknown; body: string }>;
  };
  rankingService: RankingService;
  entrantService: EntrantService;
  store: SQLiteMatchStore;
  createTank: (
    source?: string,
    nickname?: string,
  ) => Promise<{ credential: string; entrantId: string }>;
  createTankWithoutStrategy: (nickname: string) => Promise<{ credential: string; entrantId: string }>;
  /** 在指定工作台下新建参赛对象（不发布策略）。 */
  createEntrant: (credential: string, name: string) => Promise<string>;
  waitFinished: (matchId: string) => Promise<string>;
}

async function setup(): Promise<TestApp> {
  const gamePackages = new Map([['tank', tankGamePackage]]);
  const games = new Map<string, GameDefinition>(
    [...gamePackages.entries()].map(([id, pkg]) => [id, pkg.definition]),
  );
  const db = initDatabase(':memory:');
  const entrantService = new EntrantService(db);
  const workspaceService = new WorkspaceService(db);
  const strategyService = new StrategyService(db);
  const store = new SQLiteMatchStore(db);
  const rankingService = new RankingService({
    getWorkspaceId: (id) => entrantService.get(id)?.workspaceId ?? null,
    // 与 index.ts 同一口径：查不到的对象（如 bot）视为仍在役，只有明确归档的才排除。
    isEntrantActive: (id) => {
      const e = entrantService.get(id);
      return e === null || e.archivedAt === null;
    },
    // 与 index.ts 同一口径：rebuild() 从对局表重放（重启恢复路径必须能重算出同一份榜）。
    matchStore: store,
  });
  const liveHub = new LiveHub();
  const runner = new MatchRunner({
    games: gamePackages,
    sandboxes: new QuickJsSandboxFactory(),
    store,
    liveHub,
    officialTickDelayMs: 0,
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
  const app = (await buildApp({
    workspaceService,
    entrantService,
    strategyService,
    rankingService,
    games,
    getMatch: (id) => store.get(id),
    listMatches: (filter) => store.list(filter),
    countMatches: (filter) => store.count(filter),
    liveHub,
    orchestrator,
    adminKey: 'test-admin',
    hasLiveMatch: (entrantId) => matchStoreHasLiveMatch(store, entrantId),
  })) as unknown as TestApp['app'];

  let seq = 0;

  const redeemWorkspace = async (nickname: string): Promise<string> => {
    seq += 1;
    const code = `ARCHIVE-CODE-${seq}`;
    workspaceService.addInviteCode(code);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: code, nickname },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { credential: string }).credential;
  };

  const createEntrant = async (credential: string, name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name,
        appearance: { preset: 'basic', color: '#3366cc', name },
      },
      headers: auth(credential),
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };

  const publish = async (credential: string, entrantId: string, source: string): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/strategies/publish`,
      payload: { source },
      headers: auth(credential),
    });
    expect(res.statusCode).toBe(200);
  };

  const createTank = async (source = SIMPLE_STRATEGY, nickname = `tank-${seq + 1}`) => {
    const credential = await redeemWorkspace(nickname);
    const entrantId = await createEntrant(credential, nickname);
    await publish(credential, entrantId, source);
    return { credential, entrantId };
  };

  return {
    app,
    rankingService,
    entrantService,
    store,
    createTank,
    createEntrant,
    createTankWithoutStrategy: async (nickname) => {
      const credential = await redeemWorkspace(nickname);
      const entrantId = await createEntrant(credential, nickname);
      return { credential, entrantId };
    },
    waitFinished: async (matchId) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
        const summary = res.json() as { phase: string };
        if (summary.phase === 'finished' || summary.phase === 'invalid') return summary.phase;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('等待对局结束超时');
    },
  };
}

const auth = (credential: string) => ({ authorization: `Bearer ${credential}` });

const archive = (
  app: TestApp['app'],
  entrantId: string,
  credential: string,
): Promise<{ statusCode: number; json(): unknown }> =>
  app.inject({ method: 'DELETE', url: `/api/entrants/${entrantId}`, headers: auth(credential) });

describe('删除参赛对象（归档）', () => {
  it('工作台凭证归档：列表消失、对象凭证吊销、历史对局保留、排行榜移除且重算不复活', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'keeper');
    const opp = await t.createTank(BROKEN_STRATEGY, 'doomed');

    // 先打一场正式的，让双方都上排行榜（me 赢，opp 输）。
    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };
    expect(await t.waitFinished(matchId)).toBe('finished');

    const before = await t.app.inject({ method: 'GET', url: '/api/leaderboard/tank' });
    expect((before.json() as { entries: unknown[] }).entries).toHaveLength(2);

    // 归档前先给 opp 发一个对象凭证（模拟已委托给外部 Agent 管理）。
    const issued = await t.app.inject({
      method: 'POST',
      url: `/api/entrants/${opp.entrantId}/credential`,
      headers: auth(opp.credential),
    });
    expect(issued.statusCode).toBe(200);
    const oppEntrantToken = (issued.json() as { credential: string }).credential;
    const tokenWorks = await t.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(oppEntrantToken),
    });
    expect(tokenWorks.statusCode).toBe(200);

    // 归档 opp。
    const res = await archive(t.app, opp.entrantId, opp.credential);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entrantId: opp.entrantId, archived: true });

    // 1) 工作台的参赛对象列表里不再有它。
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(opp.credential),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { entrants: unknown[] }).entrants).toHaveLength(0);

    // 2) 对象凭证被吊销：Agent 立刻失去该对象的授权。
    const revoked = await t.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(oppEntrantToken),
    });
    expect(revoked.statusCode).toBe(401);

    // 3) 历史对局完整保留，且名字仍解析得到（观战/回放不受影响）。
    const detail = await t.app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    const names = (detail.json() as { entrants: Array<{ name: string | null }> }).entrants.map(
      (e) => e.name,
    );
    expect(names).toContain('doomed');

    // 4) 排行榜移除它，保留另一方。
    const after = await t.app.inject({ method: 'GET', url: '/api/leaderboard/tank' });
    const entries = (after.json() as { entries: Array<{ entrantId: string }> }).entries;
    expect(entries.map((e) => e.entrantId)).toEqual([me.entrantId]);

    // 5) 服务重启后从对局表重算，已归档对象不会「复活」回榜上。
    t.rankingService.rebuild();
    expect(t.rankingService.getLeaderboard('tank').map((e) => e.entrantId)).toEqual([
      me.entrantId,
    ]);
  }, 30_000);

  it('对象凭证不能删除参赛对象（只有工作台凭证可以）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'only-ws');

    const issued = await t.app.inject({
      method: 'POST',
      url: `/api/entrants/${me.entrantId}/credential`,
      headers: auth(me.credential),
    });
    expect(issued.statusCode).toBe(200);
    const entrantToken = (issued.json() as { credential: string }).credential;

    const res = await archive(t.app, me.entrantId, entrantToken);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toContain('工作台凭证');

    // 没删掉：对象仍在列表里。
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(me.credential),
    });
    expect((list.json() as { entrants: unknown[] }).entrants).toHaveLength(1);
  });

  it('跨工作台删除 → 401，且对象未受影响', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'mine');
    const other = await t.createTank(SIMPLE_STRATEGY, 'theirs');

    const res = await archive(t.app, other.entrantId, me.credential);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toContain('无权');

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(other.credential),
    });
    expect((list.json() as { entrants: unknown[] }).entrants).toHaveLength(1);
  });

  it('重复删除 / 不存在的对象 → 404', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'twice');

    expect((await archive(t.app, me.entrantId, me.credential)).statusCode).toBe(200);
    const again = await archive(t.app, me.entrantId, me.credential);
    expect(again.statusCode).toBe(404);
    expect((again.json() as { error: string }).error).toContain('不存在');

    const missing = await archive(t.app, randomUUID(), me.credential);
    expect(missing.statusCode).toBe(404);
  });

  it('归档释放配额：删掉一个后能再新建', async () => {
    const t = await setup();
    // 同一个工作台里建满 10 个（配额上限默认 10）。
    const first = await t.createTankWithoutStrategy('quota-1');
    for (let i = 2; i <= 10; i++) {
      await t.createEntrant(first.credential, `quota-${i}`);
    }
    const newEntrant = (name: string) => ({
      gameId: 'tank',
      name,
      appearance: { preset: 'basic', color: '#3366cc', name },
    });

    // 配额已满。
    const full = await t.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: newEntrant('quota-11'),
      headers: auth(first.credential),
    });
    expect(full.statusCode).toBe(400);

    expect((await archive(t.app, first.entrantId, first.credential)).statusCode).toBe(200);

    const afterArchive = await t.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: newEntrant('quota-11'),
      headers: auth(first.credential),
    });
    expect(afterArchive.statusCode).toBe(201);
  });

  it('有对局进行中 → 409 提示稍后再试；对局结束后可以删', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'busy');

    // 直接落一条 running 的对局记录，模拟「正在对局中」。
    const matchId = randomUUID();
    t.store.create({
      matchId,
      gameId: 'tank',
      kind: 'training',
      entrants: [
        { entrantId: me.entrantId, strategyVersionId: 'v1' },
        { entrantId: `bot:standard-01`, strategyVersionId: 'bot' },
      ],
    });

    const blocked = await archive(t.app, me.entrantId, me.credential);
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toContain('对局进行中');

    // 仍在列表里（没被删掉）。
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(me.credential),
    });
    expect((list.json() as { entrants: unknown[] }).entrants).toHaveLength(1);

    t.store.finish(matchId, { outcome: { kind: 'draw', reason: 'max-ticks' }, failures: [] }, 'finished');
    expect((await archive(t.app, me.entrantId, me.credential)).statusCode).toBe(200);
  });

  it('归档后不再进匹配池：它是唯一候选时，对方正式对局返回 409', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'survivor');
    const doomed = await t.createTank(SIMPLE_STRATEGY, 'gone');

    // 归档前能匹配到（唯一候选就是它）。
    const before = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(before.statusCode).toBe(202);
    await t.waitFinished((before.json() as { matchId: string }).matchId);

    expect((await archive(t.app, doomed.entrantId, doomed.credential)).statusCode).toBe(200);

    const after = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(after.statusCode).toBe(409);
    expect((after.json() as { error: string }).error).toContain('稍后再试');
  }, 30_000);

  it('归档后不能再作为发起方或对手发起对局 → 404', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'ghost');
    const other = await t.createTank(SIMPLE_STRATEGY, 'alive');

    expect((await archive(t.app, me.entrantId, me.credential)).statusCode).toBe(200);

    // 发起方已归档（用工作台凭证，绕开已被吊销的对象凭证）。
    const asInitiator = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'training', myEntrantId: me.entrantId, opponentBotId: 'standard-01' },
      headers: auth(me.credential),
    });
    expect(asInitiator.statusCode).toBe(404);

    // 指定已归档对象当对手。
    const asOpponent = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: other.entrantId,
        opponentEntrantId: me.entrantId,
      },
      headers: auth(other.credential),
    });
    expect(asOpponent.statusCode).toBe(404);
  });

  it('归档后不能再发布策略、不能颁发凭证（工作台凭证也读不到它的策略）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'frozen');
    expect((await archive(t.app, me.entrantId, me.credential)).statusCode).toBe(200);

    const publish = await t.app.inject({
      method: 'POST',
      url: `/api/entrants/${me.entrantId}/strategies/publish`,
      payload: { source: SIMPLE_STRATEGY },
      headers: auth(me.credential),
    });
    expect(publish.statusCode).toBe(404);

    const issue = await t.app.inject({
      method: 'POST',
      url: `/api/entrants/${me.entrantId}/credential`,
      headers: auth(me.credential),
    });
    expect(issue.statusCode).toBe(404);

    const versions = await t.app.inject({
      method: 'GET',
      url: `/api/entrants/${me.entrantId}/strategies`,
      headers: auth(me.credential),
    });
    expect(versions.statusCode).toBe(404);
  });
});
