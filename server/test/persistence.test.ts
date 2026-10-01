/**
 * SQLite 持久化集成测试：写入数据 → 关闭 db → 重新打开 → 数据仍在。
 * 覆盖：工作台/邀请码/凭证、参赛对象/对象凭证、策略版本、对局记录、Elo 重建。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/database.js';
import { WorkspaceService } from '../src/services/workspace-service.js';
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
  it('工作台/邀请码/凭证/参赛对象/策略版本持久化', () => {
    const path = tempDbPath();

    // 第一次打开：写入完整业务数据。
    let workspaceId: string;
    let entrantId: string;
    let credential: string;
    let entrantToken: string;
    {
      const db = initDatabase(path);
      const entrantService = new EntrantService(db);
      const workspaceService = new WorkspaceService(db, {
        onWorkspaceReset: (id) => entrantService.revokeAllForWorkspace(id),
      });
      const strategyService = new StrategyService(db);

      workspaceService.addInviteCode('PERSIST-CODE');
      const bundle = workspaceService.createWorkspace('PERSIST-CODE', '持久化工作台');
      expect(bundle).not.toBeNull();
      workspaceId = bundle!.workspaceId;
      credential = bundle!.credential;

      const entrant = entrantService.createEntrant(workspaceId, {
        gameId: 'tank',
        name: '持久化对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装', customImageUrl: 'https://x/y.png' },
      });
      entrantId = entrant.id;
      entrantToken = entrantService.issueEntrantCredential(entrantId)!;
      expect(entrantToken).toBeTruthy();

      strategyService.publish(entrantId, 'function onIdle(me){ me.fire(); }');
      strategyService.publish(entrantId, 'function onIdle(me){ me.fire(); me.fire(); }', true);
      strategyService.saveDraft(entrantId, 'draft source');

      db.close();
    }

    // 重新打开：所有数据仍在，凭证可认证。
    {
      const db = initDatabase(path);
      const entrantService = new EntrantService(db);
      const workspaceService = new WorkspaceService(db);
      const strategyService = new StrategyService(db);

      // 工作台与统计
      expect(workspaceService.stats()).toEqual({
        workspaces: 1,
        pendingInviteCodes: 0,
        consumedInviteCodes: 1,
      });
      const ws = workspaceService.get(workspaceId);
      expect(ws).toMatchObject({ id: workspaceId, nickname: '持久化工作台', recoveryUsed: false });

      // 工作台凭证可定位工作台（哈希持久化在 credentials 表）
      expect(workspaceService.findByCredential(credential)?.id).toBe(workspaceId);

      // 参赛对象与外观（JSON 字段）
      const entrants = entrantService.listByWorkspace(workspaceId);
      expect(entrants).toHaveLength(1);
      expect(entrants[0]).toMatchObject({
        id: entrantId,
        gameId: 'tank',
        name: '持久化对象',
        appearance: { preset: 'heavy', color: '#123456', name: '重装', customImageUrl: 'https://x/y.png' },
      });

      // 对象凭证仍可认证
      expect(entrantService.findByCredential(entrantToken)).toEqual({ entrantId, workspaceId });
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

  it('恢复码重置后旧凭证失效、新凭证跨重开仍可用', () => {
    const path = tempDbPath();

    let workspaceId: string;
    let oldCredential: string;
    let recoveryCode: string;
    {
      const db = initDatabase(path);
      const workspaceService = new WorkspaceService(db);
      workspaceService.addInviteCode('RESET-CODE');
      const bundle = workspaceService.createWorkspace('RESET-CODE')!;
      workspaceId = bundle.workspaceId;
      oldCredential = bundle.credential;
      recoveryCode = bundle.recoveryCode;
      db.close();
    }

    // 重开后用恢复码重置（证明恢复码哈希持久化）。
    let newCredential: string;
    {
      const db = initDatabase(path);
      const workspaceService = new WorkspaceService(db);
      const renewed = workspaceService.resetCredential(workspaceId, recoveryCode);
      expect(renewed).not.toBeNull();
      newCredential = renewed!.credential;
      expect(workspaceService.findByCredential(oldCredential)).toBeNull();
      // 旧恢复码不可复用
      expect(workspaceService.resetCredential(workspaceId, recoveryCode)).toBeNull();
      db.close();
    }

    // 再次重开：新凭证仍可用。
    {
      const db = initDatabase(path);
      const workspaceService = new WorkspaceService(db);
      expect(workspaceService.findByCredential(newCredential)?.id).toBe(workspaceId);
      expect(workspaceService.get(workspaceId)?.recoveryUsed).toBe(true);
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
