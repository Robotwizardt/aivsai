/**
 * HTTP API 与凭证管理测试（vitest + fastify.inject，不 listen）。
 * 覆盖：邀请码兑换、凭证恢复联动失效、对象凭证越权、Elo 计分与 24h 限额、管理路由认证。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { WorkspaceService } from '../src/services/workspace-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import type { GameDefinition } from '../src/games/contracts.js';
import { tankBots } from '../src/games/tank/bots.js';
import type { MatchRecord } from '../src/engine/match-contracts.js';

const ADMIN_KEY = 'test-admin-key';

const tankGame: GameDefinition = {
  id: 'tank',
  name: '坦克大战',
  pacing: 'instant',
  actionNames: ['move', 'fire'],
};

interface TestContext {
  app: FastifyInstance;
  workspaceService: WorkspaceService;
  entrantService: EntrantService;
  strategyService: StrategyService;
  rankingService: RankingService;
}

function makeServices(now: () => number = () => Date.now()) {
  const entrantService = new EntrantService();
  const workspaceService = new WorkspaceService({
    onWorkspaceReset: (workspaceId) => {
      // ADR 0002 恢复规则：作废该工作台下全部对象凭证与既有会话。
      entrantService.revokeAllForWorkspace(workspaceId);
    },
  });
  const strategyService = new StrategyService();
  const rankingService = new RankingService({ now });
  return { workspaceService, entrantService, strategyService, rankingService };
}

async function makeApp(services = makeServices()): Promise<TestContext> {
  const games = new Map<string, GameDefinition>([['tank', tankGame]]);
  const gameVersions = new Map<string, string>([['tank@v1', 'tank']]);
  const app = await buildApp({
    ...services,
    games,
    gameVersions,
    adminKey: ADMIN_KEY,
  });
  return { app, ...services };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Elo 期望得分（标准公式，与 RankingService 实现无关的独立复算）。 */
function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

/** 构造一场已结束的正式对局记录（供 RankingService.applyResult）。 */
function makeMatch(
  aId: string,
  bId: string,
  winner: 0 | 1 | 'draw',
  gameVersionId = 'tank@v1',
): MatchRecord {
  const outcome =
    winner === 'draw'
      ? { kind: 'draw' as const, reason: 'timeout' }
      : { kind: 'win' as const, winner, reason: 'ko' };
  return {
    matchId: `m-${aId}-${bId}-${Math.random().toString(36).slice(2, 8)}`,
    gameId: 'tank',
    gameVersionId,
    entrants: [
      { entrantId: aId, strategyVersionId: '1' },
      { entrantId: bId, strategyVersionId: '1' },
    ],
    kind: 'official',
    createdAt: Date.now(),
    phase: 'finished',
    frames: [],
    result: { outcome, failures: [] },
  };
}

describe('邀请码与工作台凭证', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    ctx.workspaceService.addInviteCode('INVITE-ONE');
    ctx.workspaceService.addInviteCode('INVITE-TWO');
    ctx.workspaceService.addInviteCode('INVITE-CRED');
    ctx.workspaceService.addInviteCode('INVITE-ESC');
  });

  it('兑换邀请码创建工作台，凭证可访问 /api/entrants（空列表）', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'INVITE-ONE', nickname: '小张' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceId).toBeTruthy();
    expect(body.credential).toMatch(/^.{32,}$/);
    expect(body.recoveryCode).toMatch(/^.{32,}$/);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(body.credential),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ entrants: [] });

    // 未认证访问业务路由 401。
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/entrants' });
    expect(anon.statusCode).toBe(401);
  });

  it('错误邀请码 400；重复使用已兑换邀请码 400', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'NOT-A-CODE' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toHaveProperty('error');

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'INVITE-ONE' },
    });
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'INVITE-ONE' },
    });
    expect(second.statusCode).toBe(400);
  });

  it('恢复码重置：旧凭证 401、新凭证可用、旧对象凭证失效', async () => {
    const created = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'INVITE-ONE' },
      })
    ).json();
    const wsId = created.workspaceId;

    // 在工作台下创建参赛对象并颁发对象凭证。
    const entrant = ctx.entrantService.createEntrant(wsId, {
      gameId: 'tank',
      name: 'T1',
      appearance: { preset: 'light-tank', color: '#ff0000', name: '红方' },
    });
    const entrantToken = ctx.entrantService.issueEntrantCredential(entrant.id);
    expect(entrantToken).toBeTruthy();

    // 对象凭证重置前可用。
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(entrantToken!),
    });
    expect(before.statusCode).toBe(200);

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/reset`,
      payload: { recoveryCode: created.recoveryCode },
    });
    expect(reset.statusCode).toBe(200);
    const renewed = reset.json();
    expect(renewed.credential).not.toBe(created.credential);
    expect(renewed.recoveryCode).not.toBe(created.recoveryCode);

    // 旧工作台凭证 401，新凭证可用。
    const oldCred = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(created.credential),
    });
    expect(oldCred.statusCode).toBe(401);

    const newCred = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(renewed.credential),
    });
    expect(newCred.statusCode).toBe(200);
    expect(newCred.json().entrants).toHaveLength(1);

    // 旧对象凭证被联动作废（ADR 0002 恢复规则）。
    const oldEntrantCred = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(entrantToken!),
    });
    expect(oldEntrantCred.statusCode).toBe(401);

    // 旧恢复码不可复用。
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/reset`,
      payload: { recoveryCode: created.recoveryCode },
    });
    expect(reuse.statusCode).toBe(400);
  });

  it('颁发对象凭证：工作台凭证可颁发并可被 Agent 用于 /api/agent/context', async () => {
    const created = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'INVITE-CRED' },
      })
    ).json();
    const wsToken = created.credential;

    const made = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      headers: auth(wsToken),
      payload: {
        gameId: 'tank',
        name: 'Agent 托管对象',
        appearance: { preset: 'light-tank', color: '#00ff00', name: '绿方' },
      },
    });
    expect(made.statusCode).toBe(201);
    const entrantId = made.json().id as string;

    // 未颁发时，任何对象凭证都不存在 → Agent 无法访问 context。
    const issued = await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(wsToken),
    });
    expect(issued.statusCode).toBe(200);
    const entrantToken = issued.json().credential as string;
    expect(entrantToken.length).toBeGreaterThan(8);

    // 该凭证可被外部 Agent 正常使用（读上下文）。
    const ctxRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/agent/context',
      headers: auth(entrantToken),
    });
    expect(ctxRes.statusCode).toBe(200);
    expect(ctxRes.json().entrant.id).toBe(entrantId);

    // 重新颁发会轮换：旧凭证失效、新凭证可用。
    const rotated = await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(wsToken),
    });
    const newToken = rotated.json().credential as string;
    expect(newToken).not.toBe(entrantToken);

    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/agent/context', headers: auth(entrantToken) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/agent/context', headers: auth(newToken) }))
        .statusCode,
    ).toBe(200);

    // 吊销后彻底不可用。
    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(wsToken),
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/agent/context', headers: auth(newToken) }))
        .statusCode,
    ).toBe(401);
  });

  it('对象凭证不能自我颁发/吊销（防提权），未知对象 404', async () => {
    const created = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'INVITE-ESC' },
      })
    ).json();
    const wsToken = created.credential;
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      headers: auth(wsToken),
      payload: { gameId: 'tank', name: 'T', appearance: { preset: 'p', color: '#fff', name: 'T' } },
    });
    const entrantId = made.json().id as string;
    const entrantToken = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/entrants/${entrantId}/credential`,
        headers: auth(wsToken),
      })
    ).json().credential as string;

    // 对象凭证对自己的颁发/吊销都必须是 401。
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/api/entrants/${entrantId}/credential`,
        headers: auth(entrantToken),
      });
      expect(res.statusCode).toBe(401);
    }

    // 未认证 401。
    expect(
      (await ctx.app.inject({ method: 'POST', url: `/api/entrants/${entrantId}/credential` }))
        .statusCode,
    ).toBe(401);

    // 未知对象 404。
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants/does-not-exist/credential',
      headers: auth(wsToken),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('对象凭证只能看自己：两个工作台交叉验证 401', async () => {
    const a = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'INVITE-ONE' },
      })
    ).json();
    const b = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'INVITE-TWO' },
      })
    ).json();

    const entrantA = ctx.entrantService.createEntrant(a.workspaceId, {
      gameId: 'tank',
      name: 'A-1',
      appearance: { preset: 'light-tank', color: '#123456', name: 'A' },
    });
    const entrantB = ctx.entrantService.createEntrant(b.workspaceId, {
      gameId: 'tank',
      name: 'B-1',
      appearance: { preset: 'light-tank', color: '#654321', name: 'B' },
    });

    // A 的对象凭证访问 B 的对象策略 → 401。
    const cross = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantB.id}/strategies`,
      headers: auth(''),
    });
    expect(cross.statusCode).toBe(401);

    // A 工作台凭证访问 B 的对象 → 401。
    const wsCross = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantB.id}/strategies`,
      headers: auth(a.credential),
    });
    expect(wsCross.statusCode).toBe(401);

    // A 的对象凭证访问自己的策略 → 200。
    ctx.strategyService.publish(entrantA.id, 'strategy source');
    const self = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantA.id}/strategies`,
      headers: auth(a.credential),
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().versions).toHaveLength(1);

    // A 的对象凭证读 B 的对象 → 401。
    const entrantTokenA = ctx.entrantService.issueEntrantCredential(entrantA.id);
    const entrantCross = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantB.id}/strategies`,
      headers: auth(entrantTokenA!),
    });
    expect(entrantCross.statusCode).toBe(401);
    // 同一对象自己的凭证 → 200。
    const entrantSelf = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantA.id}/strategies`,
      headers: auth(entrantTokenA!),
    });
    expect(entrantSelf.statusCode).toBe(200);
  });
});

describe('排名计分（Elo 与 24h 限额）', () => {
  it('3 场胜负后分数变化符合 K=32 预期（1000→1016/984 等）', () => {
    const wsOf = new Map<string, string>([
      ['eA', 'ws1'],
      ['eB', 'ws2'],
      ['eC', 'ws3'],
    ]);
    let clock = 1_000_000;
    const ranking = new RankingService({
      now: () => clock,
      getWorkspaceId: (id) => wsOf.get(id) ?? null,
    });

    // 第 1 场：A 胜 B，双方初始 1000，期望 0.5，Δ = 32*0.5 = 16。
    expect(ranking.applyResult('tank@v1', makeMatch('eA', 'eB', 0))).toBe(true);
    expect(ranking.getScore('tank@v1', 'eA')).toBeCloseTo(1016);
    expect(ranking.getScore('tank@v1', 'eB')).toBeCloseTo(984);

    // 第 2 场：A 再胜 B（复算期望：A=1016, B=984）。
    expect(ranking.applyResult('tank@v1', makeMatch('eA', 'eB', 0))).toBe(true);
    const expectedA2 = 1016 + 32 * (1 - expectedScore(1016, 984));
    const expectedB2 = 984 - 32 * expectedScore(984, 1016);
    expect(ranking.getScore('tank@v1', 'eA')).toBeCloseTo(expectedA2, 5);
    expect(ranking.getScore('tank@v1', 'eB')).toBeCloseTo(expectedB2, 5);

    // 第 3 场：B（当前 expectedB2）胜 C（初始 1000）。
    expect(ranking.applyResult('tank@v1', makeMatch('eB', 'eC', 0))).toBe(true);
    const expectedB3 = expectedB2 + 32 * (1 - expectedScore(expectedB2, 1000));
    expect(ranking.getScore('tank@v1', 'eB')).toBeCloseTo(expectedB3, 5);
    expect(ranking.getScore('tank@v1', 'eC')).toBeCloseTo(1000 - 32 * (1 - expectedScore(expectedB2, 1000)), 5);

    // 同工作台对局不计分（即便 eA2 与 eA 分属不同对手位）。
    wsOf.set('eA2', 'ws1');
    expect(ranking.applyResult('tank@v1', makeMatch('eA', 'eA2', 0))).toBe(false);
    expect(ranking.getScore('tank@v1', 'eA2')).toBeNull();

    // 训练不计分。
    const training = { ...makeMatch('eA', 'eB', 0), kind: 'training' as const };
    expect(ranking.applyResult('tank@v1', training)).toBe(false);

    // 排行榜按分降序。
    const board = ranking.getLeaderboard('tank@v1');
    expect(board.map((e) => e.entrantId)).toEqual(['eA', 'eB', 'eC']);
    expect(board[0]).toMatchObject({ entrantId: 'eA', wins: 2, losses: 0, draws: 0 });
    expect(board[1]).toMatchObject({ entrantId: 'eB', wins: 1, losses: 2, draws: 0 });
    expect(board[2]).toMatchObject({ entrantId: 'eC', wins: 0, losses: 1, draws: 0 });
  });

  it('24h 限额：同一无序对手对第 4 场不计分', () => {
    let clock = 1_000_000;
    const ranking = new RankingService({ now: () => clock });
    // 前 3 场计分（胜负交替 + 交换发起方，复算独立期望分）。
    expect(ranking.applyResult('tank@v1', makeMatch('eX', 'eY', 0))).toBe(true);
    let x = 1000 + 32 * (1 - expectedScore(1000, 1000)); // 初始同分，Δ = 16 → 1016
    let y = 984;
    clock += 60_000;
    expect(ranking.applyResult('tank@v1', makeMatch('eX', 'eY', 1))).toBe(true);
    // 双方同时以赛前分结算：X 负、Y 胜。
    const xAfter2 = x + 32 * (0 - expectedScore(x, y));
    const yAfter2 = y + 32 * (1 - expectedScore(y, x));
    x = xAfter2;
    y = yAfter2;
    clock += 60_000;
    expect(ranking.applyResult('tank@v1', makeMatch('eY', 'eX', 0))).toBe(true); // 交换发起方不增加额度
    const xAfter3 = x - 32 * expectedScore(x, y); // eY 胜：Δ eX = -32·E(eX)
    x = xAfter3;
    const after3 = ranking.getScore('tank@v1', 'eX')!;
    expect(after3).toBeCloseTo(x, 5);
    expect(ranking.getScore('tank@v1', 'eY')).toBeCloseTo(2000 - x, 5);

    // 第 4 场（24h 内）：跳过，不改变积分。
    clock += 60_000;
    expect(ranking.applyResult('tank@v1', makeMatch('eX', 'eY', 0))).toBe(false);
    expect(ranking.getScore('tank@v1', 'eX')).toBe(after3);
    expect(ranking.getScore('tank@v1', 'eY')).toBeCloseTo(2000 - after3, 5);

    // 窗口滚动后（>24h）恢复计分。
    clock += 25 * 60 * 60 * 1000;
    expect(ranking.applyResult('tank@v1', makeMatch('eX', 'eY', 0))).toBe(true);
    expect(ranking.getScore('tank@v1', 'eX')!).toBeGreaterThan(after3);

    // 不同游戏版本分别排名（ADR 0004）。
    expect(ranking.applyResult('tank@v2', makeMatch('eX', 'eY', 0, 'tank@v2'))).toBe(true);
    expect(ranking.getScore('tank@v2', 'eX')).toBeCloseTo(1016);
  });
});

describe('管理路由与其他路由', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  it('未认证访问管理路由 401', async () => {
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'NEW-CODE' },
    });
    expect(anon.statusCode).toBe(401);

    // 错误密钥也 401。
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'NEW-CODE' },
      headers: auth('not-the-admin-key'),
    });
    expect(wrong.statusCode).toBe(401);

    // 正确密钥可预置邀请码，且预置后可兑换。
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'NEW-CODE' },
      headers: auth(ADMIN_KEY),
    });
    expect(ok.statusCode).toBe(201);

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'NEW-CODE' },
    });
    expect(redeem.statusCode).toBe(200);
  });

  it('公开路由：游戏列表与对局摘要；POST /api/matches 返回 501 stub', async () => {
    const games = await ctx.app.inject({ method: 'GET', url: '/api/games' });
    expect(games.statusCode).toBe(200);
    expect(games.json().games).toEqual([
      {
        id: 'tank',
        name: '坦克大战',
        pacing: 'instant',
        bots: tankBots.map((b) => ({ id: b.id, name: b.name, description: b.description })),
      },
    ]);

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/matches/nope' });
    expect(missing.statusCode).toBe(404);

    // POST /api/matches 本版为同步 stub：501 引擎集成中。
    const redeem2 = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'MATCH-CODE' },
      })
    ).json();
    expect(redeem2.workspaceId).toBeUndefined(); // 未预置 → 400

    ctx.workspaceService.addInviteCode('MATCH-CODE');
    const ws = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/redeem',
        payload: { inviteCode: 'MATCH-CODE' },
      })
    ).json();
    const stub = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', opponentEntrantId: 'opp', kind: 'official', myEntrantId: 'me' },
      headers: auth(ws.credential),
    });
    expect(stub.statusCode).toBe(501);
    expect(stub.json()).toEqual({ error: '引擎未接入' });
  });

  it('管理概览：未认证 401，正确密钥返回计数与工作台明细', async () => {
    const ctx = await makeApp();

    // 未认证与错误密钥都 401
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(anon.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: auth('not-the-admin-key'),
    });
    expect(wrong.statusCode).toBe(401);

    // 预置两个码，兑换一个
    ctx.workspaceService.addInviteCode('STATS-A');
    ctx.workspaceService.addInviteCode('STATS-B');
    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'STATS-A', nickname: '统计工作台' },
    });
    expect(redeemed.statusCode).toBe(200);
    const ws = redeemed.json();

    // 工作台内建对象、发策略，验证计数聚合
    const entrant = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name: '对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装' },
      },
      headers: auth(ws.credential),
    });
    expect(entrant.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrant.json().id}/strategies/publish`,
      payload: { source: 'function onIdle(){return {}}' },
      headers: auth(ws.credential),
    });

    const stats = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: auth(ADMIN_KEY),
      })
    ).json();
    expect(stats.workspaces).toHaveLength(1);
    expect(stats.pendingInviteCodes).toBe(1); // STATS-B 未兑换
    expect(stats.consumedInviteCodes).toBe(1); // STATS-A 已兑换
    expect(stats.strategyVersions).toBe(1);
    expect(stats.workspaces[0]).toMatchObject({
      nickname: '统计工作台',
      entrantCount: 1,
      strategyCount: 1,
    });
    // 概览不泄露凭证哈希：字段白名单式校验
    expect(Object.keys(stats.workspaces[0]).sort()).toEqual([
      'createdAt',
      'entrantCount',
      'id',
      'nickname',
      'strategyCount',
    ]);
  });

  it('未兑换邀请码列表：只含未兑换的码', async () => {
    const ctx = await makeApp();
    ctx.workspaceService.addInviteCode('LIST-A');
    ctx.workspaceService.addInviteCode('LIST-B');

    const before = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/invite-codes',
        headers: auth(ADMIN_KEY),
      })
    ).json();
    expect(before.codes.sort()).toEqual(['LIST-A', 'LIST-B']);

    // 兑换 LIST-A 后列表只剩 LIST-B
    await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: 'LIST-A' },
    });
    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/invite-codes',
        headers: auth(ADMIN_KEY),
      })
    ).json();
    expect(after.codes).toEqual(['LIST-B']);
  });
});
