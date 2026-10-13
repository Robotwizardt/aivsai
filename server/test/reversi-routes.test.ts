/** ADR 0019：约定入口为真实 HTTP；不读私有运行态或数据库来断言业务结果。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
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
import { gomokuGamePackage } from '../src/games/gomoku/gomoku-game.js';
import type { GamePackage } from '../src/games/contracts.js';

async function request(base: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: await res.json() };
}

it('生产启动入口注册黑白棋：只开放表演赛，不开放对象、正式/训练和排行榜', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reversi-http-'));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = '';
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, 'test.db'),
        ADMIN_USERNAME: 'reversi_admin', ADMIN_PASSWORD: 'test-password' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk) => { output += chunk; });
    child.stderr!.on('data', (chunk) => { output += chunk; });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await request(base, '/api/games'); ready = true; break; } catch { /* wait for listen */ }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, output).toBe(true);
    const normal = await request(base, '/api/games');
    expect(normal.body.games.map((g: { id: string }) => g.id)).not.toContain('reversi');
    const exhibitions = await request(base, '/api/exhibitions/games');
    expect(exhibitions.body.games.map((g: { id: string }) => g.id)).toContain('reversi');
    const login = await request(base, '/api/auth/login', undefined,
      { username: 'reversi_admin', password: 'test-password' });
    expect(login.status).toBe(200);
    const token = login.body.token;
    const entrant = await request(base, '/api/entrants', token, {
      gameId: 'reversi', name: '黑白棋对象', appearance: { preset: 'default', color: '#000000', name: '黑' },
    });
    expect(entrant).toMatchObject({ status: 400, body: { error: expect.stringContaining('仅支持表演赛') } });
    for (const kind of ['official', 'training']) {
      expect(await request(base, '/api/matches', token, { gameId: 'reversi', kind,
        myEntrantId: 'not-an-entrant', opponentBotId: 'standard-01' }))
        .toMatchObject({ status: 400, body: { error: expect.stringContaining('仅支持表演赛') } });
    }
    expect(await request(base, '/api/leaderboard/reversi'))
      .toMatchObject({ status: 404, body: { error: expect.stringContaining('仅支持表演赛') } });
    const created = await request(base, '/api/exhibitions', token, { gameId: 'reversi' });
    expect(created.status).toBe(201);
    expect(created.body.seatLinks).toHaveLength(2);
    const key = created.body.seatLinks.find((s: { side: number }) => s.side === 0).key;
    expect(await request(base, '/api/seat/observe', key)).toMatchObject({ status: 200,
      body: { status: 'your-turn', gameId: 'reversi', observation: { counts: [2, 2] } } });
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

// 使用真实服务与 SQLite，只替换时钟边界；HTTP 栈和行动循环不 mock。
describe('黑白棋座位与 AI 文档（真实 HTTP）', () => {
  let app: FastifyInstance;
  let db: SQLiteDatabase;
  let service: ExhibitionService;
  let base: string;
  let token: string;
  let now: number;
  const active: string[] = [];
  const api = (path: string, key?: string, body?: unknown) => request(base, path, key, body);

  beforeEach(async () => {
    now = Date.now();
    db = initDatabase(':memory:');
    const users = new UserService(db);
    users.seedAdmin('reversi_admin', 'test-password');
    const matches = new SQLiteMatchStore(db);
    const hub = new LiveHub({ getRecord: (id) => matches.get(id) });
    const packages = new Map<string, GamePackage>([['reversi', reversiGamePackage], ['gomoku', gomokuGamePackage]]);
    service = new ExhibitionService({ exhibitionStore: new ExhibitionStore(db), matchStore: matches,
      liveHub: hub, games: packages, now: () => now, timeoutScanMs: 0 });
    app = await buildApp({ userService: users, entrantService: new EntrantService(db),
      strategyService: new StrategyService(db), rankingService: new RankingService(),
      games: new Map([...packages].map(([id, pkg]) => [id, pkg.definition])),
      exhibitionService: service, liveHub: hub, getMatch: (id) => matches.get(id) });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
    token = (await api('/api/auth/login', undefined,
      { username: 'reversi_admin', password: 'test-password' })).body.token;
  });
  afterEach(async () => {
    for (const id of active.splice(0)) await api(`/api/exhibitions/${id}/dissolve`, token, {});
    service.shutdown();
    await app.close();
    db.close();
  });

  it('双座位标准开局、轮次保护；每方累计三错不清零，非法重试完整计时，终局观察与行动 409', async () => {
    const created = await api('/api/exhibitions', token, { gameId: 'reversi', perMoveTimeoutMinutes: 1 });
    expect(created.status).toBe(201);
    const { matchId, seatLinks } = created.body;
    active.push(matchId);
    const keys = [0, 1].map((side) => seatLinks.find((s: { side: number }) => s.side === side).key);
    const observe = (side: number) => api('/api/seat/observe', keys[side]);
    const act = (side: number, action: unknown) => api('/api/seat/act', keys[side], { action });
    const opening = await observe(0);
    expect(opening).toMatchObject({ status: 200, body: { status: 'your-turn', side: 0,
      gameId: 'reversi', moveCount: 0, remainingMs: 60_000, observation: {
        me: { side: 0 }, currentSide: 0, counts: [2, 2], lastMove: null,
        lastFlipped: [], passedSide: null, moveCount: 0,
        legalMoves: [[3, 2], [2, 3], [5, 4], [4, 5]],
        board: [
          [null, null, null, null, null, null, null, null],
          [null, null, null, null, null, null, null, null],
          [null, null, null, null, null, null, null, null],
          [null, null, null, 1, 0, null, null, null],
          [null, null, null, 0, 1, null, null, null],
          [null, null, null, null, null, null, null, null],
          [null, null, null, null, null, null, null, null],
          [null, null, null, null, null, null, null, null],
        ],
      } } });
    expect(await observe(1)).toMatchObject({ status: 200, body: { status: 'waiting', side: 1, moveCount: 0 } });
    expect((await act(1, { place: [3, 2] })).status).toBe(409);
    expect((await api('/api/seat/observe', 'invalid-seat-key')).status).toBe(401);

    // 黑方第 1 错；时间确实已消耗，再验证重试恢复完整时限且局面不变。
    now += 59_000;
    expect((await observe(0)).body.remainingMs).toBe(1_000);
    expect(await act(0, { place: [99, 99] })).toMatchObject({ status: 400,
      body: { error: expect.stringContaining('越界') } });
    expect((await observe(0)).body).toEqual(opening.body);
    expect((await act(0, { place: [3, 2] })).status).toBe(200);
    expect((await observe(0)).body.status).toBe('waiting');
    expect((await act(0, { place: [2, 2] })).status).toBe(409);
    expect((await observe(1)).body).toMatchObject({ status: 'your-turn', side: 1,
      moveCount: 1, remainingMs: 60_000, observation: { me: { side: 1 }, currentSide: 1,
        counts: [4, 1], lastMove: [3, 2], lastFlipped: [[3, 3]], moveCount: 1 } });

    // 白方第 1 错不影响黑方累计；合法落子不能清零任何一方计数。
    now += 58_000;
    expect(await act(1, { place: [3, 3] })).toMatchObject({ status: 400,
      body: { error: expect.stringContaining('占用') } });
    expect((await observe(1)).body).toMatchObject({ remainingMs: 60_000, moveCount: 1 });
    expect((await act(1, { place: [2, 2] })).status).toBe(200);
    now += 57_000;
    expect(await act(0, { pass: true })).toMatchObject({ status: 400,
      body: { error: expect.stringContaining('格式') } });
    expect((await observe(0)).body).toMatchObject({ status: 'your-turn', remainingMs: 60_000, moveCount: 2 });
    expect((await act(0, { place: [1, 2] })).status).toBe(200);
    now += 56_000;
    expect(await act(1, { place: [0, 0] })).toMatchObject({ status: 400,
      body: { error: expect.stringContaining('翻转') } });
    const white = (await observe(1)).body;
    expect(white).toMatchObject({ status: 'your-turn', remainingMs: 60_000, moveCount: 3 });
    expect((await act(1, { place: white.observation.legalMoves[0] })).status).toBe(200);
    expect((await act(0, { place: [99, 99] })).status).toBe(400); // 黑方累计第 3 错
    for (const side of [0, 1]) {
      expect(await observe(side)).toMatchObject({ status: 200,
        body: { status: 'finished', side, gameId: 'reversi', moveCount: 4 } });
      expect((await act(side, { place: [0, 0] })).status).toBe(409);
    }
    expect(await api(`/api/matches/${matchId}`)).toMatchObject({ status: 200,
      body: { phase: 'finished', result: { outcome: { kind: 'win', winner: 1 } } } });
  });

  it('自动跳过不索取 pass、不计步；同方连续走重开完整计时，棋盘未满且双方无合法落点即终局', async () => {
    // 独立规则脚本生成并固定的完整棋谱（seed 71）：第 58 手跳过黑方，59 手终局，15:48，1 空格。
    // 保留真实 side，而非按手数奇偶推断；不使用生产规则或返回 legalMoves 生成预期。
    const moves = [
      [0,5,4],[1,3,5],[0,2,2],[1,6,4],[0,4,5],[1,5,6],[0,4,6],[1,5,5],
      [0,7,4],[1,6,3],[0,6,5],[1,5,2],[0,4,7],[1,5,3],[0,7,3],[1,3,2],
      [0,2,1],[1,4,2],[0,3,1],[1,6,7],[0,6,6],[1,1,2],[0,5,1],[1,7,7],
      [0,2,3],[1,6,2],[0,7,5],[1,4,1],[0,3,6],[1,3,7],[0,5,0],[1,2,0],
      [0,7,2],[1,7,6],[0,3,0],[1,6,0],[0,2,7],[1,5,7],[0,2,5],[1,4,0],
      [0,0,2],[1,1,5],[0,6,1],[1,7,1],[0,1,4],[1,0,5],[0,1,3],[1,1,7],
      [0,0,3],[1,0,1],[0,0,0],[1,2,4],[0,1,1],[1,7,0],[0,0,6],[1,1,6],
      [0,0,4],[1,2,6],[1,1,0],
    ];
    const created = await api('/api/exhibitions', token, { gameId: 'reversi', perMoveTimeoutMinutes: 1 });
    expect(created.status).toBe(201);
    const { matchId, seatLinks } = created.body;
    active.push(matchId);
    const keys = [0, 1].map((side) => seatLinks.find((s: { side: number }) => s.side === side).key);
    for (const [index, [side, x, y]] of moves.entries()) {
      const before = await api('/api/seat/observe', keys[side!]);
      expect(before.body).toMatchObject({ status: 'your-turn', side, moveCount: index,
        remainingMs: 60_000, observation: { currentSide: side, me: { side }, moveCount: index } });
      expect(before.body.observation.legalMoves).toContainEqual([x, y]);
      now += 59_000;
      expect((await api('/api/seat/observe', keys[side!])).body.remainingMs).toBe(1_000);
      expect(await api('/api/seat/act', keys[side!], { action: { place: [x, y] } }))
        .toMatchObject({ status: 200, body: { ok: true } });
      if (index === 57) {
        const sameSide = await api('/api/seat/observe', keys[1]);
        expect(sameSide.body).toMatchObject({ status: 'your-turn', side: 1, moveCount: 58,
          remainingMs: 60_000, observation: { currentSide: 1, passedSide: 0,
            lastMove: [2, 6], moveCount: 58, legalMoves: [[1, 0]] } });
        expect((await api('/api/seat/observe', keys[0])).body)
          .toMatchObject({ status: 'waiting', side: 0, moveCount: 58 });
        expect((await api('/api/seat/act', keys[0], { action: { pass: true } })).status).toBe(409);
        // 非法重试也保留跳过提示、棋盘和成功手数，重新给当前白方完整时限。
        now += 59_000;
        expect((await api('/api/seat/act', keys[1], { action: { place: [99, 99] } })).status).toBe(400);
        expect((await api('/api/seat/observe', keys[1])).body).toEqual(sameSide.body);
      }
    }
    for (const key of keys) {
      expect(await api('/api/seat/observe', key)).toMatchObject({ status: 200,
        body: { status: 'finished', moveCount: 59 } });
      expect((await api('/api/seat/act', key, { action: { pass: true } })).status).toBe(409);
    }
    expect(await api(`/api/matches/${matchId}`)).toMatchObject({ status: 200,
      body: { phase: 'finished', result: { outcome: { kind: 'win', winner: 1 } } } });
    // 终局 SSE 回放仍保留真实顺序与跳过帧；非法尝试产帧但不增加手数。
    const replay = await fetch(`${base}/api/matches/${matchId}/frames`, { signal: AbortSignal.timeout(5_000) });
    expect(replay.status).toBe(200);
    const events = (await replay.text()).split('\n\n');
    const frames = events.filter((e) => e.startsWith('event: frame\n'))
      .map((e) => JSON.parse(e.split('\ndata: ')[1]!));
    const last = frames.at(-1).state;
    expect(last).toMatchObject({ moveCount: 59, lastMove: [1, 0], counts: [15, 48], passedSide: null });
    expect(last.board.flat().filter((cell: unknown) => cell === null)).toHaveLength(1);
    expect(frames.filter((frame) => frame.state.moveCount === 58)).toHaveLength(2);
    expect(frames.filter((frame) => frame.state.moveCount === 58)
      .every((frame) => frame.state.passedSide === 0 && frame.state.currentSide === 1)).toBe(true);
    expect(events.some((e) => e.startsWith('event: end\n'))).toBe(true);
  });

  it('公开 AI 指南完整说明规则、观察、坐标、计错与自动跳过，示例可真实落子', async () => {
    const response = await fetch(`${base}/api/games/reversi/ai-guide`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const guide = await response.text();
    // 文档使用当前 HTTP 入口的 origin，不硬编码开发端口；路径占位符由调用方 URL 编码。
    expect(guide).toContain(`GET ${base}/api/seat/observe`);
    expect(guide).toContain(`POST ${base}/api/seat/act`);
    expect(guide).toContain('encodeURIComponent(matchId)');
    for (const phrase of ['8×8', 'board[y][x]', '0=黑', '1=白', 'null=空',
      'x 向右', 'y 向下', '0..7', '八个方向', '所有', '至少一个', '中央四子',
      '每方整局累计 3 次', '合法落子不清零', '每次重试重新获得完整每步时限',
      '自动跳过', '不提交 pass', '不启动被跳过方的计时', '同一方连续行动',
      '新的完整每步计时', '双方都无合法落点', '棋盘未满', '同数平局', '空位不额外计分',
      'moveCount', 'lastFlipped', 'passedSide', 'legalMoves', 'currentSide', 'counts', 'lastMove', 'me.side',
      '初始摆子、翻转、自动跳过和非法尝试均不计入',
      'Authorization: Bearer', 'your-turn', 'waiting', 'paused', 'finished', '400', '409', '401',
      '[3,2]', '[2,3]', '[5,4]', '[4,5]', '仅支持表演赛']) {
      expect(guide, phrase).toContain(phrase);
    }
    // 文档中的 JSON 行动示例必须能被真正的座位协议接受。
    const example = JSON.parse(guide.match(/```json\s*([\s\S]*?)```/)![1]!);
    const created = await api('/api/exhibitions', token, { gameId: 'reversi', perMoveTimeoutMinutes: 1 });
    expect(created.status).toBe(201);
    active.push(created.body.matchId);
    const black = created.body.seatLinks.find((s: { side: number }) => s.side === 0).key;
    expect(await api('/api/seat/act', black, example)).toMatchObject({ status: 200, body: { ok: true } });
  });
});
