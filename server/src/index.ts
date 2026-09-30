/**
 * 服务启动入口：组装依赖（沙箱/游戏包/引擎/服务/API）并 listen。
 *
 * 环境变量：
 * - PORT（默认 3000）
 * - ADMIN_KEY（管理路由密钥，必须设置）
 * - SEED_INVITE_CODE（可选：启动时预置一个邀请码，方便首次体验）
 */

import { buildApp } from './app.js';
import { QuickJsSandboxFactory } from './engine/quickjs-sandbox.js';
import { InMemoryMatchStore } from './engine/match-store.js';
import { LiveHub } from './engine/live-hub.js';
import { MatchRunner } from './engine/match-runner.js';
import { Scheduler } from './engine/scheduler.js';
import { MatchOrchestrator } from './engine/match-orchestrator.js';
import { WorkspaceService } from './services/workspace-service.js';
import { EntrantService } from './services/entrant-service.js';
import { StrategyService } from './services/strategy-service.js';
import { RankingService } from './services/ranking-service.js';
import { tankGamePackage } from './games/tank/tank-game.js';
import { gomokuGamePackage } from './games/gomoku/gomoku-game.js';
import type { GameDefinition } from './games/contracts.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error('必须设置 ADMIN_KEY 环境变量（管理路由密钥）');
    process.exit(1);
  }

  // 游戏注册表：新游戏在此导入注册（后台动态导入属后续版本，ADR 0001）。
  const gamePackages = new Map([
    ['tank', tankGamePackage],
    ['gomoku', gomokuGamePackage],
  ]);
  const games = new Map<string, GameDefinition>(
    [...gamePackages.entries()].map(([id, pkg]) => [id, pkg.definition]),
  );

  // 服务层（内存实现，接口按可替换存储设计）。
  const workspaceService = new WorkspaceService();
  const entrantService = new EntrantService();
  const strategyService = new StrategyService();
  const rankingService = new RankingService({
    getWorkspaceId: (entrantId) => entrantService.get(entrantId)?.workspaceId ?? null,
  });

  if (process.env.SEED_INVITE_CODE) {
    workspaceService.addInviteCode(process.env.SEED_INVITE_CODE);
  }

  // 引擎层。
  const store = new InMemoryMatchStore();
  const liveHub = new LiveHub();
  const runner = new MatchRunner({
    games: gamePackages,
    sandboxes: new QuickJsSandboxFactory(),
    store,
    liveHub,
  });
  const scheduler = new Scheduler(); // 默认 20 并发、单工作台 2（ADR 0003）。
  const orchestrator = new MatchOrchestrator({
    games: gamePackages,
    entrantService,
    strategyService,
    rankingService,
    runner,
    store,
    scheduler,
  });

  const app = await buildApp({
    workspaceService,
    entrantService,
    strategyService,
    rankingService,
    games,
    getMatch: (id) => store.get(id),
    listMatches: (gameId) => store.list(gameId ? { gameId } : undefined),
    liveHub,
    orchestrator,
    adminKey,
  });

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`aivsai server listening on http://0.0.0.0:${port}`);
  console.log(`已注册游戏: ${[...games.values()].map((g) => g.name).join('、')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
