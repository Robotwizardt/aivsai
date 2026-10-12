/**
 * 表演赛核心服务测试（TDD）：SeatHandle 适配器——把 EntrantHandle.act 的实现
 * 从「QuickJS 沙箱回调」替换为「等待外部 HTTP 提交」（ADR 0017）。
 *
 * 用五子棋游戏包做真实引擎跑全流程：
 * - 创建即开跑：createExhibition 后引擎已待命询问红方；
 * - 提交协议：observe（局面）→ act（行动）→ 轮转；act 返回时下一座位已待命；
 * - 暂停时提交 409、观察返回 paused；
 * - 非法行动 400 + 原因（validateAction 预校验）；连续 3 次非法判负；
 * - 每步时限超时判负；解散作废；结束后 seat key 失效。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../src/db/database.js';
import { ExhibitionStore } from '../src/services/exhibition-store.js';
import { ExhibitionService } from '../src/services/exhibition-service.js';
import { gomokuGamePackage } from '../src/games/gomoku/gomoku-game.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';
import { LiveHub } from '../src/engine/live-hub.js';
import type { GamePackage } from '../src/games/contracts.js';
import type { GameDefinition } from '../src/games/contracts.js';

/** 未声明 exhibitionEligible 的假游戏包（模拟坦克式即时制，验证准入门槛）。 */
const tickGameDefinition: GameDefinition = {
  id: 'tick-game',
  name: '时钟游戏',
  pacing: 'instant',
  actionNames: ['noop'],
};
const tickGamePackage: GamePackage = {
  definition: tickGameDefinition,
  createInstance: () => {
    throw new Error('不应创建实例（准入测试）');
  },
};

/** 表演赛引擎（可注入时钟；扫描间隔调小让超时测试可触发）。 */
function makeEngine(
  now: () => number,
  extraGames: Array<[string, GamePackage]> = [],
) {
  const db = initDatabase(':memory:');
  const exhibitionStore = new ExhibitionStore(db);
  const matchStore = new SQLiteMatchStore(db);
  const liveHub = new LiveHub({ getRecord: (id) => matchStore.get(id) });
  const games = new Map<string, GamePackage>([
    ['gomoku', gomokuGamePackage],
    ...extraGames,
  ]);
  const service = new ExhibitionService({
    exhibitionStore,
    matchStore,
    liveHub,
    games,
    now,
    timeoutScanMs: 20,
  });
  return { db, exhibitionStore, matchStore, liveHub, games, service };
}

describe('ExhibitionService 全流程（gomoku 引擎）', () => {
  let nowMs: number;
  const now = () => nowMs;
  let engine: ReturnType<typeof makeEngine>;
  let created: { matchId: string; redKey: string; blackKey: string };

  beforeEach(() => {
    nowMs = 1_000_000;
    engine = makeEngine(now);
    const r = engine.service.createExhibition({
      gameId: 'gomoku',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: 5_000,
    });
    const keys = engine.exhibitionStore.listSeatKeys(r.matchId);
    created = {
      matchId: r.matchId,
      redKey: keys.find((k) => k.side === 0)!.key,
      blackKey: keys.find((k) => k.side === 1)!.key,
    };
  });

  afterEach(() => {
    engine.service.shutdown();
    engine.db.close();
  });

  it('创建即开跑：红方 observe 可拿到先手局面，黑方 observe 提示未轮到', async () => {
    const obs = await engine.service.observe(created.redKey);
    expect(obs).toMatchObject({
      status: 'your-turn',
      side: 0,
      moveCount: 0,
    });
    const gomokuObs = obs.observation as { board: unknown[]; me: { side: number } };
    expect(gomokuObs.me.side).toBe(0);
    expect(gomokuObs.board).toHaveLength(15);

    const black = await engine.service.observe(created.blackKey);
    expect(black.status).toBe('waiting');
  });

  it('完整对局流程：双方轮流提交行动直到分出胜负；帧直播落库；结束后进入观察期', async () => {
    // 五子棋：黑棋（side0）从中心开始连成一行即可。让红方横排连五、黑方随便下。
    const redMoves: Array<[number, number]> = [
      [7, 7],
      [8, 7],
      [9, 7],
      [10, 7],
      [11, 7],
    ];
    const blackMoves: Array<[number, number]> = [
      [7, 8],
      [8, 8],
      [9, 8],
      [10, 8],
    ];
    let finished = false;
    const p = engine.service
      .runMatch(created.matchId)
      .then(() => {
        finished = true;
      })
      .catch(() => {
        finished = true;
      });

    for (let i = 0; i < 5; i++) {
      // 红方轮询到 your-turn 后提交
      let obs = await engine.service.observe(created.redKey);
      expect(obs.status).toBe('your-turn');
      const submit = await engine.service.act(created.redKey, { place: redMoves[i] });
      expect(submit.ok).toBe(true);
      if (i < 4) {
        obs = await engine.service.observe(created.blackKey);
        expect(obs.status).toBe('your-turn');
        const b = await engine.service.act(created.blackKey, { place: blackMoves[i]! });
        expect(b.ok).toBe(true);
      }
    }
    await p;
    expect(finished).toBe(true);

    // 对局记录：kind=exhibition，phase=finished，红方胜
    const record = engine.matchStore.get(created.matchId);
    expect(record).not.toBeNull();
    expect(record!.kind).toBe('exhibition');
    expect(record!.phase).toBe('finished');
    expect(record!.result!.outcome.kind).toBe('win');
    expect((record!.result!.outcome as { winner: 0 | 1 }).winner).toBe(0);
    // 帧已落库（至少 9 个决策点帧）
    expect(record!.frames.length).toBeGreaterThanOrEqual(9);

    // 观察期：密钥保留，observe 返回 finished（而不是 401）——外部 AI 凭此自己收摊
    const over = await engine.service.observe(created.redKey);
    expect(over.status).toBe('finished');
    expect(over.side).toBe(0);
    expect(over.moveCount).toBeGreaterThan(0);
    // 结束后出手仍是 409，且不是鉴权失败
    await expect(engine.service.act(created.redKey, { place: [0, 0] })).rejects.toMatchObject({
      statusCode: 409,
    });
    // exhibitions 表也结束
    const ex = engine.exhibitionStore.get(created.matchId);
    expect(ex!.finishedAt).not.toBeNull();
  });

  it('未轮到时提交 → 409 可重试状态；轮到时对方提交 → 同样 409', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    // 黑方未轮到就提交
    const early = await engine.service.act(created.blackKey, { place: [0, 0] }).catch((e) => e);
    expect(early).toMatchObject({ statusCode: 409 });
    // 红方提交合法首手
    const ok = await engine.service.act(created.redKey, { place: [7, 7] });
    expect(ok.ok).toBe(true);
    // 红方再提交（已轮到黑方）→ 409
    const again = await engine.service.act(created.redKey, { place: [8, 8] }).catch((e) => e);
    expect(again).toMatchObject({ statusCode: 409 });
    // 收尾：黑方连续非法 3 次判负，让对局结束
    for (let i = 0; i < 3; i++) {
      await engine.service.act(created.blackKey, { place: [7, 7] }).catch(() => undefined);
    }
    await p;
  });

  it('非法行动 400 + 原因；连续 3 次非法判负', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    // 红方非法（越界）
    const bad = await engine.service.act(created.redKey, { place: [99, 99] }).catch((e) => e);
    expect(bad).toMatchObject({ statusCode: 400 });
    expect(String(bad.message)).toContain('越界');
    // 红方累计 3 次非法判负（黑方胜）
    await engine.service.act(created.redKey, { place: [-1, 0] }).catch(() => undefined);
    await engine.service.act(created.redKey, { place: [-2, 0] }).catch(() => undefined);
    await p;
    const record = engine.matchStore.get(created.matchId);
    expect(record!.result!.outcome.kind).toBe('win');
    expect((record!.result!.outcome as { winner: 0 | 1 }).winner).toBe(1);
  });

  it('暂停：提交返回 409、observe 返回 paused；恢复后继续', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    engine.exhibitionStore.setPaused(created.matchId, true);
    const blocked = await engine.service.act(created.redKey, { place: [7, 7] }).catch((e) => e);
    expect(blocked).toMatchObject({ statusCode: 409 });
    const obs = await engine.service.observe(created.redKey);
    expect(obs.status).toBe('paused');
    // 恢复
    engine.exhibitionStore.setPaused(created.matchId, false);
    const ok = await engine.service.act(created.redKey, { place: [7, 7] });
    expect(ok.ok).toBe(true);
    // 收尾：黑方连续非法 3 次判负（[7,7] 已被红方占用）
    for (let i = 0; i < 3; i++) {
      await engine.service.act(created.blackKey, { place: [7, 7] }).catch(() => undefined);
    }
    await p;
  });

  it('每步时限超时判负（时钟推进 5 秒无行动 → 红方负）', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    // 时钟推进超过每步时限
    nowMs += 6_000;
    await new Promise((r) => setTimeout(r, 150));
    await p;
    const record = engine.matchStore.get(created.matchId);
    expect(record!.result!.outcome.kind).toBe('win');
    expect((record!.result!.outcome as { winner: 0 | 1 }).winner).toBe(1);
    expect(record!.result!.outcome.reason).toContain('超时');
  });

  it('自报名称：act 前可 setName，重复报名被拒绝（首手锁定）', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    const r1 = await engine.service.setName(created.redKey, 'DeepSeek-R1');
    expect(r1).toBe(true);
    // 提交首手后名称锁定
    await engine.service.act(created.redKey, { place: [7, 7] });
    const r2 = await engine.service.setName(created.redKey, '改名').catch((e) => e);
    expect(r2).toMatchObject({ statusCode: 409 });
    // 收尾：黑方连续非法 3 次判负（[7,7] 已被红方占用）
    for (let i = 0; i < 3; i++) {
      await engine.service.act(created.blackKey, { place: [7, 7] }).catch(() => undefined);
    }
    await p;
    const ex = engine.exhibitionStore.get(created.matchId);
    expect(ex!.seatNames[0]).toBe('DeepSeek-R1');
  });

  it('错误密钥 → 401', async () => {
    await expect(engine.service.observe('bad-key')).rejects.toMatchObject({ statusCode: 401 });
    await expect(engine.service.act('bad-key', { place: [0, 0] })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('解散（dissolve）：对局作废结束，密钥仍可查（观察期）', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    await engine.service.dissolve(created.matchId, 'user-1');
    await p;
    const ex = engine.exhibitionStore.get(created.matchId);
    expect(ex!.voidedAt).not.toBeNull();
    const over = await engine.service.observe(created.redKey);
    expect(over).toMatchObject({ status: 'finished', side: 0, hint: '对局已作废' });
    await expect(engine.service.act(created.redKey, { place: [0, 0] })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('非创建者不能解散（403），创建者本人可以', async () => {
    const p = engine.service.runMatch(created.matchId).catch(() => undefined);
    await expect(engine.service.dissolve(created.matchId, 'user-2')).rejects.toMatchObject({
      statusCode: 403,
    });
    await engine.service.dissolve(created.matchId, 'user-1');
    await p;
  });
});

describe('ExhibitionService 创建入口', () => {
  it('未知游戏 → 404', () => {
    const nowMs = 1_000_000;
    const engine = makeEngine(() => nowMs);
    try {
      expect(() =>
        engine.service.createExhibition({
          gameId: 'nonexistent',
          creatorUserId: 'user-1',
        }),
      ).toThrowError();
    } finally {
      engine.service.shutdown();
      engine.db.close();
    }
  });

  it('未声明 exhibitionEligible 的游戏（如坦克式即时制）→ 400 不可建表演赛', () => {
    const engine = makeEngine(() => 1_000_000, [
      ['tick-game', tickGamePackage],
    ]);
    try {
      expect(() =>
        engine.service.createExhibition({
          gameId: 'tick-game',
          creatorUserId: 'user-1',
        }),
      ).toThrowError(/不支持表演赛/);
    } finally {
      engine.service.shutdown();
      engine.db.close();
    }
  });

  it('管理员可解散他人创建的表演赛（actor 前缀 admin:）', async () => {
    const engine = makeEngine(() => 1_000_000);
    let created: { matchId: string; redKey: string; blackKey: string } | null = null;
    try {
      const r = engine.service.createExhibition({
        gameId: 'gomoku',
        creatorUserId: 'user-1',
      });
      const keys = engine.exhibitionStore.listSeatKeys(r.matchId);
      created = {
        matchId: r.matchId,
        redKey: keys.find((k) => k.side === 0)!.key,
        blackKey: keys.find((k) => k.side === 1)!.key,
      };
      await engine.service.dissolve(created.matchId, 'admin:root');
      const ex = engine.exhibitionStore.get(created.matchId);
      expect(ex!.voidedAt).not.toBeNull();
    } finally {
      engine.service.shutdown();
      engine.db.close();
    }
  });
});
