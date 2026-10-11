/**
 * HTTP API 与账号体系测试（vitest + fastify.inject，不 listen）。
 * 覆盖：注册/登录/恢复码重置、API 令牌越权、Elo 计分与 24h 限额、管理路由认证（ADR 0015/0016）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { initDatabase, type SQLiteDatabase } from '../src/db/database.js';
import { UserService } from '../src/services/user-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import type { GameDefinition } from '../src/games/contracts.js';
import { tankBots } from '../src/games/tank/bots.js';
import type { MatchRecord } from '../src/engine/match-contracts.js';

const ADMIN_NAME = 'admin';
const ADMIN_PW = 'admin-pass-123';

const tankGame: GameDefinition = {
  id: 'tank',
  name: '坦克大战',
  pacing: 'instant',
  actionNames: ['move', 'fire'],
};

interface TestContext {
  app: FastifyInstance;
  db: SQLiteDatabase;
  userService: UserService;
  entrantService: EntrantService;
  strategyService: StrategyService;
  rankingService: RankingService;
}

function makeServices(now: () => number = () => Date.now()) {
  const db: SQLiteDatabase = initDatabase(':memory:');
  const userService = new UserService(db);
  const entrantService = new EntrantService(db);
  const strategyService = new StrategyService(db);
  const rankingService = new RankingService({ now });
  return { userService, entrantService, strategyService, rankingService, db };
}

async function makeApp(services = makeServices()): Promise<TestContext> {
  const games = new Map<string, GameDefinition>([['tank', tankGame]]);
  const gameVersions = new Map<string, string>([['tank@v1', 'tank']]);
  const app = await buildApp({
    ...services,
    games,
    gameVersions,
  });
  return { app, ...services };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** 注册一个用户并登录，返回 {userId, sessionToken}。邀请码需先预置。 */
async function registerUser(
  ctx: TestContext,
  inviteCode: string,
  username: string,
  password = 'pass-123',
  nickname?: string,
) {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { inviteCode, username, password, ...(nickname ? { nickname } : {}) },
  });
  if (reg.statusCode !== 201) throw new Error(`注册失败: ${reg.body}`);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  if (login.statusCode !== 200) throw new Error(`登录失败: ${login.body}`);
  const body = login.json();
  return {
    userId: body.userId as string,
    token: body.token as string,
    recoveryCode: reg.json().recoveryCode as string,
  };
}

/** 管理员登录（每个测试自行调用，避免共享状态）。 */
async function adminToken(ctx: TestContext): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN_NAME, password: ADMIN_PW },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
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

describe('注册、登录与会话', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    ctx.userService.seedAdmin(ADMIN_NAME, ADMIN_PW);
    ctx.userService.addInviteCode('INVITE-ONE');
    ctx.userService.addInviteCode('INVITE-TWO');
    ctx.userService.addInviteCode('INVITE-CRED');
    ctx.userService.addInviteCode('INVITE-ESC');
    ctx.userService.addInviteCode('INVITE-READBACK');
    ctx.userService.addInviteCode('INVITE-READBACK-2');
  });

  it('注册后登录访问 /api/entrants（空列表）；未登录 401', async () => {
    const user = await registerUser(ctx, 'INVITE-ONE', 'zhang', undefined, '小张');

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(user.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ entrants: [] });

    // 未认证访问业务路由 401。
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/entrants' });
    expect(anon.statusCode).toBe(401);

    // /api/users/me 返回自信息。
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: auth(user.token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: 'zhang', nickname: '小张', role: 'user' });
  });

  it('错误邀请码 400；重复使用已兑换邀请码 400；用户名撞车 409；密码太短 400', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'NOT-A-CODE', username: 'a_user', password: 'pass-123' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toHaveProperty('error');

    const shortPw = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'INVITE-ONE', username: 'a_user', password: '123' },
    });
    expect(shortPw.statusCode).toBe(400);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'INVITE-ONE', username: 'a_user', password: 'pass-123' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().recoveryCode).toMatch(/^.{32,}$/);

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'INVITE-ONE', username: 'b_user', password: 'pass-123' },
    });
    expect(second.statusCode).toBe(400);

    const taken = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'INVITE-TWO', username: 'a_user', password: 'pass-123' },
    });
    expect(taken.statusCode).toBe(409);
  });

  it('登录失败 401；登出后令牌失效；改昵称即时生效', async () => {
    ctx.userService.addInviteCode('L-1');
    await registerUser(ctx, 'L-1', 'li_user');

    // 密码错误 401。
    const wrongPw = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'li_user', password: 'wrong-pw' },
    });
    expect(wrongPw.statusCode).toBe(401);

    // 未知用户 401。
    const ghost = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'whatever' },
    });
    expect(ghost.statusCode).toBe(401);

    // 改昵称。
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'li_user', password: 'pass-123' },
    });
    const token = login.json().token as string;
    const rename = await ctx.app.inject({
      method: 'POST',
      url: '/api/users/me/nickname',
      payload: { nickname: '李老板' },
      headers: auth(token),
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().nickname).toBe('李老板');

    // 登出后旧令牌 401。
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: auth(token),
    });
    expect(logout.statusCode).toBe(200);
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: auth(token),
    });
    expect(after.statusCode).toBe(401);
  });

  it('恢复码重置密码：旧会话 401、新密码可登录、恢复码轮换', async () => {
    const user = await registerUser(ctx, 'INVITE-ONE', 'wang');

    // 在账号下创建参赛对象并颁发 API 令牌。
    const entrant = ctx.entrantService.createEntrant(user.userId, {
      gameId: 'tank',
      name: 'T1',
      appearance: { preset: 'light-tank', color: '#ff0000', name: '红方' },
    });
    const apiToken = ctx.entrantService.issueEntrantCredential(entrant.id);
    expect(apiToken).toBeTruthy();

    // 重置前 API 令牌可用。
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/agent/context',
      headers: auth(apiToken!),
    });
    expect(before.statusCode).toBe(200);

    // 自助重置（旧恢复码 + 新密码）。
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { username: 'wang', recoveryCode: user.recoveryCode, newPassword: 'new-pass-456' },
    });
    expect(reset.statusCode).toBe(200);

    // 旧会话 401，新密码可登录。
    const oldSession = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: auth(user.token),
    });
    expect(oldSession.statusCode).toBe(401);

    const reLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'wang', password: 'new-pass-456' },
    });
    expect(reLogin.statusCode).toBe(200);

    // 旧恢复码不可复用。
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { username: 'wang', recoveryCode: user.recoveryCode, newPassword: 'another-789' },
    });
    expect(reuse.statusCode).toBe(400);

    // 旧 API 令牌仍可用（ADR 0015 只吊销会话；API 令牌需用户显式吊销或归档对象）。
    const apiAfter = await ctx.app.inject({
      method: 'GET',
      url: '/api/agent/context',
      headers: auth(apiToken!),
    });
    expect(apiAfter.statusCode).toBe(200);
  });

  it('颁发 API 令牌：用户会话可颁发并可被 Agent 用于 /api/agent/context', async () => {
    const user = await registerUser(ctx, 'INVITE-CRED', 'agent_owner');

    const made = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      headers: auth(user.token),
      payload: {
        gameId: 'tank',
        name: 'Agent 托管对象',
        appearance: { preset: 'light-tank', color: '#00ff00', name: '绿方' },
      },
    });
    expect(made.statusCode).toBe(201);
    const entrantId = made.json().id as string;

    const issued = await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(user.token),
    });
    expect(issued.statusCode).toBe(200);
    const apiToken = issued.json().credential as string;
    expect(apiToken.length).toBeGreaterThan(8);

    // 该令牌可被外部 Agent 正常使用（读上下文）。
    const ctxRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/agent/context',
      headers: auth(apiToken),
    });
    expect(ctxRes.statusCode).toBe(200);
    expect(ctxRes.json().entrant.id).toBe(entrantId);

    // 重新颁发会轮换：旧令牌失效、新令牌可用。
    const rotated = await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(user.token),
    });
    const newToken = rotated.json().credential as string;
    expect(newToken).not.toBe(apiToken);

    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/agent/context', headers: auth(apiToken) }))
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
      headers: auth(user.token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/agent/context', headers: auth(newToken) }))
        .statusCode,
    ).toBe(401);
  });

  it('API 令牌不能自我颁发/吊销（防提权），未知对象 404', async () => {
    const user = await registerUser(ctx, 'INVITE-ESC', 'esc_user');
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      headers: auth(user.token),
      payload: { gameId: 'tank', name: 'T', appearance: { preset: 'p', color: '#fff', name: 'T' } },
    });
    const entrantId = made.json().id as string;
    const apiToken = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/entrants/${entrantId}/credential`,
        headers: auth(user.token),
      })
    ).json().credential as string;

    // API 令牌对自己的颁发/吊销都必须是 401。
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/api/entrants/${entrantId}/credential`,
        headers: auth(apiToken),
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
      headers: auth(user.token),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('用户可取回 API 令牌明文（存库绑定），API 令牌本人/跨用户/未认证 401', async () => {
    const owner = await registerUser(ctx, 'INVITE-READBACK', 'readback_owner');
    const other = await registerUser(ctx, 'INVITE-READBACK-2', 'readback_other');

    const made = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      headers: auth(owner.token),
      payload: { gameId: 'tank', name: 'T', appearance: { preset: 'p', color: '#fff', name: 'T' } },
    });
    const entrantId = made.json().id as string;

    // 还没颁发 → 404
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/entrants/${entrantId}/credential`, headers: auth(owner.token) }))
        .statusCode,
    ).toBe(404);

    // 颁发后能取回同一份明文
    const issued = await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(owner.token),
    });
    const token = issued.json().credential as string;
    const readback = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantId}/credential`,
      headers: auth(owner.token),
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json().credential).toBe(token);

    // API 令牌不能读自己的明文（只有用户会话可以）
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/entrants/${entrantId}/credential`, headers: auth(token) }))
        .statusCode,
    ).toBe(401);

    // 跨用户 401
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/entrants/${entrantId}/credential`, headers: auth(other.token) }))
        .statusCode,
    ).toBe(401);

    // 未认证 401
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/entrants/${entrantId}/credential` })).statusCode,
    ).toBe(401);

    // 吊销后再取 → 404
    await ctx.app.inject({ method: 'DELETE', url: `/api/entrants/${entrantId}/credential`, headers: auth(owner.token) });
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/entrants/${entrantId}/credential`, headers: auth(owner.token) }))
        .statusCode,
    ).toBe(404);
  });

  it('API 令牌只能看自己：两个用户交叉验证 401', async () => {
    const a = await registerUser(ctx, 'INVITE-ONE', 'user_a');
    const b = await registerUser(ctx, 'INVITE-TWO', 'user_b');

    const entrantA = ctx.entrantService.createEntrant(a.userId, {
      gameId: 'tank',
      name: 'A-1',
      appearance: { preset: 'light-tank', color: '#123456', name: 'A' },
    });
    const entrantB = ctx.entrantService.createEntrant(b.userId, {
      gameId: 'tank',
      name: 'B-1',
      appearance: { preset: 'light-tank', color: '#654321', name: 'B' },
    });

    // 未认证 401。
    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantB.id}/strategies`,
    });
    expect(anon.statusCode).toBe(401);

    // A 的会话访问 B 的对象 → 401。
    const wsCross = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantB.id}/strategies`,
      headers: auth(a.token),
    });
    expect(wsCross.statusCode).toBe(401);

    // A 的会话访问自己的对象 → 200。
    ctx.strategyService.publish(entrantA.id, 'strategy source');
    const self = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantA.id}/strategies`,
      headers: auth(a.token),
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().versions).toHaveLength(1);

    // A 的 API 令牌读 B 的对象 → 401。
    const apiTokenA = ctx.entrantService.issueEntrantCredential(entrantA.id);
    const apiCross = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantB.id}/strategies`,
      headers: auth(apiTokenA!),
    });
    expect(apiCross.statusCode).toBe(401);
    // 同一对象自己的令牌 → 200。
    const apiSelf = await ctx.app.inject({
      method: 'GET',
      url: `/api/entrants/${entrantA.id}/strategies`,
      headers: auth(apiTokenA!),
    });
    expect(apiSelf.statusCode).toBe(200);
  });
});

describe('排名计分（Elo 与 24h 限额）', () => {
  it('3 场胜负后分数变化符合 K=32 预期（1000→1016/984 等）', () => {
    const userOf = new Map<string, string>([
      ['eA', 'u1'],
      ['eB', 'u2'],
      ['eC', 'u3'],
    ]);
    let clock = 1_000_000;
    const ranking = new RankingService({
      now: () => clock,
      getUserId: (id) => userOf.get(id) ?? null,
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

    // 同用户对局不计分（即便 eA2 与 eA 分属不同对手位）。
    userOf.set('eA2', 'u1');
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
    ctx.userService.seedAdmin(ADMIN_NAME, ADMIN_PW);
  });

  it('未认证/普通用户访问管理路由 401', async () => {
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'NEW-CODE' },
    });
    expect(anon.statusCode).toBe(401);

    // 普通用户也 401。
    ctx.userService.addInviteCode('PLAIN-1');
    const plain = await registerUser(ctx, 'PLAIN-1', 'plain');
    const userRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'NEW-CODE' },
      headers: auth(plain.token),
    });
    expect(userRes.statusCode).toBe(401);

    // admin 可预置邀请码，且预置后可注册。
    const admin = await adminToken(ctx);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'NEW-CODE' },
      headers: auth(admin),
    });
    expect(ok.statusCode).toBe(201);

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'NEW-CODE', username: 'whoever', password: 'pass-123' },
    });
    expect(redeem.statusCode).toBe(201);
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
    ctx.userService.addInviteCode('MATCH-CODE');
    const user = await registerUser(ctx, 'MATCH-CODE', 'match_user');
    const stub = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', opponentEntrantId: 'opp', kind: 'official', myEntrantId: 'me' },
      headers: auth(user.token),
    });
    expect(stub.statusCode).toBe(501);
    expect(stub.json()).toEqual({ error: '引擎未接入' });
  });

  it('管理概览：未认证 401，admin 会话返回计数与用户明细', async () => {
    // 未认证 401
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(anon.statusCode).toBe(401);

    // 预置两个码，注册一个用户
    const admin = await adminToken(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'STATS-A' },
      headers: auth(admin),
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'STATS-B' },
      headers: auth(admin),
    });
    const user = await registerUser(ctx, 'STATS-A', 'stat_user', undefined, '统计用户');

    // 建对象、发策略，验证计数聚合
    const entrant = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name: '对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装' },
      },
      headers: auth(user.token),
    });
    expect(entrant.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${entrant.json().id}/strategies/publish`,
      payload: { source: 'function onIdle(){return {}}' },
      headers: auth(user.token),
    });

    const stats = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: auth(admin),
      })
    ).json();
    // admin 种子用户 + 统计用户 = 2
    expect(stats.users).toHaveLength(2);
    expect(stats.pendingInviteCodes).toBe(1); // STATS-B 未兑换
    expect(stats.consumedInviteCodes).toBe(1); // STATS-A 已兑换
    expect(stats.strategyVersions).toBe(1);
    const mine = stats.users.find((u: { username: string }) => u.username === 'stat_user');
    expect(mine).toMatchObject({
      nickname: '统计用户',
      entrantCount: 1,
      strategyCount: 1,
    });
    // 在役与已归档分开报：归档即释放配额，两个数一起看才知道删过多少。
    expect(stats.entrantCount).toBe(1);
    expect(stats.archivedEntrantCount).toBe(0);

    // 概览不泄露令牌/哈希：字段白名单式校验
    expect(
      Object.keys(mine).sort(),
    ).toEqual([
      'archivedEntrantCount',
      'banned',
      'createdAt',
      'entrantCount',
      'id',
      'nickname',
      'role',
      'sessionCount',
      'strategyCount',
      'username',
    ]);

    // 归档后：在役减一、已归档加一（总数口径与列表/配额一致）。
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/entrants/${entrant.json().id}`,
      headers: auth(user.token),
    });
    expect(archived.statusCode).toBe(200);

    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: auth(admin),
      })
    ).json();
    expect(after.entrantCount).toBe(0);
    expect(after.archivedEntrantCount).toBe(1);
    expect(
      after.users.find((u: { username: string }) => u.username === 'stat_user'),
    ).toMatchObject({
      entrantCount: 0,
      archivedEntrantCount: 1,
    });
  });

  it('未兑换邀请码列表：只含未兑换的码', async () => {
    const admin = await adminToken(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'LIST-A' },
      headers: auth(admin),
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'LIST-B' },
      headers: auth(admin),
    });

    const before = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/invite-codes',
        headers: auth(admin),
      })
    ).json();
    expect(before.codes.sort()).toEqual(['LIST-A', 'LIST-B']);

    // 兑换 LIST-A 后列表只剩 LIST-B
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'LIST-A', username: 'list_user', password: 'pass-123' },
    });
    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/invite-codes',
        headers: auth(admin),
      })
    ).json();
    expect(after.codes).toEqual(['LIST-B']);
  });
});

describe('管理端找回账户与撤销邀请码', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    ctx.userService.seedAdmin(ADMIN_NAME, ADMIN_PW);
  });

  /** 注册一个用户，返回凭据。 */
  async function makeUser(inviteCode: string, username: string, nickname?: string) {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: inviteCode },
      headers: auth(await adminToken(ctx)),
    });
    return registerUser(ctx, inviteCode, username, undefined, nickname);
  }

  it('管理员可查看当前恢复码明文；未认证 401；不存在的用户 404', async () => {
    const admin = await adminToken(ctx);
    const user = await makeUser('RC-ONE', 'rc_user', '找回账户用户');

    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/recovery-code`,
    });
    expect(anon.statusCode).toBe(401);

    const plainUser = await makeUser('RC-PLAIN', 'rc_plain');
    const wrong = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/recovery-code`,
      headers: auth(plainUser.token),
    });
    expect(wrong.statusCode).toBe(401);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users/no-such-user/recovery-code',
      headers: auth(admin),
    });
    expect(missing.statusCode).toBe(404);

    // 创建后即可查到明文（明文存库，ADR 0002 再修订）
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/recovery-code`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: user.userId,
      username: 'rc_user',
      nickname: '找回账户用户',
      recoveryCode: user.recoveryCode,
    });
  });

  it('用户自助重置后，管理员查到的是新恢复码', async () => {
    const admin = await adminToken(ctx);
    const user = await makeUser('RC-TWO', 'rc_two');

    // 用户自助重置（旧恢复码 + 新密码）
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { username: 'rc_two', recoveryCode: user.recoveryCode, newPassword: 'brand-new-1' },
    });
    expect(reset.statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/recovery-code`,
      headers: auth(admin),
    });
    expect(res.json().recoveryCode).not.toBe(user.recoveryCode);
  });

  it('管理员兜底重置：新密码可用、旧会话失效', async () => {
    const admin = await adminToken(ctx);
    const user = await makeUser('RC-THREE', 'rc_three', '重置凭证用户');

    // 用户建一个对象并颁发 API 令牌
    const entrant = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name: '对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装' },
      },
      headers: auth(user.token),
    });
    expect(entrant.statusCode).toBe(201);

    // 管理员重置（未认证 401 先行）
    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/reset`,
    });
    expect(anon.statusCode).toBe(401);

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/reset`,
      headers: auth(admin),
    });
    expect(reset.statusCode).toBe(200);
    const next = reset.json();
    expect(next.userId).toBe(user.userId);
    expect(next.newPassword).toBeTruthy();
    expect(next.recoveryCode).toBeTruthy();

    // 旧会话失效
    const old = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: auth(user.token),
    });
    expect(old.statusCode).toBe(401);

    // 新密码可登录
    const reLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'rc_three', password: next.newPassword },
    });
    expect(reLogin.statusCode).toBe(200);

    // 管理员能查到新恢复码明文
    const rc = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/recovery-code`,
      headers: auth(admin),
    });
    expect(rc.json().recoveryCode).toBe(next.recoveryCode);
  });

  it('用户参赛对象明细：含已归档对象与状态', async () => {
    const admin = await adminToken(ctx);
    const user = await makeUser('RC-FOUR', 'rc_four', '明细用户');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name: '幸存者',
        appearance: { preset: 'heavy', color: '#123456', name: '重装' },
      },
      headers: auth(user.token),
    });
    const doomed = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name: '将被归档',
        appearance: { preset: 'scout', color: '#654321', name: '侦察' },
      },
      headers: auth(user.token),
    });
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/entrants/${doomed.json().id}`,
      headers: auth(user.token),
    });
    expect(archived.statusCode).toBe(200);

    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/entrants`,
    });
    expect(anon.statusCode).toBe(401);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/users/${user.userId}/entrants`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().entrants as Array<{
      name: string;
      archivedAt: number | null;
    }>;
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.name === '幸存者')?.archivedAt).toBeNull();
    expect(list.find((e) => e.name === '将被归档')?.archivedAt).not.toBeNull();
  });

  it('撤销邀请码：未兑换的可撤销，已兑换的返回 404', async () => {
    const admin = await adminToken(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'RV-ONE' },
      headers: auth(admin),
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invite-codes',
      payload: { code: 'RV-TWO' },
      headers: auth(admin),
    });

    // 未认证 401
    const anon = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/admin/invite-codes/RV-ONE',
    });
    expect(anon.statusCode).toBe(401);

    // 兑换 RV-TWO 后撤销它 → 404（已绑定用户，不可撤回）
    await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'RV-TWO', username: 'rv_user', password: 'pass-123' },
    });
    const used = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/admin/invite-codes/RV-TWO',
      headers: auth(admin),
    });
    expect(used.statusCode).toBe(404);

    // RV-ONE 未兑换 → 撤销成功，从未兑换列表消失，且不能再注册
    const ok = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/admin/invite-codes/RV-ONE',
      headers: auth(admin),
    });
    expect(ok.statusCode).toBe(200);

    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/invite-codes',
        headers: auth(admin),
      })
    ).json();
    expect(after.codes).not.toContain('RV-ONE');

    const redeem = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { inviteCode: 'RV-ONE', username: 'rv_late', password: 'pass-123' },
    });
    expect(redeem.statusCode).toBe(400);
  });

  it('概览含对局统计：total/live/official/training；未认证 401', async () => {
    const admin = await adminToken(ctx);
    const user = await makeUser('MS-ONE', 'ms_user', '对局统计用户');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name: '统计对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装' },
      },
      headers: auth(user.token),
    });
    expect(created.statusCode).toBe(201);
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/entrants/${created.json().id}/strategies/publish`,
      payload: { source: 'function onIdle(){return {}}' },
      headers: auth(user.token),
    });
    expect(published.statusCode).toBe(200);

    const anon = await ctx.app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(anon.statusCode).toBe(401);

    const stats = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: auth(admin),
      })
    ).json();
    // makeApp 未注入 listMatches/countMatches（默认 [] / undefined）→ 统计为 0，但字段必在
    expect(stats.matchStats).toEqual({ total: 0, live: 0, official: 0, training: 0 });
  });

  it('角色与封禁：封禁后无法登录且会话吊销，解封恢复；提权/降级', async () => {
    const admin = await adminToken(ctx);
    const user = await makeUser('BAN-ONE', 'ban_user');

    // 封禁（未认证 401 先行）
    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/ban`,
      payload: { banned: true },
    });
    expect(anon.statusCode).toBe(401);

    const ban = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/ban`,
      payload: { banned: true },
      headers: auth(admin),
    });
    expect(ban.statusCode).toBe(200);

    // 已有会话立即失效。
    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: auth(user.token),
    });
    expect(session.statusCode).toBe(401);

    // 登录被拒。
    const loginBanned = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ban_user', password: 'pass-123' },
    });
    expect(loginBanned.statusCode).toBe(401);

    // 解封后可登录，数据保留。
    const unban = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/ban`,
      payload: { banned: false },
      headers: auth(admin),
    });
    expect(unban.statusCode).toBe(200);
    const loginBack = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ban_user', password: 'pass-123' },
    });
    expect(loginBack.statusCode).toBe(200);
    const entrants = await ctx.app.inject({
      method: 'GET',
      url: '/api/entrants',
      headers: auth(loginBack.json().token),
    });
    expect(entrants.statusCode).toBe(200);

    // 提权为 admin 后可访问管理路由；降级后回到 401。
    const promote = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/role`,
      payload: { role: 'admin' },
      headers: auth(admin),
    });
    expect(promote.statusCode).toBe(200);
    const asAdmin = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: auth(loginBack.json().token),
    });
    expect(asAdmin.statusCode).toBe(200);

    const demote = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/role`,
      payload: { role: 'user' },
      headers: auth(admin),
    });
    expect(demote.statusCode).toBe(200);
    const asUser = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: auth(loginBack.json().token),
    });
    expect(asUser.statusCode).toBe(401);
  });
});
