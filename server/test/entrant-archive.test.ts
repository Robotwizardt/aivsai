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
  orchestrator: MatchOrchestrator;
  createTank: (
    source?: string,
    nickname?: string,
  ) => Promise<{ credential: string; entrantId: string }>;
  createTankWithoutStrategy: (nickname: string) => Promise<{ credential: string; entrantId: string }>;
  /** 在指定工作台下新建参赛对象（不发布策略）。 */
  createEntrant: (credential: string, name: string) => Promise<string>;
  /** 为指定参赛对象发布一版策略。 */
  publish: (credential: string, entrantId: string, source: string) => Promise<void>;
  waitFinished: (matchId: string) => Promise<string>;
}

interface SetupOptions {
  /** 调度器总并发上限；用于构造「已受理、还在排队」的对局。 */
  maxConcurrent?: number;
  /** 单工作台并行上限（默认 2）；设为 1 就能把同工作台的对局长时间卡在排队里。 */
  perWorkspace?: number;
  /** 官方对局每 tick 延迟（毫秒）；>0 让对局在测试里持续一段时间，占住调度槽。 */
  officialTickDelayMs?: number;
}

async function setup(options: SetupOptions = {}): Promise<TestApp> {
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
    officialTickDelayMs: options.officialTickDelayMs ?? 0,
  });
  const scheduler = new Scheduler({
    pollMs: 0,
    maxConcurrent: options.maxConcurrent,
    perWorkspace: options.perWorkspace,
  });
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
    // 与 index.ts 同一口径（组合逻辑在 orchestrator 里，只此一处）。
    hasLiveMatch: (entrantId) => orchestrator.hasLiveMatch(entrantId),
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
    orchestrator,
    createTank,
    createEntrant,
    publish,
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

  it('排队中的对局也算「进行中」：调度槽被占、对局还在排队时删除 → 409', async () => {
    const t = await setup({ maxConcurrent: 1, officialTickDelayMs: 20 });
    const holder = await t.createTank(SIMPLE_STRATEGY, 'slot-holder');
    // 诱饵：占槽的那场要匹配它（random: 0 → 按 listAll() 顺序取第一个），
    // 这样受害者不出现在任何已落库的对局里，才能真正测到「排队窗口」。
    const decoy = await t.createTank(SIMPLE_STRATEGY, 'decoy');
    await new Promise((r) => setTimeout(r, 5));
    const victim = await t.createTank(SIMPLE_STRATEGY, 'queued-victim');
    const holderWs = t.entrantService.get(holder.entrantId)!.workspaceId;

    // 第一场占满唯一的并发槽（官方对局 20ms/tick → 要跑满 300 tick 才结束）。
    const occupying = await t.orchestrator.start({
      gameId: 'tank',
      kind: 'official',
      myEntrantId: holder.entrantId,
      workspaceId: holderWs,
      random: () => 0,
    });
    expect(occupying.ok).toBe(true);
    if (!occupying.ok) return;
    expect(t.store.get(occupying.matchId)?.entrants.map((e) => e.entrantId)).toContain(
      decoy.entrantId,
    );
    // 前提：受害者不在任何已落库的对局里（守卫只能查对局表，看不到它）。
    expect(matchStoreHasLiveMatch(t.store, victim.entrantId)).toBe(false);

    // 第二场只能排队：调度器受理了，但还没轮到 runner，对局表里查不到它。
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: victim.entrantId },
      headers: auth(victim.credential),
    });
    expect(second.statusCode).toBe(202);
    const queuedId = (second.json() as { matchId: string }).matchId;
    expect(t.store.get(queuedId)).toBeFalsy();

    // 关键断言：排队中同样是「进行中」，删除必须被拦下。
    const blocked = await archive(t.app, victim.entrantId, victim.credential);
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toContain('对局进行中');

    // 两场都跑完后可以删。
    await t.waitFinished(occupying.matchId);
    await t.waitFinished(queuedId);
    expect((await archive(t.app, victim.entrantId, victim.credential)).statusCode).toBe(200);
  }, 40_000);

  it('训练对局（对手是内置 bot）排队时也挡住删除', async () => {
    const t = await setup({ maxConcurrent: 1, officialTickDelayMs: 20 });
    const holder = await t.createTank(SIMPLE_STRATEGY, 'slot-holder-bot');
    const decoy = await t.createTank(SIMPLE_STRATEGY, 'decoy-bot');
    await new Promise((r) => setTimeout(r, 5));
    const victim = await t.createTank(SIMPLE_STRATEGY, 'queued-bot-trainer');
    const holderWs = t.entrantService.get(holder.entrantId)!.workspaceId;

    // 占满唯一的并发槽（随机取到的对手是诱饵，不是受害者）。
    const occupying = await t.orchestrator.start({
      gameId: 'tank',
      kind: 'official',
      myEntrantId: holder.entrantId,
      workspaceId: holderWs,
      random: () => 0,
    });
    expect(occupying.ok).toBe(true);
    if (!occupying.ok) return;

    // 对手是内置 bot 的训练对局：start 要等它跑完才返回，此刻它正卡在队列里。
    const training = t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: victim.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(victim.credential),
    });
    // 等请求走到 enqueue（bot 对局不落库，队列是它能被看见的唯一地方）。
    await new Promise((r) => setTimeout(r, 50));

    const blocked = await archive(t.app, victim.entrantId, victim.credential);
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toContain('对局进行中');

    // 占槽那场结束后训练对局才能跑，跑完再删就放行了。
    const trained = await training;
    expect(trained.statusCode).toBe(202);
    await t.waitFinished(occupying.matchId);
    await t.waitFinished((trained.json() as { matchId: string }).matchId);
    expect((await archive(t.app, victim.entrantId, victim.credential)).statusCode).toBe(200);
  }, 40_000);

  it('同一对象多场排队时，先结束的那场不会把还在排队的另一场一并放行', async () => {
    // perWorkspace=1：同工作台同时只跑一场，好让「排队」这个状态持续足够久。
    const t = await setup({ maxConcurrent: 2, perWorkspace: 1, officialTickDelayMs: 10 });
    // 诱饵最先建：random:0 取 listAll() 第一个候选，这样两场官方对局都不含受害者。
    const decoy = await t.createTank(SIMPLE_STRATEGY, 'refcount-decoy');
    await new Promise((r) => setTimeout(r, 5));
    const victim = await t.createTank(SIMPLE_STRATEGY, 'refcount-victim');
    await new Promise((r) => setTimeout(r, 5));
    // 拦截者必须与受害者同一工作台（才能争抢同一个工作台并行名额）。
    const blockerId = await t.createEntrant(victim.credential, 'refcount-blocker');
    await t.publish(victim.credential, blockerId, SIMPLE_STRATEGY);
    const blocker = { credential: victim.credential, entrantId: blockerId };
    const workspaceId = t.entrantService.get(victim.entrantId)!.workspaceId;
    expect(t.entrantService.get(blocker.entrantId)!.workspaceId).toBe(workspaceId);

    // official 的 start() 先返回 matchId，记录要等开跑那一刻才落库（轮询等一下）。
    const opponentsOf = async (matchId: string): Promise<string[]> => {
      for (let i = 0; i < 200; i += 1) {
        const record = t.store.get(matchId);
        if (record) return record.entrants.map((e) => e.entrantId);
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`对局记录未落库: ${matchId}`);
    };

    // 第一场：受害者的官方对局，占住工作台唯一的并行名额。
    const first = await t.orchestrator.start({
      gameId: 'tank',
      kind: 'official',
      myEntrantId: victim.entrantId,
      workspaceId,
      random: () => 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 对手是诱饵（不是受害者自己、也不是拦截者）：random:0 取 listAll() 第一个候选。
    expect(await opponentsOf(first.matchId)).toContain(decoy.entrantId);

    // 第二场：受害者的训练对局（对手是 bot）→ 工作台名额被占，只能排队。
    const training = t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: victim.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(victim.credential),
    });

    // 第三场：同工作台另一个对象的官方对局。优先级高于训练对局，
    // 第一场结束后它抢走名额，第二场继续排队——这正是「先结束的那场不该放行还在排队的那场」的窗口。
    const third = await t.orchestrator.start({
      gameId: 'tank',
      kind: 'official',
      myEntrantId: blocker.entrantId,
      workspaceId,
      random: () => 0,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    // 第三场的对手也必须是诱饵：受害者一旦进了第三场，本用例就失去了区分度。
    expect(await opponentsOf(third.matchId)).toContain(decoy.entrantId);

    // 让第一场跑完、第三场开跑、第二场继续排队。
    await t.waitFinished(first.matchId);
    await new Promise((r) => setTimeout(r, 50));
    // 前提：受害者不在任何进行中的对局里——对局表是查不到它的，只有排队登记能看见它。
    expect(matchStoreHasLiveMatch(t.store, victim.entrantId)).toBe(false);

    const blocked = await archive(t.app, victim.entrantId, victim.credential);
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toContain('对局进行中');

    // 全部跑完后可以删。
    expect((await training).statusCode).toBe(202);
    await t.waitFinished(third.matchId);
    expect((await archive(t.app, victim.entrantId, victim.credential)).statusCode).toBe(200);
  }, 40_000);

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
