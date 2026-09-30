/**
 * HTTP API 组装：公开路由、凭证路由与管理路由（ADR 0002 / 0004）。
 *
 * - 数据全部内存（services 持有 Map），接口留好后续换 DB。
 * - 错误统一 JSON { error }，不泄露内部细节。
 * - app 不 listen，测试使用 fastify.inject。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { WorkspaceService } from './services/workspace-service.js';
import type { EntrantService, EntrantQuotaExceededError } from './services/entrant-service.js';
import type { StrategyService } from './services/strategy-service.js';
import type { RankingService } from './services/ranking-service.js';
import { makeAuthPlugin, requirePrincipal, requireAdmin, type AuthPrincipal } from './services/credential-auth.js';
import type { GameDefinition } from './games/contracts.js';
import type { MatchRecord } from './engine/match-contracts.js';
import type { LiveHub } from './engine/live-hub.js';
import type { MatchOrchestrator } from './engine/match-orchestrator.js';

/** 注册的游戏集合（id -> GameDefinition），由后台导入。 */
export type GameRegistry = Map<string, GameDefinition>;

export interface AppDeps {
  workspaceService: WorkspaceService;
  entrantService: EntrantService;
  strategyService: StrategyService;
  rankingService: RankingService;
  /** 已注册游戏（注入，从 games Map 读取）。 */
  games: GameRegistry;
  /** 已有对局记录查询（由 MatchStore 支撑）；不提供时路由返回 404。 */
  getMatch?: (id: string) => MatchRecord | undefined;
  /** 对局列表（按游戏过滤，可选）。 */
  listMatches?: (gameId?: string) => unknown[];
  /** 游戏版本归属：gameVersionId -> gameId（排行榜与摘要路由用）。 */
  gameVersions?: Map<string, string>;
  /** 参赛对象 -> 工作台（用于排行榜归属与对象鉴权）。 */
  entrantWorkspace?: (entrantId: string) => string | null;
  /** 直播帧分发（观看帧流/回放帧）。 */
  liveHub?: LiveHub;
  /** 对局编排（创建 official/training 对局）。 */
  orchestrator?: MatchOrchestrator;
  adminKey?: string;
}

/** 对局摘要：不含私密诊断与源码（ADR 0002）。 */
function matchSummary(record: MatchRecord) {
  return {
    matchId: record.matchId,
    gameId: record.gameId,
    gameVersionId: record.gameVersionId,
    entrants: record.entrants.map((e) => ({ entrantId: e.entrantId })),
    kind: record.kind,
    createdAt: record.createdAt,
    phase: record.phase,
    result: record.result
      ? {
          outcome:
            record.result.outcome.kind === 'invalid'
              ? { kind: 'invalid' }
              : record.result.outcome,
        }
      : null,
  };
}

/** 当前请求可管理的 workspaceId 集合；不属于则返回 null（对象凭证只能管自己）。 */
function resolveWorkspaceId(auth: AuthPrincipal | null): string | null {
  if (!auth) return null;
  if (auth.kind === 'workspace') return auth.workspaceId;
  if (auth.kind === 'entrant') return auth.workspaceId;
  return null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const games = deps.games;
  const getMatch = deps.getMatch ?? (() => undefined);
  const listMatches = deps.listMatches ?? (() => []);
  const gameVersions = deps.gameVersions ?? new Map<string, string>();
  const gameVersionOf = (gameVersionId: string) => gameVersions.get(gameVersionId);

  // 直接在根作用域应用认证插件（decorate + onRequest 解析），避免 encapsulation
  // 导致根路由读不到 request.auth。
  await makeAuthPlugin({
    workspaceService: deps.workspaceService,
    entrantService: deps.entrantService,
    adminKey: deps.adminKey,
  })(app);

  const requireAuth = requirePrincipal();
  const adminOnly = requireAdmin({
    workspaceService: deps.workspaceService,
    entrantService: deps.entrantService,
    adminKey: deps.adminKey,
  });

  // ---- 公开路由（无需认证） ----

  app.get('/api/games', async () => {
    return {
      games: [...games.values()].map((g) => ({ id: g.id, name: g.name, pacing: g.pacing })),
    };
  });

  app.get<{ Params: { gameId: string } }>(
    '/api/leaderboard/:gameId',
    async (request, reply) => {
      const { gameId } = request.params;
      if (!games.has(gameId)) {
        return reply.code(404).send({ error: '游戏不存在' });
      }
      // 首版每个游戏一个当前版本；多版本排名在游戏版本注册后按 versionId 分别查询。
      const versionIds = [...gameVersions.entries()]
        .filter(([, gid]) => gid === gameId)
        .map(([vid]) => vid);
      const versionId = versionIds[versionIds.length - 1] ?? gameId;
      return { gameVersionId: versionId, entries: deps.rankingService.getLeaderboard(versionId) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (request, reply) => {
    const record = getMatch(request.params.id);
    if (!record) return reply.code(404).send({ error: '对局不存在' });
    return matchSummary(record);
  });

  app.get<{ Querystring: { gameId?: string } }>('/api/matches', async (request) => {
    return { matches: listMatches(typeof request.query.gameId === 'string' ? request.query.gameId : undefined) };
  });

  // ---- 兑换与恢复（用请求体中的邀请码/恢复码，无需既有凭证） ----

  app.post<{ Body: { inviteCode?: unknown; nickname?: unknown } }>(
    '/api/workspaces/redeem',
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const inviteCode = body.inviteCode;
      const nickname = body.nickname;
      if (typeof inviteCode !== 'string' || inviteCode.trim() === '') {
        return reply.code(400).send({ error: '邀请码无效' });
      }
      if (nickname !== undefined && nickname !== null && typeof nickname !== 'string') {
        return reply.code(400).send({ error: '昵称格式无效' });
      }
      const bundle = deps.workspaceService.createWorkspace(
        inviteCode,
        typeof nickname === 'string' ? nickname : undefined,
      );
      if (!bundle) return reply.code(400).send({ error: '邀请码无效' });
      return bundle;
    },
  );

  app.post<{ Params: { id: string }; Body: { recoveryCode?: unknown } }>(
    '/api/workspaces/:id/reset',
    async (request, reply) => {
      const { id } = request.params;
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.recoveryCode !== 'string' || body.recoveryCode === '') {
        return reply.code(400).send({ error: '恢复码无效' });
      }
      const bundle = deps.workspaceService.resetCredential(id, body.recoveryCode);
      if (!bundle) return reply.code(400).send({ error: '恢复码无效' });
      return bundle;
    },
  );

  // ---- 凭证路由（工作台或对象凭证） ----

  app.get('/api/entrants', { preHandler: requireAuth }, async (request) => {
    const workspaceId = resolveWorkspaceId(request.auth);
    const entrants = deps.entrantService.listByWorkspace(workspaceId!);
    return {
      entrants: entrants.map((e) => ({
        id: e.id,
        gameId: e.gameId,
        name: e.name,
        appearance: e.appearance,
        createdAt: e.createdAt,
      })),
    };
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/api/entrants',
    { preHandler: requireAuth },
    async (request, reply) => {
      const workspaceId = resolveWorkspaceId(request.auth);
      const body = request.body ?? {};
      const { gameId, name, appearance } = body;
      if (typeof gameId !== 'string' || !gameId) {
        return reply.code(400).send({ error: 'gameId 无效' });
      }
      if (typeof name !== 'string' || name.trim() === '') {
        return reply.code(400).send({ error: 'name 无效' });
      }
      const appearanceObj = appearance as Record<string, unknown> | undefined;
      if (
        !appearanceObj ||
        typeof appearanceObj.preset !== 'string' ||
        typeof appearanceObj.color !== 'string' ||
        typeof appearanceObj.name !== 'string'
      ) {
        return reply.code(400).send({ error: 'appearance 无效' });
      }
      if (games.size > 0 && !games.has(gameId)) {
        return reply.code(400).send({ error: '游戏不存在' });
      }
      try {
        const entrant = deps.entrantService.createEntrant(workspaceId!, {
          gameId,
          name: name.trim(),
          appearance: {
            preset: appearanceObj.preset,
            color: appearanceObj.color,
            name: appearanceObj.name,
            ...(typeof appearanceObj.customImageUrl === 'string'
              ? { customImageUrl: appearanceObj.customImageUrl }
              : {}),
          },
        });
        return reply.code(201).send({
          id: entrant.id,
          gameId: entrant.gameId,
          name: entrant.name,
          appearance: entrant.appearance,
          createdAt: entrant.createdAt,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'EntrantQuotaExceededError') {
          return reply.code(400).send({ error: '参赛对象配额已满' });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/entrants/:id/strategies/publish',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.get(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      // 对象凭证只能操作自己；工作台凭证可管理本工作台全部对象。
      if (auth.kind === 'entrant' && auth.entrantId !== entrantId) {
        return reply.code(401).send({ error: '无权管理该参赛对象' });
      }
      if (auth.kind === 'workspace' && auth.workspaceId !== entrant.workspaceId) {
        return reply.code(401).send({ error: '无权管理该参赛对象' });
      }
      const body = request.body ?? {};
      if (typeof body.source !== 'string' || body.source.trim() === '') {
        return reply.code(400).send({ error: 'source 无效' });
      }
      const publicVisible = body.publicVisible === true; // 默认 false：源码私密。
      const version = deps.strategyService.publish(entrantId, body.source, publicVisible);
      return {
        entrantId,
        versionId: version.versionId,
        publicVisible: version.publicVisible,
        createdAt: version.createdAt,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/entrants/:id/strategies',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.get(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (auth.kind === 'entrant' && auth.entrantId !== entrantId) {
        return reply.code(401).send({ error: '无权读取该参赛对象的策略' });
      }
      if (auth.kind === 'workspace' && auth.workspaceId !== entrant.workspaceId) {
        return reply.code(401).send({ error: '无权读取该参赛对象的策略' });
      }
      // 持管理者凭证可读全量版本与源码；公开版本的源码读取入口在观战侧另行提供。
      const versions = deps.strategyService.listVersions(entrantId);
      return {
        entrantId,
        versions: versions.map((v) => ({
          versionId: v.versionId,
          publicVisible: v.publicVisible,
          createdAt: v.createdAt,
          source: v.source,
        })),
      };
    },
  );

  // ---- 对局创建与观看 ----

  app.post<{ Body: Record<string, unknown> }>(
    '/api/matches',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!deps.orchestrator) {
        return reply.code(501).send({ error: '引擎未接入' });
      }
      const auth = request.auth!;
      const body = request.body ?? {};
      const { gameId, kind, myEntrantId, opponentEntrantId } = body;
      if (typeof gameId !== 'string' || !gameId) {
        return reply.code(400).send({ error: 'gameId 无效' });
      }
      if (kind !== 'official' && kind !== 'training') {
        return reply.code(400).send({ error: 'kind 必须是 official 或 training' });
      }
      if (typeof myEntrantId !== 'string' || !myEntrantId) {
        return reply.code(400).send({ error: 'myEntrantId 无效' });
      }
      if (typeof opponentEntrantId !== 'string' || !opponentEntrantId) {
        return reply.code(400).send({ error: 'opponentEntrantId 无效' });
      }
      const workspaceId = resolveWorkspaceId(auth);
      const started = await deps.orchestrator.start({
        gameId,
        kind,
        myEntrantId,
        opponentEntrantId,
        workspaceId: workspaceId!,
      });
      if (!started.ok) {
        return reply.code(started.error.status).send({ error: started.error.message });
      }
      const record = getMatch(started.matchId);
      return reply
        .code(202)
        .send({ matchId: started.matchId, summary: record ? matchSummary(record) : null });
    },
  );

  // 直播/回放帧流：fromTick 起的历史帧 + 增量帧（SSE，观众无需凭证，ADR 0002）。
  if (deps.liveHub) {
    const liveHub = deps.liveHub;
    app.get<{ Params: { id: string }; Querystring: { fromTick?: string } }>(
      '/api/matches/:id/frames',
      async (request, reply) => {
        const record = getMatch(request.params.id);
        if (!record) return reply.code(404).send({ error: '对局不存在' });
        // 训练默认私密（ADR 0002）：无凭证访客只能观看 official。
        if (record.kind === 'training') {
          const auth = request.auth;
          const ws = resolveWorkspaceId(auth);
          const allowed =
            ws !== null && record.entrants.some(
              (e) => deps.entrantService.get(e.entrantId)?.workspaceId === ws,
            );
          if (!allowed) return reply.code(403).send({ error: '训练对局不公开' });
        }
        const fromTick = Number(request.query.fromTick ?? 0) || 0;

        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const send = (event: string, data: unknown) => {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const unsub = liveHub.subscribe(
          request.params.id,
          fromTick,
          (frame) => send('frame', frame),
          (result) => {
            send('end', result);
            reply.raw.end();
          },
        );
        request.raw.on('close', () => {
          unsub();
        });
      },
    );
  }

  // ---- 管理路由（ADMIN_KEY Bearer） ----

  // 管理概览：平台计数 + 工作台明细（不含任何凭证/哈希）。
  app.get(
    '/api/admin/stats',
    { preHandler: adminOnly },
    async () => {
      const stats = deps.workspaceService.stats();
      return {
        ...stats,
        strategyVersions: deps.strategyService.countAllVersions(),
        workspaces: deps.workspaceService.listWorkspaces().map((w) => ({
          ...w,
          entrantCount: deps.entrantService.listByWorkspace(w.id).length,
          strategyCount: deps.entrantService
            .listByWorkspace(w.id)
            .reduce((n, e) => n + deps.strategyService.listVersions(e.id).length, 0),
        })),
      };
    },
  );

  // 未兑换邀请码列表（管理视角）。
  app.get(
    '/api/admin/invite-codes',
    { preHandler: adminOnly },
    async () => {
      return { codes: deps.workspaceService.listPendingInviteCodes() };
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/admin/invite-codes',
    { preHandler: adminOnly },
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.code !== 'string' || body.code.trim() === '') {
        return reply.code(400).send({ error: 'code 无效' });
      }
      deps.workspaceService.addInviteCode(body.code.trim());
      return reply.code(201).send({ ok: true });
    },
  );

  // 统一兜底：不泄露内部细节（ADR 0002）。
  app.setErrorHandler((error: Error & { statusCode?: unknown }, _request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? ((error as { statusCode: number }).statusCode)
        : 500;
    if (statusCode >= 500) {
      console.error('[unhandled]', error);
      return reply.code(500).send({ error: '服务器内部错误' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  return app;
}

export { EntrantQuotaExceededError };
