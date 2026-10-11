/**
 * 表演赛存储测试（TDD 红灯先行）。
 *
 * 覆盖（ADR 0017）：
 * - 创建表演赛：落库、两把座位密钥、限额（每用户 3 / 全站 30）；
 * - 密钥认证：明文→matchId+side；结束/作废后失效；
 * - 生命周期：暂停/恢复、作废、结束、活跃计数；
 * - 公开/私密列表过滤。
 */

import { describe, it, expect } from 'vitest';
import { initDatabase } from '../src/db/database.js';
import { ExhibitionStore } from '../src/services/exhibition-store.js';
import { DEFAULT_PER_MOVE_TIMEOUT_MS } from '../src/services/exhibition-contracts.js';

function makeStore() {
  const db = initDatabase(':memory:');
  return { store: new ExhibitionStore(db), db };
}

describe('ExhibitionStore 创建与密钥', () => {
  it('创建表演赛：落库字段 + 两把独立座位密钥（红=side 0 先手）', () => {
    const { store } = makeStore();
    const created = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      title: '我的表演赛',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    expect(created.matchId).toBeTruthy();
    expect(created.gameId).toBe('xiangqi');
    expect(created.creatorUserId).toBe('user-1');
    expect(created.title).toBe('我的表演赛');
    expect(created.seatNames).toEqual([null, null]);
    expect(created.paused).toBe(false);
    expect(created.voidedAt).toBeNull();
    expect(created.finishedAt).toBeNull();

    const keys = store.listSeatKeys(created.matchId);
    expect(keys).toHaveLength(2);
    expect(keys[0]!.side).toBe(0);
    expect(keys[1]!.side).toBe(1);
    expect(keys[0]!.key).not.toBe(keys[1]!.key);
    expect(keys[0]!.key.length).toBeGreaterThanOrEqual(20);

    // 明文认证
    const p0 = store.authenticateSeat(keys[0]!.key);
    expect(p0).toEqual({ matchId: created.matchId, side: 0 });
    const p1 = store.authenticateSeat(keys[1]!.key);
    expect(p1).toEqual({ matchId: created.matchId, side: 1 });

    // 错误密钥
    expect(store.authenticateSeat('wrong-key')).toBeNull();
  });

  it('缺省标题自动生成（含对局短 id）', () => {
    const { store } = makeStore();
    const created = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      title: undefined,
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: false,
    });
    expect(created.title).toContain(created.matchId.slice(0, 6));
    expect(created.title.length).toBeGreaterThan(6);
  });

  it('限额：每用户 3 场未结束表演赛，第 4 场被拒', () => {
    const { store } = makeStore();
    for (let i = 0; i < 3; i++) {
      const r = store.create({
        gameId: 'xiangqi',
        creatorUserId: 'user-1',
        perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
        isPublic: true,
      });
      expect(r).toBeTruthy();
    }
    expect(() =>
      store.create({
        gameId: 'xiangqi',
        creatorUserId: 'user-1',
        perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
        isPublic: true,
      }),
    ).toThrowError(/每用户.*3/);
    // 其他用户不受影响
    expect(
      store.create({
        gameId: 'xiangqi',
        creatorUserId: 'user-2',
        perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
        isPublic: true,
      }).matchId,
    ).toBeTruthy();
  });

  it('限额：全站 30 场未结束表演赛，第 31 场被拒；结束后名额释放', () => {
    const { store } = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const r = store.create({
        gameId: 'xiangqi',
        creatorUserId: `user-${i % 10}`,
        perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
        isPublic: true,
      });
      ids.push(r.matchId);
    }
    // 第 31 场被拒：user-9 已有 3 场，撞的是两个限额之一（每用户 3 / 全站 30）。
    // 30 场分给 10 个用户 → 每人 3 场，全站也已满，两个条件同时成立。
    expect(() =>
      store.create({
        gameId: 'xiangqi',
        creatorUserId: 'user-9',
        perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
        isPublic: true,
      }),
    ).toThrowError(/每用户.*3|全站.*30/);
    // 结束一场释放名额（user-0 已有 3 场，先结束一场它的）
    store.finish(ids[0]!);
    const again = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-0',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    expect(again.matchId).toBeTruthy();
  });

  it('作废（1 小时无第一手）同样释放限额名额，且密钥失效', () => {
    const { store } = makeStore();
    const r = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    const keys = store.listSeatKeys(r.matchId);
    store.void(r.matchId);
    // 密钥失效
    expect(store.authenticateSeat(keys[0]!.key)).toBeNull();
    expect(store.authenticateSeat(keys[1]!.key)).toBeNull();
    // 名额释放：同用户能再建
    expect(
      store.create({
        gameId: 'xiangqi',
        creatorUserId: 'user-1',
        perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
        isPublic: true,
      }).matchId,
    ).toBeTruthy();
  });
});

describe('ExhibitionStore 生命周期', () => {
  it('暂停/恢复切换；结束/作废后不可再暂停', () => {
    const { store } = makeStore();
    const r = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    expect(store.setPaused(r.matchId, true)).toBe(true);
    expect(store.get(r.matchId)!.paused).toBe(true);
    expect(store.setPaused(r.matchId, false)).toBe(true);
    expect(store.get(r.matchId)!.paused).toBe(false);

    store.finish(r.matchId);
    expect(store.setPaused(r.matchId, true)).toBe(false);
  });

  it('自报名称：setSeatName 按 side 更新，另一侧不受影响', () => {
    const { store } = makeStore();
    const r = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    expect(store.setSeatName(r.matchId, 0, 'DeepSeek-R1')).toBe(true);
    expect(store.get(r.matchId)!.seatNames).toEqual(['DeepSeek-R1', null]);
    store.setSeatName(r.matchId, 1, 'GPT-5');
    expect(store.get(r.matchId)!.seatNames).toEqual(['DeepSeek-R1', 'GPT-5']);
    // 名称为空串/超长被拒（防刷屏）
    expect(store.setSeatName(r.matchId, 0, '')).toBe(false);
    expect(store.setSeatName(r.matchId, 0, 'x'.repeat(65))).toBe(false);
  });

  it('列表：公开表演赛进列表，私密的只在全量查询（管理端）出现', () => {
    const { store } = makeStore();
    const pub = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    const priv = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: false,
    });
    const publicList = store.listPublic();
    expect(publicList.map((r) => r.matchId)).toContain(pub.matchId);
    expect(publicList.map((r) => r.matchId)).not.toContain(priv.matchId);
    // 管理端全量
    const all = store.listAll();
    expect(all).toHaveLength(2);
    // 按创建者过滤
    expect(store.listByCreator('user-1')).toHaveLength(2);
    expect(store.listByCreator('user-2')).toHaveLength(0);
  });

  it('活跃（未结束且未作废）计数', () => {
    const { store } = makeStore();
    const a = store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-1',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    store.create({
      gameId: 'xiangqi',
      creatorUserId: 'user-2',
      perMoveTimeoutMs: DEFAULT_PER_MOVE_TIMEOUT_MS,
      isPublic: true,
    });
    expect(store.countActive()).toBe(3);
    expect(store.countActiveByUser('user-1')).toBe(2);
    store.finish(a.matchId);
    expect(store.countActive()).toBe(2);
    expect(store.countActiveByUser('user-1')).toBe(1);
  });
});
