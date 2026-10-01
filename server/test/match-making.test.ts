/**
 * 对战发起规则测试（ADR：训练指定对手 / 正式随机匹配）。
 *
 * 被测接缝：HTTP 层 POST /api/matches。
 * 规则：
 * - official：忽略调用方传入的对手，改为随机匹配积分（±50）相近者；无对手 → 409。
 * - training：可粘贴任意坦克 ID（有已发布策略），或选内置 bot；不能打自己工作台的对象。
 *
 * 每个用例独立建库（fresh in-memory），避免用例间积分/工作台互相污染；
 * 不依赖任何只有测试才用的生产代码入口。
 */

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { initDatabase } from '../src/db/database.js';
import { QuickJsSandboxFactory } from '../src/engine/quickjs-sandbox.js';
import { SQLiteMatchStore } from '../src/engine/match-store.js';
import { LiveHub } from '../src/engine/live-hub.js';
import { MatchRunner } from '../src/engine/match-runner.js';
import { Scheduler } from '../src/engine/scheduler.js';
import { MatchOrchestrator } from '../src/engine/match-orchestrator.js';
import { WorkspaceService } from '../src/services/workspace-service.js';
import { EntrantService } from '../src/services/entrant-service.js';
import { StrategyService } from '../src/services/strategy-service.js';
import { RankingService } from '../src/services/ranking-service.js';
import { tankGamePackage } from '../src/games/tank/tank-game.js';
import { tankBots } from '../src/games/tank/bots.js';
import type { GameDefinition } from '../src/games/contracts.js';

/** 静止开火策略（能跑完对局）。 */
const SIMPLE_STRATEGY = `
function onIdle(me, enemy, game) {
  if (me.cooldown === 0 && me.bullet === null) me.fire();
}
`;

/** 崩溃策略：立即抛错 → 被判负。用于让正式对局强制分出胜负。 */
const BROKEN_STRATEGY = `
function onIdle(me, enemy, game) {
  throw new Error('boom');
}
`;

interface TestApp {
  app: {
    inject: (opts: {
      method: string;
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }) => Promise<{ statusCode: number; json(): unknown; body: string }>;
  };
  /** 暴露给测试：用 seedScore() 构造分差超过匹配窗口的场景。 */
  rankingService: RankingService;
  /** 暴露给测试：用注入的随机源验证匹配选取（StartMatchInput.random）。 */
  orchestrator: MatchOrchestrator;
  /** 暴露给测试：查参赛对象归属的 workspaceId。 */
  entrantService: EntrantService;
  /** 新建一个带已发布策略的坦克（默认各自独立工作台）。 */
  createTank: (
    source?: string,
    nickname?: string,
  ) => Promise<{ credential: string; entrantId: string }>;
  /** 在同一工作台下再建一个坦克。 */
  addTankToWorkspace: (
    credential: string,
    source: string,
    name: string,
  ) => Promise<string>;
  /** 只建坦克不发布策略。 */
  createTankWithoutStrategy: (nickname: string) => Promise<string>;
  waitFinished: (matchId: string) => Promise<string>;
}

async function setup(): Promise<TestApp> {
  const gamePackages = new Map([['tank', tankGamePackage]]);
  const games = new Map<string, GameDefinition>(
    [...gamePackages.entries()].map(([id, pkg]) => [id, pkg.definition]),
  );
  const db = initDatabase(':memory:');
  const entrantService = new EntrantService(db);
  const workspaceService = new WorkspaceService(db);
  const strategyService = new StrategyService(db);
  const rankingService = new RankingService({
    getWorkspaceId: (id) => entrantService.get(id)?.workspaceId ?? null,
  });
  const store = new SQLiteMatchStore(db);
  const liveHub = new LiveHub();
  const runner = new MatchRunner({
    games: gamePackages,
    sandboxes: new QuickJsSandboxFactory(),
    store,
    liveHub,
    officialTickDelayMs: 0,
  });
  const scheduler = new Scheduler({ pollMs: 0 });
  const orchestrator = new MatchOrchestrator({
    games: gamePackages,
    entrantService,
    strategyService,
    rankingService,
    runner,
    store,
    scheduler,
    bots: tankBots,
  });
  const app = (await buildApp({
    workspaceService,
    entrantService,
    strategyService,
    rankingService,
    games,
    getMatch: (id) => store.get(id),
    listMatches: (filter) => store.list(filter),
    countMatches: (gameId) => store.count(gameId),
    liveHub,
    orchestrator,
    adminKey: 'test-admin',
  })) as unknown as TestApp['app'];

  let seq = 0;

  const redeemWorkspace = async (nickname: string): Promise<string> => {
    seq += 1;
    const code = `CODE-${seq}`;
    workspaceService.addInviteCode(code);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces/redeem',
      payload: { inviteCode: code, nickname },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { credential: string }).credential;
  };

  const createEntrant = async (credential: string, name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/entrants',
      payload: {
        gameId: 'tank',
        name,
        appearance: { preset: 'basic', color: '#3366cc', name },
      },
      headers: auth(credential),
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };

  const publish = async (credential: string, entrantId: string, source: string): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/entrants/${entrantId}/strategies/publish`,
      payload: { source },
      headers: auth(credential),
    });
    expect(res.statusCode).toBe(200);
  };

  const createTank = async (
    source: string = SIMPLE_STRATEGY,
    nickname = `tank-${seq + 1}`,
  ): Promise<{ credential: string; entrantId: string }> => {
    const credential = await redeemWorkspace(nickname);
    const entrantId = await createEntrant(credential, nickname);
    await publish(credential, entrantId, source);
    return { credential, entrantId };
  };

  return {
    app,
    rankingService,
    orchestrator,
    entrantService,
    createTank,
    addTankToWorkspace: async (credential, source, name) => {
      const id = await createEntrant(credential, name);
      await publish(credential, id, source);
      return id;
    },
    createTankWithoutStrategy: async (nickname) => {
      const credential = await redeemWorkspace(nickname);
      return createEntrant(credential, nickname);
    },
    waitFinished: async (matchId) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const res = await app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
        const summary = res.json() as { phase: string };
        if (summary.phase === 'finished' || summary.phase === 'invalid') return summary.phase;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('等待对局结束超时');
    },
  };
}

const auth = (credential: string) => ({ authorization: `Bearer ${credential}` });

describe('训练：可指定对手', () => {
  it('粘贴任意坦克 ID 即可发起训练（跨工作台）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'trainer-a');
    const opponent = await t.createTank(SIMPLE_STRATEGY, 'target-b');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentEntrantId: opponent.entrantId,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };

    const summary = await t.app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    const record = summary.json() as { entrants: Array<{ entrantId: string }> };
    expect(record.entrants[1]?.entrantId).toBe(opponent.entrantId);

    expect(await t.waitFinished(matchId)).toBe('finished');
  });

  it('训练对手无已发布策略 → 400', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'trainer-c');
    const emptyId = await t.createTankWithoutStrategy('no-strategy');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentEntrantId: emptyId,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
    expect((started.json() as { error: string }).error).toContain('已发布策略');
  });

  it('训练不能挑战自己工作台的另一个坦克', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'self-owner');
    const sibling = await t.addTankToWorkspace(me.credential, SIMPLE_STRATEGY, 'sibling');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentEntrantId: sibling,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
    expect((started.json() as { error: string }).error).toContain('自己工作台');
  });

  it('训练对手填自己 → 400', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'self-fight');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentEntrantId: me.entrantId,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
    expect((started.json() as { error: string }).error).toContain('自己对战');
  });

  it('训练不指定对手 → 400', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'trainer-d');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'training', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
  });

  it('训练仍可用内置 bot', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'trainer-e');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);
  });
});

describe('正式：只能随机匹配', () => {
  it('传入对手 ID → 400（不能自选对手）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'official-a');
    const other = await t.createTank(SIMPLE_STRATEGY, 'official-b');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'official',
        myEntrantId: me.entrantId,
        opponentEntrantId: other.entrantId,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
    expect((started.json() as { error: string }).error).toContain('随机匹配');
  });

  it('传入 bot → 400（不能自选对手）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'official-c');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'official',
        myEntrantId: me.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
  });

  it('同时传 bot 和坦克 ID → 400', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'official-both');
    const other = await t.createTank(SIMPLE_STRATEGY, 'official-both-b');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'official',
        myEntrantId: me.entrantId,
        opponentBotId: 'standard-01',
        opponentEntrantId: other.entrantId,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(400);
  });

  it('传非字符串对手值 → 400（不能被静默当作未传）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'official-typed');
    await t.createTank(SIMPLE_STRATEGY, 'official-typed-b');

    // Agent 可能误传数字 / null 以外的对象；若被当作“未传”会被静默放行成随机匹配。
    for (const bad of [123, true, {}, []]) {
      const started = await t.app.inject({
        method: 'POST',
        url: '/api/matches',
        payload: {
          gameId: 'tank',
          kind: 'official',
          myEntrantId: me.entrantId,
          opponentEntrantId: bad,
        },
        headers: auth(me.credential),
      });
      expect(started.statusCode).toBe(400);
    }
  });

  it('没有积分相近的对手 → 409 提示稍后再试', async () => {
    const t = await setup();
    // 库里只有自己一个坦克 → 匹配池为空
    const me = await t.createTank(SIMPLE_STRATEGY, 'lonely');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(409);
    expect((started.json() as { error: string }).error).toContain('稍后再试');
  });

  it('唯一的对手是无策略坦克 → 409（不能拿没策略的当对手）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'official-e');
    await t.createTankWithoutStrategy('silent');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(409);
  });

  it('不会匹配到自己工作台的另一个坦克', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'official-f');
    // 同工作台的另一个坦克（分差 0，若规则失效必被选中）
    await t.addTankToWorkspace(me.credential, SIMPLE_STRATEGY, 'my-sibling');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(409);
  });

  it('分差超过 ±50 的对手被排除 → 409', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'window-me');
    const far = await t.createTank(SIMPLE_STRATEGY, 'window-far');
    // 把对手积分调到 1000+60=1060，与我方（1000）分差 60 > 50
    t.rankingService.seedScore('tank', far.entrantId, 1060);

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(409);
    expect((started.json() as { error: string }).error).toContain('稍后再试');
  });

  it('分差恰好在 ±50 内的对手可以匹配成功', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'window-me2');
    const near = await t.createTank(BROKEN_STRATEGY, 'window-near');
    // 把对手积分调到 1000-50=950，与我方（1000）分差恰好 50
    t.rankingService.seedScore('tank', near.entrantId, 950);

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };
    const summary = await t.app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    const record = summary.json() as { entrants: Array<{ entrantId: string }> };
    expect(record.entrants[1]!.entrantId).toBe(near.entrantId);
  });

  it('有相近对手时随机匹配成功，且对手不是自己、不是 bot', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'matcher-a');
    const near = await t.createTank(BROKEN_STRATEGY, 'matcher-near');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };

    const summary = await t.app.inject({ method: 'GET', url: `/api/matches/${matchId}` });
    const record = summary.json() as { entrants: Array<{ entrantId: string }> };
    const opponentId = record.entrants[1]!.entrantId;
    expect(opponentId).toBe(near.entrantId);
    expect(opponentId.startsWith('bot:')).toBe(false);
  });

  it('正式随机匹配的对局计入排行榜', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'ranker-a');
    await t.createTank(BROKEN_STRATEGY, 'ranker-victim');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: { gameId: 'tank', kind: 'official', myEntrantId: me.entrantId },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);
    const { matchId } = started.json() as { matchId: string };
    await t.waitFinished(matchId);

    const board = await t.app.inject({ method: 'GET', url: '/api/leaderboard/tank' });
    const entries = (
      board.json() as { entries: Array<{ entrantId: string; score: number }> }
    ).entries;
    const mine = entries.find((e) => e.entrantId === me.entrantId);
    expect(mine).toBeTruthy();
    // 赢了崩溃策略 → 分数上升（初始 1000，K=32）
    expect(mine!.score).toBeGreaterThan(1000);
  }, 30_000);

  it('注入随机源验证匹配选取（StartMatchInput.random 不是死接缝）', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'inj-me');
    const c1 = await t.createTank(BROKEN_STRATEGY, 'inj-c1');
    const c2 = await t.createTank(BROKEN_STRATEGY, 'inj-c2');
    // orchestrator 会校验 workspaceId 归属，取发起方的真实 workspaceId
    const myWorkspaceId = t.entrantService.get(me.entrantId)!.workspaceId;

    // 候选按 listAll 顺序排列；注入 random=0 → 取第一个，random≈1 → 取最后一个。
    const startWith = async (random: () => number) =>
      t.orchestrator.start({
        gameId: 'tank',
        kind: 'official',
        myEntrantId: me.entrantId,
        workspaceId: myWorkspaceId,
        random,
      });

    const first = await startWith(() => 0);
    const last = await startWith(() => 0.9999999);
    expect(first.ok).toBe(true);
    expect(last.ok).toBe(true);
    // 两次选中的对手不同，证明随机源真的驱动了选取
    if (first.ok && last.ok) {
      const m1 = await t.app.inject({ method: 'GET', url: `/api/matches/${first.matchId}` });
      const m2 = await t.app.inject({ method: 'GET', url: `/api/matches/${last.matchId}` });
      const opp1 = (m1.json() as { entrants: Array<{ entrantId: string }> }).entrants[1]!.entrantId;
      const opp2 = (m2.json() as { entrants: Array<{ entrantId: string }> }).entrants[1]!.entrantId;
      expect([c1.entrantId, c2.entrantId]).toContain(opp1);
      expect([c1.entrantId, c2.entrantId]).toContain(opp2);
      expect(opp1).not.toBe(opp2);
    }
    // 越界注入源（>1）不崩溃，被夹回最后一个
    const over = await startWith(() => 1.5);
    expect(over.ok).toBe(true);
  }, 30_000);
});

describe('对局列表：坦克名字与分页', () => {
  it('列表条目带双方坦克名字，说明谁打谁', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'name-me');
    const opponent = await t.createTank(BROKEN_STRATEGY, 'name-rival');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentEntrantId: opponent.entrantId,
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);

    const list = await t.app.inject({ method: 'GET', url: '/api/matches?gameId=tank' });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      matches: Array<{ entrants: Array<{ entrantId: string; name: string | null }> }>;
    };
    expect(body.matches.length).toBe(1);
    const e = body.matches[0]!.entrants;
    expect(e[0]!.entrantId).toBe(me.entrantId);
    expect(e[0]!.name).toBe('name-me');
    expect(e[1]!.entrantId).toBe(opponent.entrantId);
    expect(e[1]!.name).toBe('name-rival');
  });

  it('与 bot 的训练对局：bot 一侧显示内置基准名', async () => {
    const t = await setup();
    const me = await t.createTank(SIMPLE_STRATEGY, 'bot-match-me');

    const started = await t.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        gameId: 'tank',
        kind: 'training',
        myEntrantId: me.entrantId,
        opponentBotId: 'standard-01',
      },
      headers: auth(me.credential),
    });
    expect(started.statusCode).toBe(202);

    const list = await t.app.inject({ method: 'GET', url: '/api/matches' });
    const body = list.json() as {
      matches: Array<{ entrants: Array<{ entrantId: string; name: string | null }> }>;
    };
    const e = body.matches[0]!.entrants;
    expect(e[1]!.entrantId.startsWith('bot:')).toBe(true);
    expect(e[1]!.name).toContain('Standard-01');
    expect(e[1]!.name).toContain('内置基准');
  });

  it('分页：pageSize 生效、page 翻页不重不漏、total 正确、最新在前', async () => {
    const t = await setup();
    // 打 5 场训练对局（对手只有一个，避免随机匹配的不确定性）
    const me = await t.createTank(SIMPLE_STRATEGY, 'pager-me');
    const rival = await t.createTank(BROKEN_STRATEGY, 'pager-rival');
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = await t.app.inject({
        method: 'POST',
        url: '/api/matches',
        payload: {
          gameId: 'tank',
          kind: 'training',
          myEntrantId: me.entrantId,
          opponentEntrantId: rival.entrantId,
        },
        headers: auth(me.credential),
      });
      expect(started.statusCode).toBe(202);
      ids.push((started.json() as { matchId: string }).matchId);
    }

    // 第 1 页 2 条
    const p1 = (
      await t.app.inject({ method: 'GET', url: '/api/matches?gameId=tank&page=1&pageSize=2' })
    ).json() as {
      matches: Array<{ matchId: string }>;
      page: number;
      pageSize: number;
      total: number;
    };
    expect(p1.matches).toHaveLength(2);
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(2);
    expect(p1.total).toBe(5);

    // 第 3 页只剩 1 条；第 2 页补齐中间 2 条
    const p2 = (
      await t.app.inject({ method: 'GET', url: '/api/matches?gameId=tank&page=2&pageSize=2' })
    ).json() as { matches: Array<{ matchId: string }> };
    const p3 = (
      await t.app.inject({ method: 'GET', url: '/api/matches?gameId=tank&page=3&pageSize=2' })
    ).json() as { matches: Array<{ matchId: string }> };
    expect(p2.matches).toHaveLength(2);
    expect(p3.matches).toHaveLength(1);

    // 跨页拼接 = 全量（不重不漏），顺序与全量一致
    const all = (
      await t.app.inject({ method: 'GET', url: '/api/matches?gameId=tank&pageSize=100' })
    ).json() as { matches: Array<{ matchId: string }> };
    const paged = [...p1.matches, ...p2.matches, ...p3.matches].map((m) => m.matchId);
    expect(paged).toEqual(all.matches.map((m) => m.matchId));
    // 最新在前：最后创建的排最上面
    expect(all.matches[0]!.matchId).toBe(ids[ids.length - 1]);

    // 非法分页参数回退默认值：pageSize=abc → 默认 20；page=0 → 1
    const bad = (
      await t.app.inject({ method: 'GET', url: '/api/matches?gameId=tank&pageSize=abc&page=0' })
    ).json() as { page: number; pageSize: number };
    expect(bad.pageSize).toBe(20);
    expect(bad.page).toBe(1);
  }, 60_000);
});
