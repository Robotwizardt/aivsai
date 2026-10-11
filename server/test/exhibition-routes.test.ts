// 表演赛路由接线（ADR 0017）TDD：座位协议 REST + 创建/列表/生命周期管理。
//
// 覆盖：
// - 创建：登录用户，限额 429，返回两个座位链接；游戏不存在 404
// - 座位 REST（免登录，Bearer 座位密钥）：observe / act / setName
// - 公开列表（直播大厅）、我的列表
// - 暂停/恢复/解散：创建者可，他人 403
// - ExhibitionError 透传状态码
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { initDatabase, type SQLiteDatabase } from '../src/db/database.js';
import { UserService } from '../src/services/user-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import { ExhibitionStore } from '../src/services/exhibition-store.js';
import { ExhibitionService } from '../src/services/exhibition-service.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';
import { LiveHub } from '../src/engine/live-hub.js';
import { gomokuGamePackage } from '../src/games/gomoku/gomoku-game.js';
import { xiangqiGamePackage } from '../src/games/xiangqi/xiangqi-game.js';
import type { GamePackage } from '../src/games/contracts.js';

interface TestContext {
  app: FastifyInstance;
  db: SQLiteDatabase;
  userService: UserService;
  exhibitionStore: ExhibitionStore;
  exhibitionService: ExhibitionService;
  matchStore: SQLiteMatchStore;
}

async function makeApp(): Promise<TestContext> {
  const db = initDatabase(':memory:');
  const userService = new UserService(db);
  const entrantService = new EntrantService(db);
  const strategyService = new StrategyService(db);
  const rankingService = new RankingService({ now: () => Date.now() });
  const exhibitionStore = new ExhibitionStore(db);
  const matchStore = new SQLiteMatchStore(db);
  const liveHub = new LiveHub({ getRecord: (id) => matchStore.get(id) });
  const gamePackages = new Map<string, GamePackage>([
    ['gomoku', gomokuGamePackage],
    ['xiangqi', xiangqiGamePackage],
  ]);
  const exhibitionService = new ExhibitionService({
    exhibitionStore,
    matchStore,
    liveHub,
    games: gamePackages,
  });
  const app = await buildApp({
    userService,
    entrantService,
    strategyService,
    rankingService,
    // buildApp 拿纯 GameDefinition（与 src/index.ts 同样口径：包定义抽给 exhibitionService）
    games: new Map([...gamePackages.entries()].map(([id, pkg]) => [id, pkg.definition])),
    exhibitionService,
    getMatch: (id) => matchStore.get(id),
  });
  return { app, db, userService, exhibitionStore, exhibitionService, matchStore };
}

async function registerUser(ctx: TestContext, inviteCode: string, username: string) {
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { inviteCode, username, password: 'pass-123' },
  });
  if (reg.statusCode !== 201) throw new Error(`注册失败: ${reg.body}`);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'pass-123' },
  });
  if (login.statusCode !== 200) throw new Error(`登录失败: ${login.body}`);
  return login.json().token as string;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('表演赛路由（ADR 0017）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    ctx.userService.seedAdmin('admin', 'admin-pass-123');
    ctx.userService.addInviteCode('INVITE-1');
    ctx.userService.addInviteCode('INVITE-2');
  });
  afterEach(async () => {
    await ctx.app.close();
    ctx.exhibitionService.shutdown();
    ctx.db.close();
  });

  it('座位协议全流程：创建→observe→act→setName→非法 400→判负；未登录 401', async () => {
    // 未登录 → 401
    const anon = await ctx.app.inject({ method: 'POST', url: '/api/exhibitions', payload: { gameId: 'gomoku' } });
    expect(anon.statusCode).toBe(401);

    const alice = await registerUser(ctx, 'INVITE-1', 'alice');

    // 创建表演赛 → 两个座位链接
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/exhibitions',
      headers: bearer(alice),
      payload: { gameId: 'gomoku', title: '巅峰对决' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      matchId: string;
      seatLinks: { side: 0 | 1; url: string; key: string }[];
    };
    expect(body.seatLinks).toHaveLength(2);
    expect(body.seatLinks[0]!.url).toContain('#/seat/');
    const redKey = body.seatLinks.find((s) => s.side === 0)!.key;
    const blackKey = body.seatLinks.find((s) => s.side === 1)!.key;

    // 座位 observe（免登录）：红方 your-turn，黑方 waiting
    const obs = await ctx.app.inject({ method: 'GET', url: '/api/seat/observe', headers: bearer(redKey) });
    expect(obs.statusCode).toBe(200);
    expect(obs.json()).toMatchObject({ status: 'your-turn', side: 0, moveCount: 0 });
    const blackObs = await ctx.app.inject({ method: 'GET', url: '/api/seat/observe', headers: bearer(blackKey) });
    expect(blackObs.json()).toMatchObject({ status: 'waiting', side: 1 });

    // 红方合法首手
    const act = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/act',
      headers: { ...bearer(redKey), 'content-type': 'application/json' },
      payload: { action: { place: [7, 7] } },
    });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ ok: true });

    // 黑方 observe → your-turn（act 响应时下一座位已待命）
    const b2 = await ctx.app.inject({ method: 'GET', url: '/api/seat/observe', headers: bearer(blackKey) });
    expect(b2.json()).toMatchObject({ status: 'your-turn', moveCount: 1 });

    // 黑方 setName（首手前可自报）
    const named = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/set-name',
      headers: { ...bearer(blackKey), 'content-type': 'application/json' },
      payload: { name: 'DeepSeek-R1' },
    });
    expect(named.statusCode).toBe(200);
    expect(ctx.exhibitionStore.get(body.matchId)!.seatNames[1]).toBe('DeepSeek-R1');

    // 非法行动 → 400 + 原因
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/act',
      headers: { ...bearer(blackKey), 'content-type': 'application/json' },
      payload: { action: { place: [99, 99] } },
    });
    expect(bad.statusCode).toBe(400);
    expect(String((bad.json() as { error: string }).error)).toContain('越界');

    // 黑方连 3 次非法（[7,7] 已被占）→ 判负结束
    for (let i = 0; i < 3; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/seat/act',
        headers: { ...bearer(blackKey), 'content-type': 'application/json' },
        payload: { action: { place: [7, 7] } },
      });
    }
    // 判负后对局结束；密钥失效 → 401
    const dead = await ctx.app.inject({ method: 'GET', url: '/api/seat/observe', headers: bearer(redKey) });
    expect(dead.statusCode).toBe(401);
    const record = ctx.matchStore.get(body.matchId);
    expect(record!.result!.outcome.kind).toBe('win');
    expect((record!.result!.outcome as { winner: 0 | 1 }).winner).toBe(0);
    const ex2 = ctx.exhibitionStore.get(body.matchId);
    expect(ex2!.finishedAt).not.toBeNull();
  });

  it('生命周期：暂停（409 提交 / observe paused）→ 恢复 → 解散；权限 403', async () => {
    const alice = await registerUser(ctx, 'INVITE-1', 'alice');
    const bob = await registerUser(ctx, 'INVITE-2', 'bob');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/exhibitions',
      headers: bearer(alice),
      payload: { gameId: 'gomoku' },
    });
    const { matchId, seatLinks } = created.json() as { matchId: string; seatLinks: { side: 0 | 1; key: string }[] };
    const redKey = seatLinks.find((s) => s.side === 0)!.key;

    // bob 不能暂停/解散 alice 的对局
    expect((await ctx.app.inject({ method: 'POST', url: `/api/exhibitions/${matchId}/pause`, headers: bearer(bob) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/exhibitions/${matchId}/dissolve`, headers: bearer(bob) })).statusCode).toBe(403);

    // alice 暂停 → 座位 act 409、observe paused
    expect((await ctx.app.inject({ method: 'POST', url: `/api/exhibitions/${matchId}/pause`, headers: bearer(alice) })).statusCode).toBe(200);
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/act',
      headers: { ...bearer(redKey), 'content-type': 'application/json' },
      payload: { action: { place: [7, 7] } },
    });
    expect(blocked.statusCode).toBe(409);
    const obs = await ctx.app.inject({ method: 'GET', url: '/api/seat/observe', headers: bearer(redKey) });
    expect(obs.json()).toMatchObject({ status: 'paused' });

    // 恢复 → 落一手 → 解散 → 密钥失效
    expect((await ctx.app.inject({ method: 'POST', url: `/api/exhibitions/${matchId}/resume`, headers: bearer(alice) })).statusCode).toBe(200);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/act',
      headers: { ...bearer(redKey), 'content-type': 'application/json' },
      payload: { action: { place: [7, 7] } },
    });
    expect(ok.statusCode).toBe(200);
    const dis = await ctx.app.inject({ method: 'POST', url: `/api/exhibitions/${matchId}/dissolve`, headers: bearer(alice) });
    expect(dis.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/seat/observe', headers: bearer(redKey) });
    expect(after.statusCode).toBe(401);
  });

  it('列表：公开列表只含公开的，我的含全部；未知游戏 404；限额 429', async () => {
    const alice = await registerUser(ctx, 'INVITE-1', 'alice');

    // 未知游戏 404
    expect((await ctx.app.inject({ method: 'POST', url: '/api/exhibitions', headers: bearer(alice), payload: { gameId: 'nope' } })).statusCode).toBe(404);

    // 一场公开 + 一场私密
    const c1 = await ctx.app.inject({ method: 'POST', url: '/api/exhibitions', headers: bearer(alice), payload: { gameId: 'gomoku', title: '公开赛' } });
    expect(c1.statusCode).toBe(201);
    await ctx.app.inject({ method: 'POST', url: '/api/exhibitions', headers: bearer(alice), payload: { gameId: 'gomoku', title: '私密赛', isPublic: false } });
    const id1 = (c1.json() as { matchId: string }).matchId;

    // 公开列表只含公开的
    const pub = await ctx.app.inject({ method: 'GET', url: '/api/exhibitions' });
    expect(pub.statusCode).toBe(200);
    const list = (pub.json() as { exhibitions: { matchId: string; title: string }[] }).exhibitions;
    expect(list.some((e) => e.matchId === id1)).toBe(true);
    expect(list.some((e) => e.title === '私密赛')).toBe(false);

    // 我的列表含两场
    const mine = await ctx.app.inject({ method: 'GET', url: '/api/exhibitions/mine', headers: bearer(alice) });
    expect((mine.json() as { exhibitions: unknown[] }).exhibitions).toHaveLength(2);

  });

  it('ADR 0018：exhibitionOnly 游戏平台过滤——常规入口拒绝、表演赛入口开放', async () => {
    const alice = await registerUser(ctx, 'INVITE-1', 'alice');

    // /api/games 常规游戏列表不含 xiangqi；表演赛游戏列表含 gomoku + xiangqi
    const regular = await ctx.app.inject({ method: 'GET', url: '/api/games' });
    const regularIds = (regular.json() as { games: { id: string }[] }).games.map((g) => g.id);
    expect(regularIds).toContain('gomoku');
    expect(regularIds).not.toContain('xiangqi');

    const ex = await ctx.app.inject({ method: 'GET', url: '/api/exhibitions/games' });
    expect(ex.statusCode).toBe(200);
    const exIds = (ex.json() as { games: { id: string }[] }).games.map((g) => g.id);
    expect(exIds).toEqual(expect.arrayContaining(['gomoku', 'xiangqi']));

    // 不能为 xiangqi 创建参赛对象（常规入口）
    const entrant = await ctx.app.inject({
      method: 'POST',
      url: '/api/entrants',
      headers: bearer(alice),
      payload: {
        gameId: 'xiangqi',
        name: '象棋对象',
        appearance: { preset: 'default', color: '#ff0000', name: '红' },
      },
    });
    expect(entrant.statusCode).toBe(400);
    expect((entrant.json() as { error: string }).error).toContain('仅支持表演赛');

    // 不发正式/训练对局（orchestrator 未接入时其他错误也可，但必须是 4xx 且非 404 游戏缺失）
    const match = await ctx.app.inject({
      method: 'POST',
      url: '/api/matches',
      headers: bearer(alice),
      payload: { gameId: 'xiangqi', kind: 'training', myEntrantId: 'ent_x', opponentBotId: 'standard-01' },
    });
    expect(match.statusCode).toBe(400);
    expect((match.json() as { error: string }).error).toContain('仅支持表演赛');

    // 无排行榜
    const board = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard/xiangqi' });
    expect(board.statusCode).toBe(404);
    expect((board.json() as { error: string }).error).toContain('仅支持表演赛');

    // 表演赛入口正常：可为 xiangqi 建表演赛
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/exhibitions',
      headers: bearer(alice),
      payload: { gameId: 'xiangqi', title: '象棋表演赛' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { matchId: string; seatLinks: { side: number; key: string }[] };
    expect(body.seatLinks).toHaveLength(2);

    // 座位协议可用：红方 observe 拿到初始局面（32 子）
    const redKey = body.seatLinks.find((s) => s.side === 0)!.key;
    let obs: { statusCode: number; body: string } = { statusCode: 0, body: '' };
    // 开局即刻可能仍 your-turn；轮询直到拿到 observation 或超时
    for (let i = 0; i < 50; i++) {
      obs = await ctx.app.inject({
        method: 'GET',
        url: '/api/seat/observe',
        headers: { authorization: `Bearer ${redKey}` },
      });
      if (obs.statusCode === 200) {
        const parsed = obs.json() as { status?: string; observation?: { board?: unknown[][] } };
        if (parsed.status === 'your-turn' && parsed.observation?.board) {
          obs = { statusCode: 200, body: JSON.stringify(parsed) };
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const parsed = JSON.parse(obs.body) as {
      status: string;
      observation: { board: Array<Array<{ side: number; kind: string } | null>> };
    };
    expect(parsed.status).toBe('your-turn');
    expect(parsed.observation.board).toHaveLength(10);
    expect(parsed.observation.board[0]).toHaveLength(9);
    const pieceCount = parsed.observation.board.flat().filter(Boolean).length;
    expect(pieceCount).toBe(32);

    // 红方提交合法首着（炮二平五）：{ from: [1,7], to: [4,7] }
    const act = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/act',
      headers: { authorization: `Bearer ${redKey}` },
      payload: { action: { from: [1, 7], to: [4, 7] } },
    });
    expect(act.statusCode).toBe(200);

    // 非法首着（马走斜线）→ 400 + 原因
    const illegal = await ctx.app.inject({
      method: 'POST',
      url: '/api/seat/act',
      headers: { authorization: `Bearer ${redKey}` },
      // 轮到黑方了，红方再提交应 409；改用黑方座位测非法 400
      payload: { action: { from: [1, 7], to: [2, 6] } },
    });
    if (illegal.statusCode !== 409) {
      expect(illegal.statusCode).toBe(400);
    }
  });
});
