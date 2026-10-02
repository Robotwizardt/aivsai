/**
 * HTTP API 组装：公开路由、凭证路由与管理路由（ADR 0002 / 0004）。
 *
 * - 数据全部内存（services 持有 Map），接口留好后续换 DB。
 * - 错误统一 JSON { error }，不泄露内部细节。
 * - app 不 listen，测试使用 fastify.inject。
 */

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import type { WorkspaceService } from './services/workspace-service.js';
import type { EntrantService, EntrantQuotaExceededError } from './services/entrant-service.js';
import type { StrategyService } from './services/strategy-service.js';
import type { RankingService } from './services/ranking-service.js';
import { makeAuthPlugin, requirePrincipal, requireAdmin, type AuthPrincipal } from './services/credential-auth.js';
import { AgentApiService, MAX_CODE_BYTES } from './services/agent-api-service.js';
import { tankBots } from './games/tank/bots.js';
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
  /** 对局列表（按游戏/类型/参赛对象过滤 + 分页，最新在前）。 */
  listMatches?: (filter?: {
    gameId?: string;
    kind?: 'official' | 'training';
    entrantId?: string;
    limit?: number;
    offset?: number;
  }) => unknown[];
  /** 对局总条数（分页用；缺省时列表接口不返回 total）。 */
  countMatches?: (filter?: {
    gameId?: string;
    kind?: 'official' | 'training';
    entrantId?: string;
  }) => number;
  /** 游戏版本归属：gameVersionId -> gameId（排行榜与摘要路由用）。 */
  gameVersions?: Map<string, string>;
  /** 参赛对象 -> 工作台（用于排行榜归属与对象鉴权）。 */
  entrantWorkspace?: (entrantId: string) => string | null;
  /** 该参赛对象是否有未结束（queued/running）的对局；删除参赛对象前的守卫。 */
  hasLiveMatch?: (entrantId: string) => boolean;
  /** 直播帧分发（观看帧流/回放帧）。 */
  liveHub?: LiveHub;
  /** 对局编排（创建 official/training 对局）。 */
  orchestrator?: MatchOrchestrator;
  /** Agent 工作流（试跑 simulate）；不提供时 agent 路由返回 501。 */
  agentApi?: AgentApiService;
  adminKey?: string;
}

/** 对局摘要：不含私密诊断与源码（ADR 0002）。 */
function matchSummary(
  record: MatchRecord,
  /** 参赛对象名字解析（非真实对象如 bot:standard-01 时返回 null）。 */
  resolveName: (entrantId: string) => string | null = () => null,
) {
  return {
    matchId: record.matchId,
    gameId: record.gameId,
    gameVersionId: record.gameVersionId,
    entrants: record.entrants.map((e) => ({
      entrantId: e.entrantId,
      name: resolveName(e.entrantId),
    })),
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

/**
 * 游戏的当前版本（该游戏最后一个注册版本）。
 *
 * 排行榜（/api/leaderboard/:gameId）与 Agent context 的 rating 必须用同一口径，
 * 否则 ADR 0004 的“按版本分别排名”在两处会出现两个数。
 */
function currentVersionOf(gameVersions: Map<string, string>, gameId: string): string {
  const versionIds = [...gameVersions.entries()]
    .filter(([, gid]) => gid === gameId)
    .map(([vid]) => vid);
  return versionIds[versionIds.length - 1] ?? gameId;
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
  const countMatches = deps.countMatches;
  const hasLiveMatch = deps.hasLiveMatch ?? (() => false);
  // 摘要里展示参赛对象名字：真实对象查 EntrantService；bot:xxx 显示内置基准名。
  const entrantNameOf = (entrantId: string): string | null => {
    if (entrantId.startsWith('bot:')) {
      const bot = tankBots.find((b) => b.id === entrantId.slice('bot:'.length));
      return bot ? `${bot.name}（内置基准）` : entrantId;
    }
    return deps.entrantService.get(entrantId)?.name ?? null;
  };
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
      games: [...games.values()].map((g) => ({
        id: g.id,
        name: g.name,
        pacing: g.pacing,
        // 内置基准 bot（如 standard-01）公开展示：任何人无需凭证即可拿它当对照组。
        bots: tankBots.map((b) => ({ id: b.id, name: b.name, description: b.description })),
      })),
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
      const versionId = currentVersionOf(gameVersions, gameId);
      return { gameVersionId: versionId, entries: deps.rankingService.getLeaderboard(versionId) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (request, reply) => {
    const record = getMatch(request.params.id);
    if (!record) return reply.code(404).send({ error: '对局不存在' });
    return matchSummary(record, entrantNameOf);
  });

  app.get<{
    Querystring: { gameId?: string; kind?: string; entrantId?: string; page?: unknown; pageSize?: unknown };
  }>('/api/matches', async (request) => {
    // 分页参数：page 从 1 起，pageSize 默认 20，上限 100（防止一次拉全量）。
    const gameId =
      typeof request.query.gameId === 'string' && request.query.gameId !== ''
        ? request.query.gameId
        : undefined;
    const kind =
      request.query.kind === 'official' || request.query.kind === 'training'
        ? request.query.kind
        : undefined;
    const entrantId =
      typeof request.query.entrantId === 'string' && request.query.entrantId !== ''
        ? request.query.entrantId
        : undefined;
    const parseBounded = (raw: unknown, fallback: number, max: number): number => {
      const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
      return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
    };
    const pageSize = parseBounded(request.query.pageSize, 20, 100);
    const page = parseBounded(request.query.page, 1, Number.MAX_SAFE_INTEGER);
    const offset = (page - 1) * pageSize;

    const filter: { gameId?: string; kind?: 'official' | 'training'; entrantId?: string } = {
      gameId,
      kind,
      entrantId,
    };
    const records = listMatches({ ...filter, limit: pageSize, offset }) as MatchRecord[];
    return {
      matches: records.map((r) => matchSummary(r, entrantNameOf)),
      page,
      pageSize,
      total: countMatches ? countMatches(filter) : undefined,
    };
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

  // 归档（删除）参赛对象：不可恢复。
  // - 只能由工作台凭证发起：对象凭证若能删除自己，等于把“取消委派”的控制权交给了 Agent；
  // - 行保留（历史对局与回放要引用它、名字还要能解析），但不进列表 / 匹配池 / 排行榜（ADR 0008）；
  // - 同时吊销该对象的全部对象凭证（归档即终止对 Agent 的委派）；配额随之释放。
  app.delete<{ Params: { id: string } }>(
    '/api/entrants/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在或已删除' });
      if (auth.kind !== 'workspace') {
        return reply.code(401).send({ error: '只有工作台凭证可删除参赛对象' });
      }
      if (auth.workspaceId !== entrant.workspaceId) {
        return reply.code(401).send({ error: '无权删除该参赛对象' });
      }
      // 有对局未结束时不能删：清掉记录会让已在跑的 runner/观众失去参照。
      if (hasLiveMatch(entrantId)) {
        return reply.code(409).send({ error: '该参赛对象有对局进行中，请稍后再试' });
      }
      const archived = deps.entrantService.archiveEntrant(entrantId);
      if (!archived) return reply.code(404).send({ error: '参赛对象不存在或已删除' });
      return { entrantId, archived: true };
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/entrants/:id/strategies/publish',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
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

  // 为参赛对象颁发／轮换对象凭证（ADR 0002：委托外部 Agent 管理该对象的凭据）。
  // 明文只返回一次；重新颁发会先作废该对象此前的全部对象凭证，避免凭证无限累积，
  // 也让"凭证疑似泄露时重新颁发即可失效旧的"成为可用手段。
  app.post<{ Params: { id: string } }>(
    '/api/entrants/:id/credential',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      // 颁发属"授权 Agent 代为管理"的决定，只能由工作台凭证做出；对象凭证不能自我提权。
      if (auth.kind !== 'workspace' || auth.workspaceId !== entrant.workspaceId) {
        return reply.code(401).send({ error: '只有工作台凭证可为参赛对象颁发凭证' });
      }
      const credential = deps.entrantService.issueEntrantCredential(entrantId);
      if (!credential) return reply.code(404).send({ error: '参赛对象不存在' });
      return { entrantId, credential };
    },
  );

  // 查询该参赛对象是否已有活跃凭证（用于 UI 提示"已有凭证，点击重新颁发"）
  app.get<{ Params: { id: string } }>(
    '/api/entrants/:id/credential-status',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (auth.kind !== 'workspace' || auth.workspaceId !== entrant.workspaceId) {
        return reply.code(401).send({ error: '只有工作台凭证可查询参赛对象凭证状态' });
      }
      return { entrantId, hasCredential: deps.entrantService.hasActiveCredential(entrantId) };
    },
  );

  // 吊销该参赛对象的全部对象凭证（取消 Agent 对该对象的管理授权）。
  app.delete<{ Params: { id: string } }>(
    '/api/entrants/:id/credential',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (auth.kind !== 'workspace' || auth.workspaceId !== entrant.workspaceId) {
        return reply.code(401).send({ error: '只有工作台凭证可吊销参赛对象凭证' });
      }
      deps.entrantService.revokeEntrantCredentials(entrantId);
      return { entrantId, revoked: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/entrants/:id/strategies',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
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
      const { gameId, kind, myEntrantId, opponentEntrantId, opponentBotId } = body;
      if (typeof gameId !== 'string' || !gameId) {
        return reply.code(400).send({ error: 'gameId 无效' });
      }
      if (kind !== 'official' && kind !== 'training') {
        return reply.code(400).send({ error: 'kind 必须是 official 或 training' });
      }
      if (typeof myEntrantId !== 'string' || !myEntrantId) {
        return reply.code(400).send({ error: 'myEntrantId 无效' });
      }
      // 对手规则（ADR 0006）：
      // - official：只能随机匹配积分相近者，忽略调用方传入的对手；
      // - training：可指定 opponentEntrantId（粘贴任意坦克 ID）或 opponentBotId。
      // 只要字段出现就必须是合法的非空字符串，否则 400——不能因类型不对而被静默当作“未传”，
      // 否则 Agent 传了 opponentEntrantId: 123 会被误当成正式随机匹配放行。
      const hasBot = typeof opponentBotId === 'string' && opponentBotId !== '';
      const hasEntrant = typeof opponentEntrantId === 'string' && opponentEntrantId !== '';
      // 只要字段出现（非 undefined）就必须是合法非空字符串，否则 400——不能因类型不对而被静默当作“未传”，
      // 否则 Agent 传了 opponentEntrantId: 123 会被误当成正式随机匹配放行。
      if ((opponentBotId !== undefined && !hasBot) || (opponentEntrantId !== undefined && !hasEntrant)) {
        return reply
          .code(400)
          .send({ error: 'opponentBotId / opponentEntrantId 必须是非空字符串' });
      }
      if (kind === 'official') {
        if (hasBot || hasEntrant) {
          return reply
            .code(400)
            .send({ error: '正式对局不能指定对手，由系统随机匹配积分相近的对手' });
        }
      } else if (hasBot === hasEntrant) {
        return reply
          .code(400)
          .send({ error: '训练对局必须指定 opponentBotId 或 opponentEntrantId 之一' });
      }
      const workspaceId = resolveWorkspaceId(auth);
      const started = await deps.orchestrator.start({
        gameId,
        kind,
        myEntrantId,
        ...(hasBot ? { opponentBotId: opponentBotId as string } : {}),
        ...(hasEntrant ? { opponentEntrantId: opponentEntrantId as string } : {}),
        workspaceId: workspaceId!,
      });
      if (!started.ok) {
        return reply.code(started.error.status).send({ error: started.error.message });
      }
      const record = getMatch(started.matchId);
      return reply
        .code(202)
        .send({ matchId: started.matchId, summary: record ? matchSummary(record, entrantNameOf) : null });
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

  // ---- Agent 工作流（外部 AI Agent 专用，ADR：试跑不入史不计分） ----

  /**
   * 解析请求对应的“自己”参赛对象：
   * - 对象凭证 → 凭证所属对象；
   * - 工作台凭证 → 显式 entrantId（属于本工作台），或工作台内唯一对象。
   * 失败时直接 reply（401/400），返回 null。
   */
  const resolveSelfEntrant = (
    auth: AuthPrincipal,
    reply: FastifyReply,
    explicitEntrantId: unknown,
  ): { id: string; gameId: string; name: string; createdAt: number; workspaceId: string } | null => {
    if (auth.kind === 'entrant') {
      if (typeof explicitEntrantId === 'string' && explicitEntrantId !== auth.entrantId) {
        reply.code(403).send({ error: '无权管理该参赛对象' });
        return null;
      }
      const e = deps.entrantService.getActive(auth.entrantId);
      if (!e) {
        reply.code(404).send({ error: '参赛对象不存在' });
        return null;
      }
      return e;
    }
    // 工作台凭证（admin 已被 requireAuth 拦截，此处仅为类型收窄）
    if (auth.kind !== 'workspace') {
      reply.code(401).send({ error: '未认证' });
      return null;
    }
    if (typeof explicitEntrantId === 'string' && explicitEntrantId) {
      // 已删除（归档）的对象视同不存在：不能再用它跑模拟/发布/发起对局。
      const e = deps.entrantService.getActive(explicitEntrantId);
      if (!e) {
        reply.code(404).send({ error: '参赛对象不存在' });
        return null;
      }
      if (e.workspaceId !== auth.workspaceId) {
        reply.code(403).send({ error: '无权管理该参赛对象' });
        return null;
      }
      return e;
    }
    const list = deps.entrantService.listByWorkspace(auth.workspaceId);
    if (list.length === 0) {
      reply.code(400).send({ error: '工作台内没有参赛对象，请先创建' });
      return null;
    }
    if (list.length > 1) {
      reply.code(400).send({ error: '工作台内有多个参赛对象，请指定 entrantId' });
      return null;
    }
    return list[0]!;
  };

  app.get('/api/agent/context', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    const query = (request.query ?? {}) as { entrantId?: string };
    const entrant = resolveSelfEntrant(auth, reply, query.entrantId);
    if (!entrant) return reply;

    const versions = deps.strategyService.listVersions(entrant.id);
    const latest = versions[versions.length - 1] ?? null;
    const rating =
      deps.rankingService.getScore(currentVersionOf(gameVersions, entrant.gameId), entrant.id) ??
      1000;

    return {
      entrant: {
        id: entrant.id,
        name: entrant.name,
        gameId: entrant.gameId,
        createdAt: entrant.createdAt,
        rating,
      },
      // ADR 0002：源码默认私密、公开是版本级选择。这里只向**已认证的管理者／其 Agent**
      // 回传自己的源码（Agent 迭代自己的策略必须能读自己的代码），不向任何第三方开放；
      // publicVisible 原样回显，供 Agent 判断该版本是否已对外公开。
      latestStrategy: latest
        ? {
            versionId: latest.versionId,
            code: latest.source,
            createdAt: latest.createdAt,
            publicVisible: latest.publicVisible,
          }
        : null,
      bots: tankBots.map((b) => ({ id: b.id, name: b.name, description: b.description })),
      api: {
        simulate: 'POST /api/agent/simulate',
        context: 'GET /api/agent/context',
        matches: 'POST /api/matches',
        strategies: 'POST /api/entrants/:id/strategies/publish',
      },
      guide: '/agent-guide',
    };
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/api/agent/simulate',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!deps.agentApi) {
        return reply.code(501).send({ error: '引擎未接入' });
      }
      const auth = request.auth!;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const entrant = resolveSelfEntrant(auth, reply, body.entrantId);
      if (!entrant) return reply;

      const { code, opponent } = body;
      if (typeof code !== 'string' || code.trim() === '') {
        return reply.code(400).send({ error: 'code 无效' });
      }
      if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        return reply.code(400).send({ error: 'code 超长（上限 200KB）' });
      }

      const opp = (opponent ?? {}) as Record<string, unknown>;
      const hasBotId = typeof opp.botId === 'string' && opp.botId !== '';
      const hasVersionId =
        typeof opp.strategyVersionId === 'number' && Number.isInteger(opp.strategyVersionId);
      if (opp.botId !== undefined && !hasBotId) {
        return reply.code(400).send({ error: 'botId 无效' });
      }
      if (
        opp.strategyVersionId !== undefined &&
        !(typeof opp.strategyVersionId === 'number' && Number.isInteger(opp.strategyVersionId))
      ) {
        return reply.code(400).send({ error: 'strategyVersionId 无效' });
      }
      if (hasBotId && hasVersionId) {
        return reply.code(400).send({ error: 'botId 与 strategyVersionId 只能指定其一' });
      }

      let opponentName: string;
      let opponentSource: string;
      if (hasBotId) {
        const bot = tankBots.find((b) => b.id === opp.botId);
        if (!bot) {
          return reply.code(400).send({ error: 'botId 无效' });
        }
        opponentName = bot.name;
        opponentSource = bot.code;
      } else if (hasVersionId) {
        // 自打自：版本必须属于该参赛对象（别人的版本 → 403）。
        const version = deps.strategyService.getVersion(entrant.id, opp.strategyVersionId as number);
        if (!version) {
          // 区分“版本号被别人占用”（403）与“根本不存在”（400）。
          const belongsToOther = deps.entrantService
            .listAll()
            .some((e) => deps.strategyService.getVersion(e.id, opp.strategyVersionId as number));
          return reply.code(belongsToOther ? 403 : 400).send({
            error: belongsToOther ? '无权使用该策略版本' : 'strategyVersionId 无效',
          });
        }
        opponentName = `${entrant.name}#v${version.versionId}`;
        opponentSource = version.source;
      } else {
        // 缺省：随机内置 bot。
        const bot = tankBots[Math.floor(Math.random() * tankBots.length)]!;
        opponentName = bot.name;
        opponentSource = bot.code;
      }

      // 限流：每参赛对象 2 秒 1 次（全部校验通过后计入窗口）。
      if (deps.agentApi.isRateLimited(entrant.id)) {
        return reply.code(429).send({ error: '试跑冷却中，2 秒 1 次' });
      }

      const result = await deps.agentApi.run({ code, entrantId: entrant.id }, opponentName, opponentSource);
      return result;
    },
  );

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
