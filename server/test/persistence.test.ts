/**
 * SQLite 持久化集成测试：写入数据 → 关闭 db → 重新打开 → 数据仍在。
 * 覆盖：用户/邀请码/会话、参赛对象/API 令牌、策略版本、对局记录、Elo 重建。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase, type SQLiteDatabase } from '../src/db/database.js';
import { UserService } from '../src/services/user-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';

let dir: string | null = null;

function tempDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), 'aivsai-persist-'));
  return join(dir, 'test.db');
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe('SQLite 持久化（关闭重开后数据仍在）', () => {
  it('用户/邀请码/会话/参赛对象/API 令牌/策略版本持久化', () => {
    const path = tempDbPath();

    // 第一次打开：写入完整业务数据。
    const userId: string[] = [];
    let sessionToken = '';
    let entrantId: string;
    let apiToken: string;
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      const entrantService = new EntrantService(db);
      const strategyService = new StrategyService(db);

      userService.addInviteCode('PERSIST-CODE');
      const registered = userService.register('PERSIST-CODE', 'persist_user', 'pass-123', '持久化用户');
      expect(registered).not.toBeNull();
      expect(registered).not.toBe('taken');
      if (!registered || registered === 'taken') throw new Error('注册失败');
      userId.push(registered.userId);

      const login = userService.login('persist_user', 'pass-123');
      expect(login).not.toBeNull();
      sessionToken = login ? login.token : '';

      const entrant = entrantService.createEntrant(registered.userId, {
        gameId: 'tank',
        name: '持久化对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装', customImageUrl: 'https://x/y.png' },
      });
      entrantId = entrant.id;
      apiToken = entrantService.issueEntrantCredential(entrantId)!;
      expect(apiToken).toBeTruthy();

      strategyService.publish(entrantId, 'function onIdle(me){ me.fire(); }');
      strategyService.publish(entrantId, 'function onIdle(me){ me.fire(); me.fire(); }', true);
      strategyService.saveDraft(entrantId, 'draft source');

      db.close();
    }

    // 重新打开：所有数据仍在，凭证可认证。
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      const entrantService = new EntrantService(db);
      const strategyService = new StrategyService(db);

      // 用户与统计
      expect(userService.stats()).toEqual({
        users: 1,
        pendingInviteCodes: 0,
        consumedInviteCodes: 1,
      });
      const user = userService.get(userId[0]!);
      expect(user).toMatchObject({ username: 'persist_user', nickname: '持久化用户', role: 'user' });

      // 会话令牌可认证
      const session = userService.findBySessionToken(sessionToken);
      expect(session?.id).toBe(userId[0]);

      // 参赛对象与外观（JSON 字段）
      const entrants = entrantService.listByUser(userId[0]!);
      expect(entrants).toHaveLength(1);
      expect(entrants[0]).toMatchObject({
        id: entrantId,
        gameId: 'tank',
        name: '持久化对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装', customImageUrl: 'https://x/y.png' },
      });

      // API 令牌仍可认证
      expect(entrantService.findByCredential(apiToken)).toEqual({ entrantId, userId: userId[0]! });
      expect(entrantService.hasActiveCredential(entrantId)).toBe(true);

      // 策略版本（含 publicVisible 布尔）与草稿
      const versions = strategyService.listVersions(entrantId);
      expect(versions.map((v) => [v.versionId, v.publicVisible])).toEqual([
        [1, false],
        [2, true],
      ]);
      expect(strategyService.getVersion(entrantId, 2)?.source).toContain('me.fire(); me.fire()');
      expect(strategyService.getDraft(entrantId)?.source).toBe('draft source');

      db.close();
    }
  });

  it('恢复码重置后旧会话失效、新密码跨重开仍可用', () => {
    const path = tempDbPath();

    let username: string;
    let oldSession: string;
    let recoveryCode: string;
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      userService.addInviteCode('RESET-CODE');
      const registered = userService.register('RESET-CODE', 'reset_user', 'pass-123');
      expect(registered).not.toBeNull();
      expect(registered).not.toBe('taken');
      if (!registered || registered === 'taken') throw new Error('注册失败');
      username = registered.username;
      recoveryCode = registered.recoveryCode;
      const login = userService.login('reset_user', 'pass-123');
      expect(login).not.toBeNull();
      oldSession = login ? login.token : '';
      db.close();
    }

    // 重开后用恢复码重置（证明恢复码哈希持久化）。
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      const reset = userService.resetPasswordByRecoveryCode(username, recoveryCode, 'brand-new-456');
      expect(reset).toBe(true);
      // 旧会话已吊销
      expect(userService.findBySessionToken(oldSession)).toBeNull();
      // 新密码可登录
      const reLogin = userService.login('reset_user', 'brand-new-456');
      expect(reLogin).not.toBeNull();
      // 旧恢复码不可复用
      const reuse = userService.resetPasswordByRecoveryCode(username, recoveryCode, 'again-789');
      expect(reuse).toBe(false);
      db.close();
    }

    // 再次重开：新密码仍可登录。
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      const login = userService.login('reset_user', 'brand-new-456');
      expect(login).not.toBeNull();
      db.close();
    }
  });

  it('封禁状态与 API 令牌吊销跨重开保留', () => {
    const path = tempDbPath();

    let userId: string;
    let entrantId: string;
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      const entrantService = new EntrantService(db);
      userService.addInviteCode('BAN-CODE');
      const registered = userService.register('BAN-CODE', 'ban_user', 'pass-123');
      expect(registered).not.toBeNull();
      expect(registered).not.toBe('taken');
      if (!registered || registered === 'taken') throw new Error('注册失败');
      userId = registered.userId;
      const entrant = entrantService.createEntrant(userId, {
        gameId: 'tank',
        name: '将被封禁主的对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装' },
      });
      entrantId = entrant.id;
      entrantService.issueEntrantCredential(entrantId);
      db.close();
    }

    // 重开后：封禁用户、吊销 API 令牌。
    {
      const db = initDatabase(path);
      const userService = new UserService(db);
      const entrantService = new EntrantService(db);
      const banned = userService.setBanned(userId, true);
      expect(banned).toBe(true);
      expect(entrantService.revokeEntrantCredentials(entrantId)).toBeUndefined();
      db.close();
    }

    // 再次重开：封禁与吊销仍然生效。
    {
      const db: SQLiteDatabase = initDatabase(path);
      const userService = new UserService(db);
      const entrantService = new EntrantService(db);
      const login = userService.login('ban_user', 'pass-123');
      expect(login).toBeNull(); // 封禁者不能登录
      expect(entrantService.hasActiveCredential(entrantId)).toBe(false);
      db.close();
    }
  });

  it('对局记录（含 frames/result JSON）与 Elo 从 matches 表重建', () => {
    const path = tempDbPath();

    // 写入一场已结束的 official 对局。
    {
      const db = initDatabase(path);
      const store = new SQLiteMatchStore(db);
      const record = store.create({
        matchId: 'm-persist',
        gameId: 'tank',
        gameVersionId: 'tank@v1',
        entrants: [
          { entrantId: 'eA', strategyVersionId: '1' },
          { entrantId: 'eB', strategyVersionId: '1' },
        ],
        kind: 'official',
      });
      store.updateFrame(record.matchId, { tick: 1, state: { hp: [100, 80] } });
      store.updateFrame(record.matchId, { tick: 2, state: { hp: [100, 0] } });
      store.finish(
        record.matchId,
        { outcome: { kind: 'win', winner: 0, reason: 'ko' }, failures: [] },
        'finished',
      );
      db.close();
    }

    // 重开：对局完整可读；RankingService.rebuild 从 matches 表重算 Elo。
    {
      const db = initDatabase(path);
      const store = new SQLiteMatchStore(db);
      const record = store.get('m-persist');
      expect(record).toMatchObject({
        matchId: 'm-persist',
        gameId: 'tank',
        phase: 'finished',
        result: { outcome: { kind: 'win', winner: 0, reason: 'ko' } },
      });
      expect(record!.frames.map((f) => f.tick)).toEqual([1, 2]);

      const summary = store.list({ gameId: 'tank' });
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({ matchId: 'm-persist', frameCount: 2 });

      const ranking = new RankingService({
        matchStore: store,
        rebuildOnStart: true,
        now: () => Date.now(),
      });
      expect(ranking.getScore('tank@v1', 'eA')).toBeCloseTo(1016);
      expect(ranking.getScore('tank@v1', 'eB')).toBeCloseTo(984);
      expect(ranking.getLeaderboard('tank@v1').map((e) => e.entrantId)).toEqual(['eA', 'eB']);
      db.close();
    }
  });
});
