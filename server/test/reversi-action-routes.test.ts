/** 行动解释一致性：真实 HTTP + 座位服务 + 游戏包，不 mock 行动循环。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { reversiGamePackage } from '../src/games/reversi/reversi-game.js';

describe('黑白棋行动规范化（真实 HTTP）', () => {
  let app: FastifyInstance;
  let db: SQLiteDatabase;
  let service: ExhibitionService;
  let base: string;
  let token: string;
  let matchId: string;
  let keys: string[];

  async function api(path: string, key?: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() };
  }

  beforeEach(async () => {
    db = initDatabase(':memory:');
    const users = new UserService(db);
    users.seedAdmin('action_admin', 'test-password');
    const matches = new SQLiteMatchStore(db);
    const hub = new LiveHub({ getRecord: (id) => matches.get(id) });
    const packages = new Map([['reversi', reversiGamePackage]]);
    service = new ExhibitionService({ exhibitionStore: new ExhibitionStore(db), matchStore: matches,
      liveHub: hub, games: packages, timeoutScanMs: 0 });
    app = await buildApp({ userService: users, entrantService: new EntrantService(db),
      strategyService: new StrategyService(db), rankingService: new RankingService(),
      games: new Map([['reversi', reversiGamePackage.definition]]),
      exhibitionService: service, liveHub: hub, getMatch: (id) => matches.get(id) });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
    token = (await api('/api/auth/login', undefined,
      { username: 'action_admin', password: 'test-password' })).body.token;
    const created = await api('/api/exhibitions', token, { gameId: 'reversi' });
    expect(created.status).toBe(201);
    matchId = created.body.matchId;
    keys = [0, 1].map((side) => created.body.seatLinks.find((seat: { side: number }) => seat.side === side).key);
  });

  afterEach(async () => {
    if (matchId) await api(`/api/exhibitions/${matchId}/dissolve`, token, {});
    service.shutdown();
    await app.close();
    db.close();
  });

  it.each([
    { name: '外层合法但 returned 非法', action: { place: [3, 2], commands: [], returned: { place: [0, 0] } }, error: '翻转' },
    { name: '合法 place 混合 kind:error', action: { place: [3, 2], kind: 'error', message: '拒绝执行' }, error: '拒绝执行' },
    { name: '信封 returned 混合 kind:error', action: { place: [3, 2], commands: [], returned: { place: [2, 3], kind: 'error', message: '信封错误' } }, error: '信封错误' },
  ])('$name：HTTP 拒绝且座位手数与局面手数保持一致', async ({ action, error }) => {
    const before = (await api('/api/seat/observe', keys[0])).body;
    expect(before).toMatchObject({ status: 'your-turn', moveCount: 0, observation: { moveCount: 0 } });
    expect(await api('/api/seat/act', keys[0], { action })).toMatchObject({
      status: 400, body: { error: expect.stringContaining(error) },
    });
    expect((await api('/api/seat/observe', keys[0])).body).toMatchObject({
      status: 'your-turn', moveCount: 0, observation: before.observation,
    });
    expect((await api('/api/seat/observe', keys[1])).body).toMatchObject({ status: 'waiting', moveCount: 0 });
    // 同一座位仍可重试，成功后公共手数与游戏状态同时只增加一手。
    expect(await api('/api/seat/act', keys[0], { action: { place: [3, 2] } }))
      .toMatchObject({ status: 200, body: { ok: true } });
    expect((await api('/api/seat/observe', keys[1])).body).toMatchObject({
      status: 'your-turn', moveCount: 1,
      observation: { moveCount: 1, lastMove: [3, 2], counts: [4, 1], currentSide: 1 },
    });
  });

  it.each([
    { name: '直接行动', action: { kind: 'error', message: { toString: null } } },
    { name: '信封行动', action: { commands: [], returned: { kind: 'error', message: { toString: null } } } },
  ])('$name：不可字符串化消息返回 400，累计三次后判负', async ({ action }) => {
    const before = (await api('/api/seat/observe', keys[0])).body;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await api('/api/seat/act', keys[0], { action })).toMatchObject({
        status: 400, body: { error: '未知策略错误' },
      });
      const observed = (await api('/api/seat/observe', keys[0])).body;
      if (attempt < 3) {
        expect(observed).toMatchObject({
          status: 'your-turn', moveCount: 0, observation: before.observation,
        });
      } else {
        expect(observed).toMatchObject({ status: 'finished', moveCount: 0 });
      }
    }
    expect(await api(`/api/matches/${matchId}`, token)).toMatchObject({
      status: 200, body: { phase: 'finished', result: { outcome: { kind: 'win', winner: 1 } } },
    });
    expect((await api('/api/seat/act', keys[0], { action: { place: [3, 2] } })).status).toBe(409);
  });

  it('合法混合信封以 returned 落子，HTTP 成功与帧局面一致', async () => {
    expect(await api('/api/seat/act', keys[0], {
      action: { place: [0, 0], commands: [], returned: { place: [2, 3] } },
    })).toMatchObject({ status: 200, body: { ok: true } });
    const observed = (await api('/api/seat/observe', keys[1])).body;
    expect(observed).toMatchObject({ status: 'your-turn', moveCount: 1,
      observation: { moveCount: 1, lastMove: [2, 3], counts: [4, 1] } });
    expect(observed.observation.board[3][2]).toBe(0);
    expect(observed.observation.board[0][0]).toBeNull();
  });
});
