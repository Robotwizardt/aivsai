/**
 * 服务启动入口：组装依赖（数据库/沙箱/游戏包/引擎/服务/API）并 listen。
 *
 * 环境变量：
 * - PORT（默认 3000）
 * - DATABASE_PATH（SQLite 文件路径，默认 ./data/aivsai.db）
 * - ADMIN_USERNAME / ADMIN_PASSWORD（首个管理员账号，必须设置；ADR 0015）
 * - SEED_INVITE_CODE（可选：启动时预置一个邀请码，方便首次体验）
 */

import { buildApp } from './app.js';
import { initDatabase } from './db/database.js';
import { QuickJsSandboxFactory } from './engine/quickjs-sandbox.js';
import { SQLiteMatchStore } from './engine/match-store.js';
import { LiveHub } from './engine/live-hub.js';
import { MatchRunner } from './engine/match-runner.js';
import { Scheduler } from './engine/scheduler.js';
import { MatchOrchestrator } from './engine/match-orchestrator.js';
import { UserService } from './services/user-service.js';
import { EntrantService } from './services/entrant-service.js';
import { StrategyService } from './services/strategy-service.js';
import { RankingService } from './services/ranking-service.js';
import { AgentApiService } from './services/agent-api-service.js';
import { tankGamePackage } from './games/tank/tank-game.js';
import { tankBots } from './games/tank/bots.js';
import { gomokuGamePackage } from './games/gomoku/gomoku-game.js';
import type { GameDefinition } from './games/contracts.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const adminUsername = process.env.ADMIN_USERNAME?.trim();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    console.error('必须设置 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量（首个管理员账号，ADR 0015）');
    process.exit(1);
  }

  // SQLite 持久化（WAL 模式）。
  const db = initDatabase(process.env.DATABASE_PATH || './data/aivsai.db');

  // 游戏注册表：新游戏在此导入注册（后台动态导入属后续版本，ADR 0001）。
  const gamePackages = new Map([
    ['tank', tankGamePackage],
    ['gomoku', gomokuGamePackage],
  ]);
  const games = new Map<string, GameDefinition>(
    [...gamePackages.entries()].map(([id, pkg]) => [id, pkg.definition]),
  );

  // 服务层（SQLite 持久化）。
  const userService = new UserService(db);
  const entrantService = new EntrantService(db);
  const strategyService = new StrategyService(db);
  const store = new SQLiteMatchStore(db);
  const rankingService = new RankingService({
    getUserId: (entrantId) => entrantService.get(entrantId)?.userId ?? null,
    // 已删除（归档）的参赛对象不计分、不上榜；查不到的对象（如 bot）视为在役。
    isEntrantActive: (entrantId) => {
      const entrant = entrantService.get(entrantId);
      return entrant === null || entrant.archivedAt === null;
    },
    matchStore: store,
    rebuildOnStart: true, // 重启后从 matches 表重算积分
  });

  // 首个管理员（ADR 0015：环境变量注入、幂等，取代旧 ADMIN_KEY）。
  if (!userService.seedAdmin(adminUsername, adminPassword)) {
    console.error('管理员账号初始化失败');
    process.exit(1);
  }
  if (process.env.SEED_INVITE_CODE) {
    userService.addInviteCode(process.env.SEED_INVITE_CODE);
  }

  // 引擎层。
  // getRecord 让 LiveHub 在重启后也能回放持久化的已结束对局（不依赖 runner attach）。
  const liveHub = new LiveHub({ getRecord: (id) => store.get(id) });
  const runner = new MatchRunner({
    games: gamePackages,
    sandboxes: new QuickJsSandboxFactory(),
    store,
    liveHub,
  });
  const scheduler = new Scheduler(); // 默认 20 并发、单用户 2（ADR 0003）。
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
  const agentApi = new AgentApiService({
    sandboxes: new QuickJsSandboxFactory(),
    tankGame: tankGamePackage,
  });

  const app = await buildApp({
    userService,
    entrantService,
    strategyService,
    rankingService,
    games,
    getMatch: (id) => store.get(id),
    listMatches: (filter) => store.list(filter),
    countMatches: (filter) => store.count(filter),
    // 守卫口径只有一处：orchestrator.hasLiveMatch = 已落库的进行中对局 + 已受理还在排队的对局。
    hasLiveMatch: (entrantId) => orchestrator.hasLiveMatch(entrantId),
    liveHub,
    orchestrator,
    agentApi,
  });

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`aivsai server listening on http://0.0.0.0:${port}`);
  console.log(`已注册游戏: ${[...games.values()].map((g) => g.name).join('、')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
