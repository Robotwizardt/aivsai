/**
 * Agent 工作流 API 测试（vitest + fastify.inject）。
 * 覆盖：/api/agent/context 聚合、/api/agent/simulate（401/400/429/200）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { initDatabase } from '../src/db/database.js';
import { WorkspaceService } from '../src/services/workspace-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import { AgentApiService } from '../src/services/agent-api-service.js';
import { QuickJsSandboxFactory } from '../src/engine/quickjs-sandbox.js';
import { tankGamePackage } from '../src/games/tank/tank-game.js';
import { tankBots } from '../src/games/tank/bots.js';
import type { GameDefinition } from '../src/games/contracts.js';

const ADMIN_KEY = 'test-admin-key';

const tankGame: GameDefinition = {
  id: 'tank',
  name: '坦克大战',
  pacing: 'instant',
  actionNames: ['move', 'turn', 'fire'],
};

/** 可控时钟：限流测试用。 */
function makeClock(start = 1_000_000) {
  let now = start;
  return { clock: () => now, advance: (ms: number) => (now += ms), now: () => now };
}

function makeServices() {
  const db = initDatabase(':memory:');
  const entrantService = new EntrantService(db);
  const workspaceService = new WorkspaceService(db, {
    onWorkspaceReset: (workspaceId) => {
      entrantService.revokeAllForWorkspace(workspaceId);
    },
  });
  const strategyService = new StrategyService(db);
  const rankingService = new RankingService();
  return { workspaceService, entrantService, strategyService, rankingService };
}

async function makeApp(opts?: { clock?: () => number }) {
  const services = makeServices();
  const games = new Map<string, GameDefinition>([['tank', tankGame]]);
  const gameVersions = new Map<string, string>([['tank@v1', 'tank']]);
  const agentApi = new AgentApiService({
    sandboxes: new QuickJsSandboxFactory(),
    tankGame: tankGamePackage,
    ...(opts?.clock ? { now: opts.clock } : {}),
  });
  const app = await buildApp({
    ...services,
    games,
    gameVersions,
    agentApi,
    adminKey: ADMIN_KEY,
  });
  return { app, ...services, agentApi };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** 兑换邀请码 → 创建参赛对象 → 颁发对象凭证 → 发布策略。 */
async function setupEntrant(
  app: FastifyInstance,
  entrantService: EntrantService,
  strategyService: StrategyService,
  opts: { name: string; source?: string | null },
): Promise<{ entrantId: string; entrantToken: string; versionId: number }> {
  const redeem = await app.inject({
    method: 'POST',
    url: '/api/workspaces/redeem',
    payload: { inviteCode: opts.name, nickname: opts.name },
  });
  expect(redeem.statusCode).toBe(200);
  const ws = redeem.json() as { workspaceId: string; credential: string };

  const created = await app.inject({
    method: 'POST',
    url: '/api/entrants',
    payload: {
      gameId: 'tank',
      name: opts.name,
      appearance: { preset: 'light-tank', color: '#3366cc', name: opts.name },
    },
    headers: auth(ws.credential),
  });
  expect(created.statusCode).toBe(201);
  const entrantId = (created.json() as { id: string }).id;

  const entrantToken = entrantService.issueEntrantCredential(entrantId);
  expect(entrantToken).toBeTruthy();

  if (opts.source !== null) {
    const version = strategyService.publish(entrantId, opts.source ?? 'function onIdle(){}');
    return { entrantId, entrantToken: entrantToken!, versionId: version.versionId };
  }
  return { entrantId, entrantToken: entrantToken!, versionId: 0 };
}

describe('GET /api/agent/context', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
    ctx.workspaceService.addInviteCode('CTX-CODE');
    ctx.workspaceService.addInviteCode('CTX-B');
  });

  it('未认证 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/agent/context' });
    expect(res.statusCode).toBe(401);
  });

  it('聚合 entrant/latestStrategy/bots/api/guide', async () => {
    const { entrantId, entrantToken } = await setupEntrant(
      ctx.app,
      ctx.entrantService,
      ctx.strategyService,
      { name: 'CTX-CODE', source: 'function onIdle(me){ me.fire(); }' },
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/agent/context',
      headers: auth(entrantToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.entrant).toMatchObject({ id: entrantId, name: 'CTX-CODE', gameId: 'tank', rating: 1000 });
    expect(typeof body.entrant.createdAt).toBe('number');
    expect(body.latestStrategy).toMatchObject({
      versionId: 1,
      code: 'function onIdle(me){ me.fire(); }',
      publicVisible: false,
    });
    expect(typeof body.latestStrategy.createdAt).toBe('number');

    // bots 列表与内置 bot 一致（不含源码）。
    expect(body.bots).toEqual(tankBots.map((b) => ({ id: b.id, name: b.name, description: b.description })));

    expect(body.api).toEqual({
      simulate: 'POST /api/agent/simulate',
      context: 'GET /api/agent/context',
      matches: 'POST /api/matches',
      strategies: 'POST /api/entrants/:id/strategies/publish',
    });
    expect(body.guide).toBe('/agent-guide');
  });

  it('没有已发布策略时 latestStrategy 为 null；对象凭证不能读别人的 context', async () => {
    const a = await setupEntrant(ctx.app, ctx.entrantService, ctx.strategyService, { name: 'CTX-CODE', source: null });
    const b = await setupEntrant(ctx.app, ctx.entrantService, ctx.strategyService, { name: 'CTX-B' });

    const self = await ctx.app.inject({
      method: 'GET',
      url: '/api/agent/context',
      headers: auth(a.entrantToken),
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().latestStrategy).toBeNull();
    expect(self.json().entrant.id).toBe(a.entrantId);

    // 对象凭证显式指定别人的 entrantId → 403。
    const cross = await ctx.app.inject({
      method: 'GET',
      url: `/api/agent/context?entrantId=${b.entrantId}`,
      headers: auth(a.entrantToken),
    });
    expect(cross.statusCode).toBe(403);
  });
});

describe('POST /api/agent/simulate', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
    ctx.workspaceService.addInviteCode('SIM-CODE');
    ctx.workspaceService.addInviteCode('SIM-B');
  });

  it('未认证 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(me){ me.fire(); }' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400：code 缺失 / 超长 / 坏 botId / 他人的 strategyVersionId 403', async () => {
    const a = await setupEntrant(ctx.app, ctx.entrantService, ctx.strategyService, { name: 'SIM-CODE' });
    const b = await setupEntrant(ctx.app, ctx.entrantService, ctx.strategyService, { name: 'SIM-B' });

    const noCode = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: {},
      headers: auth(a.entrantToken),
    });
    expect(noCode.statusCode).toBe(400);

    const tooLong = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'x'.repeat(201 * 1024) },
      headers: auth(a.entrantToken),
    });
    expect(tooLong.statusCode).toBe(400);

    const badBot = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}', opponent: { botId: 'not-a-bot' } },
      headers: auth(a.entrantToken),
    });
    expect(badBot.statusCode).toBe(400);

    // 别人的版本号 → 403（b 发布了 2 个版本，用第 2 个避免与 a 的版本号碰撞）。
    ctx.strategyService.publish(b.entrantId, 'function onIdle(me){ me.fire(); }');
    const foreignVersion = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}', opponent: { strategyVersionId: b.versionId + 1 } },
      headers: auth(a.entrantToken),
    });
    expect(foreignVersion.statusCode).toBe(403);

    // 不存在的版本号 → 400。
    const missingVersion = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}', opponent: { strategyVersionId: 999 } },
      headers: auth(a.entrantToken),
    });
    expect(missingVersion.statusCode).toBe(400);
  });

  it('429：同一参赛对象 2 秒内第 2 次试跑被限流；冷却后恢复', async () => {
    const { clock, advance } = makeClock();
    const rateCtx = await makeApp({ clock });
    rateCtx.workspaceService.addInviteCode('SIM-RATE');
    rateCtx.workspaceService.addInviteCode('SIM-RATE-B');
    const a = await setupEntrant(rateCtx.app, rateCtx.entrantService, rateCtx.strategyService, {
      name: 'SIM-RATE',
    });

    // 先跑一次有效试跑（消耗限流窗口）。
    const first = await rateCtx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}' },
      headers: auth(a.entrantToken),
    });
    expect(first.statusCode).toBe(200);

    const second = await rateCtx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}' },
      headers: auth(a.entrantToken),
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: '试跑冷却中，2 秒 1 次' });

    advance(2000);
    const third = await rateCtx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}' },
      headers: auth(a.entrantToken),
    });
    expect(third.statusCode).toBe(200);

    // 不同参赛对象互不影响（同一测试内只跑一次也验证了隔离）。
    const b = await setupEntrant(rateCtx.app, rateCtx.entrantService, rateCtx.strategyService, {
      name: 'SIM-RATE-B',
    });
    const other = await rateCtx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}' },
      headers: auth(b.entrantToken),
    });
    expect(other.statusCode).toBe(200);
  });

  it('200：对打内置 bot，返回 outcome + frames + stats + logs', async () => {
    const a = await setupEntrant(ctx.app, ctx.entrantService, ctx.strategyService, { name: 'SIM-CODE' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: {
        code: 'function onIdle(me, enemy, game){ if (me) me.fire(); }',
        opponent: { botId: 'crimson-bastion' },
      },
      headers: auth(a.entrantToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(['win', 'draw', 'invalid']).toContain(body.outcome.kind);
    if (body.outcome.kind === 'win') {
      expect(['self', 'opponent']).toContain(body.outcome.winner);
    }
    expect(typeof body.outcome.reason).toBe('string');
    expect(typeof body.ticks).toBe('number');
    expect(Array.isArray(body.frames)).toBe(true);
    if (body.frames.length > 0) {
      expect(body.frames[0]).toHaveProperty('tick');
      expect(body.frames[0]).toHaveProperty('state');
    }
    expect(body.selfName).toBe('self');
    expect(body.opponentName).toContain('Crimson');
    expect(body.selfStats).toHaveProperty('hp');
    expect(body.opponentStats).toHaveProperty('hp');
    expect(Array.isArray(body.logs.self)).toBe(true);
    expect(Array.isArray(body.logs.opponent)).toBe(true);

    // 试跑不产生对局记录、不产生策略版本。
    const matches = await ctx.app.inject({ method: 'GET', url: '/api/matches' });
    expect(matches.json().matches).toEqual([]);
    expect(ctx.strategyService.listVersions(a.entrantId)).toHaveLength(1);
  });

  it('200：strategyVersionId 自打自（对手为该参赛对象已发布版本）', async () => {
    const a = await setupEntrant(ctx.app, ctx.entrantService, ctx.strategyService, {
      name: 'SIM-CODE',
      source: 'function onIdle(me){ if (me) me.fire(); }',
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/simulate',
      payload: { code: 'function onIdle(){}', opponent: { strategyVersionId: a.versionId } },
      headers: auth(a.entrantToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(['win', 'draw', 'invalid']).toContain(body.outcome.kind);
    expect(body.opponentName).toContain('#v');
  });
});

describe('内置训练 bot', () => {
  it('standard-01 存在且排在首位（官方基准）', () => {
    expect(tankBots[0]!.id).toBe('standard-01');
    expect(tankBots.some((b) => b.id === 'standard-01')).toBe(true);
  });

  it('standard-01 与其他 bot 对打正常结束（非 invalid）', async () => {
    const service = new AgentApiService({
      sandboxes: new QuickJsSandboxFactory(),
      tankGame: tankGamePackage,
    });
    const standard = tankBots.find((b) => b.id === 'standard-01')!;
    for (const other of ['nova-scout', 'crimson-bastion']) {
      const foe = tankBots.find((b) => b.id === other)!;
      const result = await service.run(
        { code: standard.code, opponent: {} },
        foe.name,
        foe.code,
      );
      expect(result.outcome.kind).not.toBe('invalid');
      expect(result.frames.length).toBeGreaterThan(0);
    }
  });

  it('nova-scout 与 crimson-bastion 代码可被沙箱载入且不抛错', async () => {
    const service = new AgentApiService({
      sandboxes: new QuickJsSandboxFactory(),
      tankGame: tankGamePackage,
    });
    const result = await service.run(
      { code: tankBots[0]!.code, opponent: {} },
      tankBots[1]!.name,
      tankBots[1]!.code,
    );
    // 两 bot 对打必须正常结束（不 invalid），结果不重要。
    expect(result.outcome.kind).not.toBe('invalid');
    expect(result.frames.length).toBeGreaterThan(0);
  });
});
