import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { initDatabase } from '../src/db/database.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';
import { LiveHub } from '../src/engine/live-hub.js';
import { UserService } from '../src/services/user-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import { ExhibitionStore } from '../src/services/exhibition-store.js';
import { ExhibitionService } from '../src/services/exhibition-service.js';
import { xiangqiGamePackage } from '../src/games/xiangqi/xiangqi-game.js';
import { gomokuGamePackage } from '../src/games/gomoku/gomoku-game.js';
import { tankGamePackage } from '../src/games/tank/tank-game.js';
import type { MatchResult } from '../src/games/contracts.js';

// 真实 HTTP、认证、SQLite、LiveHub 与棋类引擎。
// 不快照凭据或原始请求头；诊断断言仅使用测试数据。
const db = initDatabase(':memory:');
const users = new UserService(db);
const entrants = new EntrantService(db);
const store = new SQLiteMatchStore(db);
const hub = new LiveHub({ getRecord: (id) => store.get(id) });
const games = new Map([
  ['xiangqi', xiangqiGamePackage], ['gomoku', gomokuGamePackage], ['tank', tankGamePackage],
]);
const exhibitions = new ExhibitionService({
  exhibitionStore: new ExhibitionStore(db), matchStore: store, liveHub: hub, games,
});
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
const viewers: Array<{ role: string; token?: string; userId?: string; allowed: boolean }> = [
  { role: 'guest', allowed: false },
];
const bearer = (token?: string): Record<string, string> => token ? { authorization: `Bearer ${token}` } : {};

beforeAll(async () => {
  for (const role of ['creator', 'unrelated', 'admin']) {
    const password = randomUUID();
    if (role === 'admin') users.seedAdmin(role, password);
    else {
      const invite = randomUUID();
      users.addInviteCode(invite);
      users.register(invite, role, password);
    }
    const session = users.login(role, password)!;
    viewers.push({ role, ...session, allowed: role !== 'unrelated' });
  }
  app = await buildApp({
    userService: users, entrantService: entrants, strategyService: new StrategyService(db),
    rankingService: new RankingService(),
    games: new Map([...games].map(([id, pkg]) => [id, pkg.definition])),
    getMatch: (id) => store.get(id), listMatches: (filter) => store.list(filter),
    liveHub: hub, exhibitionService: exhibitions,
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  exhibitions.shutdown();
  await app?.close();
  db.close();
});

async function json(path: string, token?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

async function openStreams(matchId: string) {
  const streams: Array<{ response: Response; abort: AbortController }> = [];
  try {
    for (const viewer of viewers) {
      const abort = new AbortController();
      // 游客连接同时模拟原生 EventSource（无 Authorization）。
      const response = await fetch(`${base}/api/matches/${matchId}/frames`, {
        headers: bearer(viewer.token), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
      });
      streams.push({ response, abort });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    }
    return streams;
  } catch (error) {
    streams.forEach(({ abort }) => abort.abort());
    throw error;
  }
}

function events(text: string) {
  return text.split('\n\n').filter((block) => block.startsWith('event:')).map((block) => {
    const [event, data] = block.split('\n');
    return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) };
  });
}

async function assertPublicStreams(streams: Awaited<ReturnType<typeof openStreams>>, result: MatchResult) {
  for (const [index, { response }] of streams.entries()) {
    const received = events(await response.text());
    expect(received.some((e) => e.event === 'frame')).toBe(true);
    const ends = received.filter((e) => e.event === 'end');
    expect(ends).toHaveLength(1);
    expect.soft(ends[0]!.data, `${viewers[index]!.role} SSE 终局必须只含公开结果`).toEqual({ outcome: result.outcome });
  }
}

async function assertExhibitionSummary(matchId: string, result: MatchResult) {
  for (const viewer of viewers) {
    const summary = await json(`/api/matches/${matchId}`, viewer.token);
    expect(summary.status).toBe(200);
    expect(summary.headers.get('cache-control')).toBe('private, no-store');
    expect(summary.headers.get('vary')).toContain('Authorization');
    expect.soft(summary.data.result, `${viewer.role} 摘要诊断授权`).toEqual(
      viewer.allowed ? result : { outcome: result.outcome },
    );
  }
}

describe('公开 SSE 诊断边界', () => {
  it('最小复现：一条持久化结果、无引擎、零帧、匿名 HTTP 晚订阅', async () => {
    const matchId = randomUUID();
    store.create({ matchId, gameId: 'xiangqi', kind: 'exhibition', entrants: [
      { entrantId: 'seat:0', strategyVersionId: '' }, { entrantId: 'seat:1', strategyVersionId: '' },
    ] });
    store.finish(matchId, {
      outcome: { kind: 'win', winner: 1, reason: 'forfeit' },
      failures: [{ entrant: 0, message: 'synthetic-private-diagnostic' }],
    }, 'finished');
    const response = await fetch(`${base}/api/matches/${matchId}/frames`, { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    const received = events(await response.text());
    expect(received).toHaveLength(1);
    expect(received[0]!.data).not.toHaveProperty('failures');
  });
  for (const timing of ['late', 'live']) {
    it(`作废终局 ${timing}：内部 reason 与 failures 均不进入公开 SSE`, async () => {
      const matchId = randomUUID();
      store.create({ matchId, gameId: 'tank', kind: 'official', entrants: [
        { entrantId: 'fixture:0', strategyVersionId: '' }, { entrantId: 'fixture:1', strategyVersionId: '' },
      ] });
      hub.attach(matchId, store);
      const result: MatchResult = {
        outcome: { kind: 'invalid', reason: 'synthetic-platform-diagnostic' },
        failures: [{ entrant: 0, message: 'synthetic-private-diagnostic' }],
      };
      let streams: Awaited<ReturnType<typeof openStreams>> = [];
      try {
        if (timing === 'live') streams = await openStreams(matchId);
        store.finish(matchId, result, 'invalid');
        hub.publishEnd(matchId, result);
        if (timing === 'late') streams = await openStreams(matchId);
        for (const { response } of streams) {
          expect(events(await response.text())).toEqual([{ event: 'end', data: { outcome: { kind: 'invalid' } } }]);
        }
        expect((await json(`/api/matches/${matchId}`)).data.result).toEqual({ outcome: { kind: 'invalid' } });
        expect(store.get(matchId)!.result).toEqual(result);
      } finally { streams.forEach(({ abort }) => abort.abort()); }
    });
  }

  it('运行中摘要和无结果的 end 保持 null，且终局正常关闭 HTTP 流', async () => {
    const matchId = randomUUID();
    store.create({ matchId, gameId: 'tank', kind: 'official', entrants: [
      { entrantId: 'fixture:0', strategyVersionId: '' }, { entrantId: 'fixture:1', strategyVersionId: '' },
    ] });
    hub.attach(matchId, store);
    const streams = await openStreams(matchId);
    try {
      for (const viewer of viewers) {
        expect((await json(`/api/matches/${matchId}`, viewer.token)).data.result).toBeNull();
      }
      hub.publishEnd(matchId, null);
      for (const { response } of streams) {
        expect(events(await response.text())).toEqual([{ event: 'end', data: null }]);
      }
    } finally { streams.forEach(({ abort }) => abort.abort()); }
  });

  // 传输边界使用独立的合成诊断，验证所有游戏均完整移除诊断，
  // 不依赖各游戏错误文案。
  for (const gameId of games.keys()) {
    for (const timing of ['late', 'live']) {
      it(`${gameId} ${timing}：共用公开流不泄露任一方诊断`, async () => {
        const matchId = randomUUID();
        store.create({ matchId, gameId, kind: gameId === 'xiangqi' ? 'exhibition' : 'official', entrants: [
          { entrantId: 'fixture:0', strategyVersionId: '' }, { entrantId: 'fixture:1', strategyVersionId: '' },
        ] });
        hub.attach(matchId, store);
        store.updateFrame(matchId, { tick: 0, state: { moveCount: 0 } });
        const result: MatchResult = {
          outcome: { kind: 'win', winner: 1, reason: 'forfeit' },
          failures: [{ entrant: 0, message: 'synthetic-private-0' }, { entrant: 1, message: 'synthetic-private-1' }],
        };
        let streams: Awaited<ReturnType<typeof openStreams>> = [];
        try {
          if (timing === 'live') streams = await openStreams(matchId);
          store.finish(matchId, result, 'finished');
          hub.publishEnd(matchId, result);
          if (timing === 'late') streams = await openStreams(matchId);
          await assertPublicStreams(streams, result);
          expect(store.get(matchId)!.result).toEqual(result);
        } finally { streams.forEach(({ abort }) => abort.abort()); }
      });
    }
  }

  for (const kind of ['official', 'training'] as const) {
    it(`${kind} 摘要：只读己方诊断，API 令牌不继承用户级权限`, async () => {
      const creator = viewers.find((v) => v.role === 'creator')!;
      const admin = viewers.find((v) => v.role === 'admin')!;
      const createEntrant = (userId: string) => entrants.createEntrant(userId, {
        gameId: 'tank', name: 'fixture', appearance: { preset: 'basic', color: '#000000', name: 'fixture' },
      });
      const own = createEntrant(creator.userId!);
      const opponent = createEntrant(admin.userId!);
      const sibling = createEntrant(creator.userId!);
      const matchId = randomUUID();
      store.create({ matchId, gameId: 'tank', kind, entrants: [
        { entrantId: own.id, strategyVersionId: '' }, { entrantId: opponent.id, strategyVersionId: '' },
      ] });
      const result: MatchResult = {
        outcome: { kind: 'draw', reason: 'both failed' },
        failures: [{ entrant: 0, message: 'synthetic-own' }, { entrant: 1, message: 'synthetic-opponent' }],
      };
      store.finish(matchId, result, 'finished');
      for (const viewer of viewers) {
        const response = await json(`/api/matches/${matchId}`, viewer.token);
        const expected = viewer.role === 'admin' ? result.failures : viewer.role === 'creator' ? [result.failures[0]] : undefined;
        expect.soft(response.data.result).toEqual({ outcome: result.outcome, ...(expected ? { failures: expected } : {}) });
      }
      const ownToken = entrants.issueEntrantCredential(own.id)!;
      const siblingToken = entrants.issueEntrantCredential(sibling.id)!;
      expect.soft((await json(`/api/matches/${matchId}`, ownToken)).data.result).toEqual({ outcome: result.outcome, failures: [result.failures[0]] });
      expect.soft((await json(`/api/matches/${matchId}`, siblingToken)).data.result).toEqual({ outcome: result.outcome });
      // 保持现有训练观战权限。
      if (kind === 'training') {
        for (const viewer of viewers.filter((v) => !v.allowed)) {
          const response = await fetch(`${base}/api/matches/${matchId}/frames`, { headers: bearer(viewer.token), signal: AbortSignal.timeout(3000) });
          expect(response.status).toBe(403);
          await response.text();
        }
        const response = await fetch(`${base}/api/matches/${matchId}/frames`, { headers: bearer(ownToken), signal: AbortSignal.timeout(3000) });
        expect(events(await response.text())[0]!.data).toEqual({ outcome: result.outcome });
      }
    });
  }

  for (const gameId of ['xiangqi', 'gomoku']) {
    for (const timing of ['late', 'live']) {
      it(`${gameId} ${timing}：游客/无关用户/创建者/admin 的 SSE 与授权摘要`, async () => {
        const creator = viewers.find((v) => v.role === 'creator')!;
        const created = await json('/api/exhibitions', creator.token, { gameId });
        expect(created.status).toBe(201);
        const { matchId, seatLinks } = created.data;
        const seatKey = seatLinks.find((s: { side: number }) => s.side === 0).key as string;
        let streams: Awaited<ReturnType<typeof openStreams>> = [];
        try {
          if (timing === 'live') streams = await openStreams(matchId);
          // 三次非法行动确定性地结束真实表演赛。
          for (let i = 0; i < 3; i++) {
            const action = gameId === 'xiangqi' ? { from: [0, 6], to: [0, 8] } : { place: [99, 99] };
            expect((await json('/api/seat/act', seatKey, { action })).status).toBe(400);
          }
          const result = store.get(matchId)!.result!;
          expect(result.failures.length).toBeGreaterThan(0);
          if (timing === 'late') streams = await openStreams(matchId);
          await assertPublicStreams(streams, result);
          await assertExhibitionSummary(matchId, result);
          // 座位密钥与随机无效令牌不授予创建者权限。
          for (const token of [seatKey, randomUUID()]) {
            expect((await json(`/api/matches/${matchId}`, token)).data.result).toEqual({ outcome: result.outcome });
          }
          // 创建者所持参赛对象的 API 令牌也不能继承表演赛管理权限。
          const ownEntrant = entrants.createEntrant(creator.userId!, {
            gameId: 'tank', name: 'fixture', appearance: { preset: 'basic', color: '#000000', name: 'fixture' },
          });
          const apiToken = entrants.issueEntrantCredential(ownEntrant.id)!;
          expect((await json(`/api/matches/${matchId}`, apiToken)).data.result).toEqual({ outcome: result.outcome });
          // 列表即使带创建者会话也不能返回诊断。
          const listing = await json(`/api/matches?kind=exhibition`, creator.token);
          expect(JSON.stringify(listing.data)).not.toContain('"failures"');
          // 公开投影不能破坏落库诊断。
          expect(store.get(matchId)!.result).toEqual(result);
        } finally {
          streams.forEach(({ abort }) => abort.abort());
        }
      });
    }
  }
});
