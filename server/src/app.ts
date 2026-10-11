/**
 * HTTP API 组装：公开路由、账号路由、业务路由与管理路由（ADR 0015 / 0016 / 0002 / 0004）。
 *
 * - 鉴权双轨（ADR 0016）：会话令牌（人，登录签发）与 API 令牌（外部 Agent，仅授权指定参赛对象）。
 * - 错误统一 JSON { error }，不泄露内部细节。
 * - app 不 listen，测试使用 fastify.inject。
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { UserService } from './services/user-service.js';
import type { EntrantService, EntrantQuotaExceededError } from './services/entrant-service.js';
import type { StrategyService } from './services/strategy-service.js';
import type { RankingService } from './services/ranking-service.js';
import { makeAuthPlugin, requirePrincipal, requireAdmin, extractBearerToken, type AuthPrincipal } from './services/credential-auth.js';
import { AgentApiService, MAX_CODE_BYTES } from './services/agent-api-service.js';
import { tankBots } from './games/tank/bots.js';
import type { GameDefinition } from './games/contracts.js';
import type { MatchRecord } from './engine/match-contracts.js';
import type { LiveHub } from './engine/live-hub.js';
import type { MatchOrchestrator } from './engine/match-orchestrator.js';
import type { ExhibitionService } from './services/exhibition-service.js';
import { ExhibitionError } from './services/exhibition-service.js';
import type { ExhibitionRecord } from './services/exhibition-contracts.js';

/** 注册的游戏集合（id -> GameDefinition），由后台导入。 */
export type GameRegistry = Map<string, GameDefinition>;

export interface AppDeps {
  userService: UserService;
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
    kind?: 'official' | 'training' | 'exhibition';
    entrantId?: string;
    limit?: number;
    offset?: number;
  }) => unknown[];
  /** 对局总条数（分页用；缺省时列表接口不返回 total）。 */
  countMatches?: (filter?: {
    gameId?: string;
    kind?: 'official' | 'training' | 'exhibition';
    entrantId?: string;
    phase?: MatchRecord['phase'];
  }) => number;
  /** 游戏版本归属：gameVersionId -> gameId（排行榜与摘要路由用）。 */
  gameVersions?: Map<string, string>;
  /** 参赛对象 -> 用户（用于排行榜归属与对象鉴权）。 */
  entrantUser?: (entrantId: string) => string | null;
  /** 该参赛对象是否有未结束（queued/running）的对局；删除参赛对象前的守卫。 */
  hasLiveMatch?: (entrantId: string) => boolean;
  /** 直播帧分发（观看帧流/回放帧）。 */
  liveHub?: LiveHub;
  /** 对局编排（创建 official/training 对局）。 */
  orchestrator?: MatchOrchestrator;
  /** Agent 工作流（试跑 simulate）；不提供时 agent 路由返回 501。 */
  agentApi?: AgentApiService;
  /** 表演赛（ADR 0017）；不提供时表演赛路由返回 501。 */
  exhibitionService?: ExhibitionService;
}

/** 对局摘要：不含私密诊断与源码（ADR 0002）。 */
function matchSummary(
  record: MatchRecord,
  /** 参赛对象名字解析（非真实对象如 bot:standard-01 时返回 null）。 */
  resolveName: (entrantId: string) => string | null = () => null,
  /** 参赛对象外观解析（bot 等非真实对象返回 null，前端回退默认色）。 */
  resolveAppearance: (entrantId: string) => { color: string; preset: string } | null = () => null,
  /** 参赛对象所属用户昵称解析（bot 返回 null）。 */
  resolveUser: (entrantId: string) => string | null = () => null,
) {
  return {
    matchId: record.matchId,
    gameId: record.gameId,
    gameVersionId: record.gameVersionId,
    entrants: record.entrants.map((e) => ({
      entrantId: e.entrantId,
      name: resolveName(e.entrantId),
      appearance: resolveAppearance(e.entrantId),
      userNickname: resolveUser(e.entrantId),
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
    // 表演赛座位（ADR 0017）：seat:{matchId}:{side} → 座位自报名称（无则 null，前端回退「座位 X」）。
    if (entrantId.startsWith('seat:')) {
      const ex = deps.exhibitionService?.getExhibition(entrantId.split(':')[1] ?? '');
      if (!ex) return null;
      const side = Number(entrantId.split(':')[2]);
      return ex.seatNames[side === 1 ? 1 : 0] ?? null;
    }
    return deps.entrantService.get(entrantId)?.name ?? null;
  };
  // 摘要里展示战场颜色：真实对象用自选 appearance.color；bot 无外观返回 null，前端回退默认灰。
  const entrantAppearanceOf = (entrantId: string): { color: string; preset: string } | null => {
    if (entrantId.startsWith('bot:')) return null;
    const e = deps.entrantService.get(entrantId);
    return e ? { color: e.appearance.color, preset: e.appearance.preset } : null;
  };
  // 「坦克名@用户名」消歧（ADR 0010）：真实对象取其所属用户昵称，无昵称时回退用户名；bot 无归属返回 null。
  const entrantUserNicknameOf = (entrantId: string): string | null => {
    if (entrantId.startsWith('bot:')) return null;
    const e = deps.entrantService.get(entrantId);
    if (!e) return null;
    const u = deps.userService.get(e.userId);
    return u?.nickname || u?.username || null;
  };
  const gameVersions = deps.gameVersions ?? new Map<string, string>();
  const gameVersionOf = (gameVersionId: string) => gameVersions.get(gameVersionId);

  // 直接在根作用域应用认证插件（decorate + onRequest 解析），避免 encapsulation
  // 导致根路由读不到 request.auth。
  await makeAuthPlugin({
    userService: deps.userService,
    entrantService: deps.entrantService,
  })(app);

  const requireAuth = requirePrincipal();
  const adminOnly = requireAdmin();

  /** 业务路由通用守卫：要求会话令牌（用户身份）。API 令牌不走账号路由。 */
  function requireUser(request: FastifyRequest, reply: FastifyReply): { userId: string } | null {
    const auth = request.auth;
    if (!auth || auth.kind !== 'user') {
      reply.code(401).send({ error: '需要登录' });
      return null;
    }
    return { userId: auth.userId };
  }

  // ---- 公开路由（无需认证） ----

  // 公开路由：游戏列表（不含 exhibitionOnly 游戏，ADR 0018；表演赛创建页用专门端点）。
  app.get('/api/games', async () => {
    return {
      games: [...games.values()]
        .filter((g) => !g.exhibitionOnly)
        .map((g) => ({
          id: g.id,
          name: g.name,
          pacing: g.pacing,
          // 内置基准 bot（如 standard-01）公开展示：任何人无需登录即可拿它当对照组。
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
      // ADR 0018：exhibitionOnly 游戏不进常规排行榜（无参赛对象，无计分）。
      if (games.get(gameId)?.exhibitionOnly) {
        return reply.code(404).send({ error: '该游戏仅支持表演赛，无排行榜' });
      }
      // 首版每个游戏一个当前版本；多版本排名在游戏版本注册后按 versionId 分别查询。
      const versionId = currentVersionOf(gameVersions, gameId);
      // 榜单是纯内存（只有 entrantId/比分），路由层 join 补名字与「@用户名」消歧（ADR 0010）。
      const entries = deps.rankingService.getLeaderboard(versionId).map((e) => ({
        ...e,
        name: entrantNameOf(e.entrantId),
        userNickname: entrantUserNicknameOf(e.entrantId),
      }));
      return { gameVersionId: versionId, entries };
    },
  );

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (request, reply) => {
    const record = getMatch(request.params.id);
    if (!record) return reply.code(404).send({ error: '对局不存在' });
    return matchSummary(record, entrantNameOf, entrantAppearanceOf, entrantUserNicknameOf);
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
      request.query.kind === 'official' ||
      request.query.kind === 'training' ||
      request.query.kind === 'exhibition'
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

    const filter: { gameId?: string; kind?: 'official' | 'training' | 'exhibition'; entrantId?: string } = {
      gameId,
      kind,
      entrantId,
    };
    const records = listMatches({ ...filter, limit: pageSize, offset }) as MatchRecord[];
    return {
      matches: records.map((r) => matchSummary(r, entrantNameOf, entrantAppearanceOf, entrantUserNicknameOf)),
      page,
      pageSize,
      total: countMatches ? countMatches(filter) : undefined,
    };
  });

  // ---- 账号路由（注册/登录/找回，ADR 0015） ----

  // 注册：邀请码 + 用户名 + 密码；一次性返回恢复码（明文只此一次，请用户抄写保管）。
  app.post<{ Body: { inviteCode?: unknown; username?: unknown; password?: unknown; nickname?: unknown } }>(
    '/api/auth/register',
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const inviteCode = body.inviteCode;
      const username = body.username;
      const password = body.password;
      const nickname = body.nickname;
      if (typeof inviteCode !== 'string' || inviteCode.trim() === '') {
        return reply.code(400).send({ error: '邀请码无效' });
      }
      if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username.trim())) {
        return reply.code(400).send({ error: '用户名需 3-32 位字母、数字或下划线' });
      }
      if (typeof password !== 'string' || password.length < 6) {
        return reply.code(400).send({ error: '密码至少 6 位' });
      }
      if (nickname !== undefined && nickname !== null && typeof nickname !== 'string') {
        return reply.code(400).send({ error: '昵称格式无效' });
      }
      const result = deps.userService.register(
        inviteCode,
        username.trim(),
        password,
        typeof nickname === 'string' && nickname.trim() !== '' ? nickname.trim() : undefined,
      );
      if (result === 'taken') return reply.code(409).send({ error: '该用户名已被占用' });
      if (!result) return reply.code(400).send({ error: '邀请码无效' });
      return reply.code(201).send({
        userId: result.userId,
        username: result.username,
        recoveryCode: result.recoveryCode,
      });
    },
  );

  // 登录：签发会话令牌（Bearer）。封禁用户拒绝登录。
  app.post<{ Body: { username?: unknown; password?: unknown } }>(
    '/api/auth/login',
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.username !== 'string' || typeof body.password !== 'string') {
        return reply.code(400).send({ error: '用户名或密码无效' });
      }
      const session = deps.userService.login(body.username, body.password);
      if (!session) return reply.code(401).send({ error: '用户名或密码错误' });
      const user = deps.userService.get(session.userId);
      return {
        token: session.token,
        userId: session.userId,
        username: user?.username ?? '',
        nickname: user?.nickname ?? null,
        role: user?.role ?? 'user',
      };
    },
  );

  // 登出：吊销当前会话令牌。
  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth;
    if (!auth || auth.kind !== 'user') return reply.code(401).send({ error: '需要登录' });
    const token = request.headers.authorization!.slice('Bearer '.length).trim();
    deps.userService.logout(token);
    return { ok: true };
  });

  // 当前用户自信息（昵称、角色等），供前端显示与改名。
  app.get('/api/users/me', { preHandler: requireAuth }, async (request, reply) => {
    const me = requireUser(request, reply);
    if (!me) return reply;
    const record = deps.userService.get(me.userId);
    if (!record) return reply.code(404).send({ error: '用户不存在' });
    return {
      userId: record.id,
      username: record.username,
      nickname: record.nickname,
      role: record.role,
      createdAt: record.createdAt,
    };
  });

  // 改昵称（展示用，不要求唯一）。
  app.post<{ Body: { nickname?: unknown } }>(
    '/api/users/me/nickname',
    { preHandler: requireAuth },
    async (request, reply) => {
      const me = requireUser(request, reply);
      if (!me) return reply;
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.nickname !== 'string' || body.nickname.trim() === '') {
        return reply.code(400).send({ error: '昵称不能为空' });
      }
      const result = deps.userService.rename(me.userId, body.nickname);
      if (result === null) return reply.code(404).send({ error: '用户不存在' });
      if (result === false) return reply.code(400).send({ error: '昵称不能为空' });
      const record = deps.userService.get(me.userId);
      return { userId: me.userId, nickname: record?.nickname ?? null };
    },
  );

  // 凭恢复码自助重置密码（ADR 0015）：新密码生效、旧会话全部吊销、恢复码轮换。
  // 新恢复码不在响应中返回（明文仅管理路由可查），用户可向管理员求助获取。
  app.post<{ Body: { username?: unknown; recoveryCode?: unknown; newPassword?: unknown } }>(
    '/api/auth/reset-password',
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (
        typeof body.username !== 'string' ||
        typeof body.recoveryCode !== 'string' ||
        typeof body.newPassword !== 'string'
      ) {
        return reply.code(400).send({ error: '参数无效' });
      }
      if (body.newPassword.length < 6) {
        return reply.code(400).send({ error: '密码至少 6 位' });
      }
      // ADR 0015：新密码生效即吊销旧会话；API 令牌不受影响（外部 Agent 托管无需重新接手）。
      const ok = deps.userService.resetPasswordByRecoveryCode(
        body.username,
        body.recoveryCode,
        body.newPassword,
      );
      if (!ok) return reply.code(400).send({ error: '恢复码或用户名错误' });
      return { ok: true };
    },
  );

  // ---- 业务路由（会话令牌或 API 令牌） ----

  app.get('/api/entrants', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.auth!;
    // 会话令牌 → 该用户全部在役对象；API 令牌 → 仅凭证所属对象。
    const userId =
      auth.kind === 'user'
        ? auth.userId
        : deps.entrantService.get(auth.entrantId)?.userId;
    if (!userId) return reply.code(404).send({ error: '参赛对象不存在' });
    const entrants =
      auth.kind === 'user'
        ? deps.entrantService.listByUser(auth.userId)
        : [deps.entrantService.get(auth.entrantId)!];
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
      // 创建参赛对象是账号级操作（ADR 0016：API 令牌不授予账号级权限）。
      const me = requireUser(request, reply);
      if (!me) return reply;
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
      // ADR 0018：exhibitionOnly 游戏（如象棋 v1）不进常规入口，不能创建参赛对象。
      if (games.get(gameId)?.exhibitionOnly) {
        return reply.code(400).send({ error: '该游戏仅支持表演赛，不能创建参赛对象' });
      }
      try {
        const entrant = deps.entrantService.createEntrant(me.userId, {
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
  // - 只能由用户会话发起：API 令牌若能删除自己，等于把“取消委派”的控制权交给了 Agent；
  // - 行保留（历史对局与回放要引用它、名字还要能解析），但不进列表 / 匹配池 / 排行榜（ADR 0008）；
  // - 同时吊销该对象的全部 API 令牌（归档即终止对 Agent 的委派）；配额随之释放。
  app.delete<{ Params: { id: string } }>(
    '/api/entrants/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const me = requireUser(request, reply);
      if (!me) return reply;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在或已删除' });
      if (entrant.userId !== me.userId) {
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
      // API 令牌只能操作自己；用户会话可管理本人全部对象。
      if (auth.kind === 'entrant' && auth.entrantId !== entrantId) {
        return reply.code(401).send({ error: '无权管理该参赛对象' });
      }
      if (auth.kind === 'user' && auth.userId !== entrant.userId) {
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

  // 为参赛对象颁发／轮换 API 令牌（ADR 0016：委托外部 Agent 管理该对象的凭据）。
  // 明文存库可随时取回；重新颁发会先作废该对象此前的全部 API 令牌，避免令牌无限累积，
  // 也让"令牌疑似泄露时重新颁发即可失效旧的"成为可用手段。
  app.post<{ Params: { id: string } }>(
    '/api/entrants/:id/credential',
    { preHandler: requireAuth },
    async (request, reply) => {
      // 颁发属"授权 Agent 代为管理"的决定，只能由用户会话做出；API 令牌不能自我提权。
      const me = requireUser(request, reply);
      if (!me) return reply;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (entrant.userId !== me.userId) {
        return reply.code(401).send({ error: '只有本人可为参赛对象颁发 API 令牌' });
      }
      const credential = deps.entrantService.issueEntrantCredential(entrantId);
      if (!credential) return reply.code(404).send({ error: '参赛对象不存在' });
      return { entrantId, credential };
    },
  );

  // 取回该参赛对象当前 API 令牌的明文（ADR 0016：明文存库，
  // 用户会话可随时取回；API 令牌无权读自己的明文）。
  app.get<{ Params: { id: string } }>(
    '/api/entrants/:id/credential',
    { preHandler: requireAuth },
    async (request, reply) => {
      const me = requireUser(request, reply);
      if (!me) return reply;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (entrant.userId !== me.userId) {
        return reply.code(401).send({ error: '只有本人可取回参赛对象 API 令牌' });
      }
      const credential = deps.entrantService.getEntrantCredential(entrantId);
      if (credential === null) return reply.code(404).send({ error: '该参赛对象还没有颁发过 API 令牌' });
      return { entrantId, credential };
    },
  );

  // 查询该参赛对象是否已有活跃令牌（用于 UI 提示"已有令牌，点击重新颁发"）。
  app.get<{ Params: { id: string } }>(
    '/api/entrants/:id/credential-status',
    { preHandler: requireAuth },
    async (request, reply) => {
      const me = requireUser(request, reply);
      if (!me) return reply;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (entrant.userId !== me.userId) {
        return reply.code(401).send({ error: '只有本人可查询参赛对象令牌状态' });
      }
      return { entrantId, hasCredential: deps.entrantService.hasActiveCredential(entrantId) };
    },
  );

  // 吊销该参赛对象的全部 API 令牌（取消 Agent 对该对象的管理授权）。
  app.delete<{ Params: { id: string } }>(
    '/api/entrants/:id/credential',
    { preHandler: requireAuth },
    async (request, reply) => {
      const me = requireUser(request, reply);
      if (!me) return reply;
      const entrantId = request.params.id;
      const entrant = deps.entrantService.getActive(entrantId);
      if (!entrant) return reply.code(404).send({ error: '参赛对象不存在' });
      if (entrant.userId !== me.userId) {
        return reply.code(401).send({ error: '只有本人可吊销参赛对象 API 令牌' });
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
      if (auth.kind === 'user' && auth.userId !== entrant.userId) {
        return reply.code(401).send({ error: '无权读取该参赛对象的策略' });
      }
      // 持管理者凭据可读全量版本与源码；公开版本的源码读取入口在观战侧另行提供。
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
      const auth = request.auth!;
      const body = request.body ?? {};
      const { gameId, kind, myEntrantId, opponentEntrantId, opponentBotId } = body;
      if (typeof gameId !== 'string' || !gameId) {
        return reply.code(400).send({ error: 'gameId 无效' });
      }
      // ADR 0018：exhibitionOnly 游戏（如象棋 v1）只能建表演赛，不发正式/训练对局。
      if (games.get(gameId)?.exhibitionOnly) {
        return reply.code(400).send({ error: '该游戏仅支持表演赛' });
      }
      if (!deps.orchestrator) {
        return reply.code(501).send({ error: '引擎未接入' });
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
      // 发起者身份：API 令牌以其所属用户记；会话令牌直接用本人。
      const userId =
        auth.kind === 'user'
          ? auth.userId
          : deps.entrantService.get(auth.entrantId)?.userId;
      if (!userId) return reply.code(404).send({ error: '参赛对象不存在' });
      const started = await deps.orchestrator.start({
        gameId,
        kind,
        myEntrantId,
        ...(hasBot ? { opponentBotId: opponentBotId as string } : {}),
        ...(hasEntrant ? { opponentEntrantId: opponentEntrantId as string } : {}),
        userId,
      });
      if (!started.ok) {
        return reply.code(started.error.status).send({ error: started.error.message });
      }
      const record = getMatch(started.matchId);
      return reply
        .code(202)
        .send({ matchId: started.matchId, summary: record ? matchSummary(record, entrantNameOf, entrantAppearanceOf, entrantUserNicknameOf) : null });
    },
  );

  // 直播/回放帧流：fromTick 起的历史帧 + 增量帧（SSE，观众无需登录，ADR 0002）。
  if (deps.liveHub) {
    const liveHub = deps.liveHub;
    app.get<{ Params: { id: string }; Querystring: { fromTick?: string } }>(
      '/api/matches/:id/frames',
      async (request, reply) => {
        const record = getMatch(request.params.id);
        if (!record) return reply.code(404).send({ error: '对局不存在' });
        // 训练默认私密（ADR 0002）：未登录访客只能观看 official；本人（或其 Agent）可看自己的。
        if (record.kind === 'training') {
          const auth = request.auth;
          const allowed =
            auth !== null &&
            record.entrants.some(
              (e) => deps.entrantService.get(e.entrantId)?.userId === auth.userId,
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

  // ---- 表演赛（ADR 0017：座位协议 + 生命周期） ----

  /** 表演赛摘要（列表/详情用；不含密钥）。 */
  const exhibitionSummary = (ex: ExhibitionRecord) => ({
    matchId: ex.matchId,
    gameId: ex.gameId,
    title: ex.title,
    creatorUserId: ex.creatorUserId,
    perMoveTimeoutMs: ex.perMoveTimeoutMs,
    isPublic: ex.isPublic,
    seatNames: ex.seatNames,
    paused: ex.paused,
    createdAt: ex.createdAt,
    voidedAt: ex.voidedAt,
    finishedAt: ex.finishedAt,
  });

  /** 统一 ExhibitionError → HTTP 状态码 + { error }。 */
  const exhibitionFail = (err: unknown, reply: FastifyReply): FastifyReply => {
    if (err instanceof ExhibitionError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  };

  // 创建表演赛（登录用户）：返回两个座位链接（人发给两个外部 AI）。
  app.post<{ Body: Record<string, unknown> }>(
    '/api/exhibitions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const me = requireUser(request, reply);
      if (!me) return reply;
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const body = request.body ?? {};
      const { gameId, title, perMoveTimeoutMinutes, isPublic } = body;
      if (typeof gameId !== 'string' || !gameId) {
        return reply.code(400).send({ error: 'gameId 无效' });
      }
      if (title !== undefined && (typeof title !== 'string' || title.length > 100)) {
        return reply.code(400).send({ error: '标题无效（≤100 字符）' });
      }
      if (
        perMoveTimeoutMinutes !== undefined &&
        (typeof perMoveTimeoutMinutes !== 'number' ||
          !Number.isFinite(perMoveTimeoutMinutes) ||
          perMoveTimeoutMinutes < 1 ||
          perMoveTimeoutMinutes > 1440)
      ) {
        return reply.code(400).send({ error: '每步时限无效（1-1440 分钟）' });
      }
      try {
        const record = deps.exhibitionService.createExhibition({
          gameId,
          creatorUserId: me.userId,
          ...(title !== undefined ? { title } : {}),
          ...(perMoveTimeoutMinutes !== undefined
            ? { perMoveTimeoutMs: Math.round(perMoveTimeoutMinutes * 60_000) }
            : {}),
          ...(isPublic !== undefined ? { isPublic: isPublic === true } : {}),
        });
        const seatLinks = deps.exhibitionService
          .listSeatKeys(record.matchId)
          .map((k) => ({ side: k.side, key: k.key, url: `#/seat/${k.key}` }));
        return reply.code(201).send({ ...exhibitionSummary(record), seatLinks });
      } catch (err) {
        return exhibitionFail(err, reply);
      }
    },
  );

  // 表演赛可用游戏列表（含 exhibitionOnly 游戏，如象棋；ADR 0018）。
  app.get('/api/exhibitions/games', async (_request, reply) => {
    if (!deps.exhibitionService) {
      return reply.code(501).send({ error: '表演赛未接入' });
    }
    return {
      games: [...games.values()]
        .filter((g) => g.exhibitionEligible)
        .map((g) => ({ id: g.id, name: g.name, pacing: g.pacing })),
    };
  });

  // 公开表演赛列表（直播大厅，免登录；私密不进列表）。
  app.get('/api/exhibitions', async (_request, reply) => {
    if (!deps.exhibitionService) {
      return reply.code(501).send({ error: '表演赛未接入' });
    }
    return { exhibitions: deps.exhibitionService.listPublic().map(exhibitionSummary) };
  });

  // 我的表演赛（含私密与已结束；登录用户）。
  app.get('/api/exhibitions/mine', { preHandler: requireAuth }, async (request, reply) => {
    const me = requireUser(request, reply);
    if (!me) return reply;
    if (!deps.exhibitionService) {
      return reply.code(501).send({ error: '表演赛未接入' });
    }
    return {
      exhibitions: deps.exhibitionService.listByCreator(me.userId).map(exhibitionSummary),
    };
  });

  // 表演赛详情（免登录；私密凭链接观战——知道 matchId 即可观战，ADR 0017）。
  app.get<{ Params: { matchId: string } }>(
    '/api/exhibitions/:matchId',
    async (request, reply) => {
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const ex = deps.exhibitionService.getExhibition(request.params.matchId);
      if (!ex) return reply.code(404).send({ error: '对局不存在' });
      return exhibitionSummary(ex);
    },
  );

  // 座位密钥查看（创建者/管理员；对局进行中才有密钥）。
  app.get<{ Params: { matchId: string } }>(
    '/api/exhibitions/:matchId/seat-keys',
    { preHandler: requireAuth },
    async (request, reply) => {
      const auth = request.auth!;
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const ex = deps.exhibitionService.getExhibition(request.params.matchId);
      if (!ex) return reply.code(404).send({ error: '对局不存在' });
      const isCreator = auth.kind === 'user' && auth.userId === ex.creatorUserId;
      const isAdmin = auth.kind === 'user' && auth.role === 'admin';
      if (!isCreator && !isAdmin) {
        return reply.code(403).send({ error: '只有创建者或管理员可查看座位密钥' });
      }
      return {
        seatLinks: deps.exhibitionService
          .listSeatKeys(ex.matchId)
          .map((k) => ({ side: k.side, key: k.key, url: `#/seat/${k.key}` })),
      };
    },
  );

  // 暂停 / 恢复 / 解散（创建者或管理员）。
  const requireExhibitionManager = (
    request: FastifyRequest,
    reply: FastifyReply,
    matchId: string,
  ): string | null => {
    const auth = request.auth;
    if (!auth || auth.kind !== 'user') {
      reply.code(401).send({ error: '需要登录' });
      return null;
    }
    const ex = deps.exhibitionService?.getExhibition(matchId);
    if (!ex) {
      reply.code(404).send({ error: '对局不存在' });
      return null;
    }
    const isAdmin = auth.role === 'admin';
    if (auth.userId !== ex.creatorUserId && !isAdmin) {
      reply.code(403).send({ error: '只有创建者或管理员可操作' });
      return null;
    }
    return isAdmin ? `admin:${auth.userId}` : auth.userId;
  };

  app.post<{ Params: { matchId: string } }>(
    '/api/exhibitions/:matchId/pause',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const userId = requireExhibitionManager(request, reply, request.params.matchId);
      if (userId === null) return reply;
      try {
        deps.exhibitionService.pause(request.params.matchId, userId);
        return { ok: true };
      } catch (err) {
        return exhibitionFail(err, reply);
      }
    },
  );

  app.post<{ Params: { matchId: string } }>(
    '/api/exhibitions/:matchId/resume',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const userId = requireExhibitionManager(request, reply, request.params.matchId);
      if (userId === null) return reply;
      try {
        deps.exhibitionService.resume(request.params.matchId, userId);
        return { ok: true };
      } catch (err) {
        return exhibitionFail(err, reply);
      }
    },
  );

  app.post<{ Params: { matchId: string } }>(
    '/api/exhibitions/:matchId/dissolve',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const userId = requireExhibitionManager(request, reply, request.params.matchId);
      if (userId === null) return reply;
      try {
        await deps.exhibitionService.dissolve(request.params.matchId, userId);
        return { ok: true };
      } catch (err) {
        return exhibitionFail(err, reply);
      }
    },
  );

  // ---- 座位 REST（ADR 0017：外部 AI 用座位密钥调用，免登录） ----

  /** 解析座位密钥（Authorization: Bearer <seatKey>）；无效 401。 */
  const requireSeatKey = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const key = extractBearerToken(request);
    if (!key) {
      reply.code(401).send({ error: '缺少座位密钥（Authorization: Bearer <key>）' });
      return null;
    }
    return key;
  };

  app.get('/api/seat/observe', async (request, reply) => {
    if (!deps.exhibitionService) {
      return reply.code(501).send({ error: '表演赛未接入' });
    }
    const key = requireSeatKey(request, reply);
    if (key === null) return reply;
    try {
      return await deps.exhibitionService.observe(key);
    } catch (err) {
      return exhibitionFail(err, reply);
    }
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/api/seat/act',
    async (request, reply) => {
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const key = requireSeatKey(request, reply);
      if (key === null) return reply;
      const body = request.body ?? {};
      const { action } = body;
      if (action === undefined || action === null || typeof action !== 'object') {
        return reply.code(400).send({ error: 'action 无效（应为游戏走法对象）' });
      }
      try {
        return await deps.exhibitionService.act(key, action);
      } catch (err) {
        return exhibitionFail(err, reply);
      }
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/seat/set-name',
    async (request, reply) => {
      if (!deps.exhibitionService) {
        return reply.code(501).send({ error: '表演赛未接入' });
      }
      const key = requireSeatKey(request, reply);
      if (key === null) return reply;
      const body = request.body ?? {};
      const { name } = body;
      if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 64) {
        return reply.code(400).send({ error: '名称无效（1-64 字符）' });
      }
      try {
        return { ok: await deps.exhibitionService.setName(key, name) };
      } catch (err) {
        return exhibitionFail(err, reply);
      }
    },
  );

  // ---- Agent 工作流（外部 AI Agent 专用，ADR：试跑不入史不计分） ----

  /**
   * 解析请求对应的“自己”参赛对象：
   * - API 令牌 → 令牌所属对象；
   * - 用户会话 → 显式 entrantId（属于本人），或本人唯一在役对象。
   * 失败时直接 reply（401/400），返回 null。
   */
  const resolveSelfEntrant = (
    auth: AuthPrincipal,
    reply: FastifyReply,
    explicitEntrantId: unknown,
  ): { id: string; gameId: string; name: string; createdAt: number; userId: string } | null => {
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
    // 用户会话
    if (auth.kind !== 'user') {
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
      if (e.userId !== auth.userId) {
        reply.code(403).send({ error: '无权管理该参赛对象' });
        return null;
      }
      return e;
    }
    const list = deps.entrantService.listByUser(auth.userId);
    if (list.length === 0) {
      reply.code(400).send({ error: '账号下没有参赛对象，请先创建' });
      return null;
    }
    if (list.length > 1) {
      reply.code(400).send({ error: '账号内有多个参赛对象，请指定 entrantId' });
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

  // ---- 管理路由（admin 角色的会话令牌，ADR 0015） ----

  // 管理概览：平台计数 + 用户明细 + 对局统计（不含任何令牌/哈希）。
  app.get(
    '/api/admin/stats',
    { preHandler: adminOnly },
    async () => {
      const stats = deps.userService.stats();
      const users = deps.userService.listUsers().map((u) => ({
        ...u,
        entrantCount: deps.entrantService.countInService(u.id),
        archivedEntrantCount: deps.entrantService.countArchived(u.id),
        strategyCount: deps.entrantService
          .listByUser(u.id)
          .reduce((n, e) => n + deps.strategyService.listVersions(e.id).length, 0),
      }));
      return {
        ...stats,
        strategyVersions: deps.strategyService.countAllVersions(),
        // 在役与已归档分开报，且都走同一段计数口径：归档即释放配额，两个数一起看才知道删过多少。
        entrantCount: deps.entrantService.countInService(),
        archivedEntrantCount: deps.entrantService.countArchived(),
        users,
        // 对局统计：四个数都走 countMatches 同一计数口径（SQL COUNT），
        // 避免列表抽样口径（如取前 100 条过滤）在数据量大时失真。
        // countMatches 未注入（纯服务测试）时计 0，不阻塞概览。
        matchStats: {
          total: countMatches ? countMatches() : 0,
          live: countMatches
            ? countMatches({ phase: 'queued' }) + countMatches({ phase: 'running' })
            : 0,
          official: countMatches ? countMatches({ kind: 'official' }) : 0,
          training: countMatches ? countMatches({ kind: 'training' }) : 0,
        },
      };
    },
  );

  // 未兑换邀请码列表（管理视角）。
  app.get(
    '/api/admin/invite-codes',
    { preHandler: adminOnly },
    async () => {
      return { codes: deps.userService.listPendingInviteCodes() };
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
      deps.userService.addInviteCode(body.code.trim());
      return reply.code(201).send({ ok: true });
    },
  );

  // 撤销未兑换邀请码（已兑换的已绑定用户，不可撤回）；不存在或已兑换 → 404。
  app.delete<{ Params: { code: string } }>(
    '/api/admin/invite-codes/:code',
    { preHandler: adminOnly },
    async (request, reply) => {
      const revoked = deps.userService.revokeInviteCode(request.params.code);
      if (!revoked) return reply.code(404).send({ error: '邀请码不存在或已兑换' });
      return { ok: true };
    },
  );

  // 查看用户当前恢复码明文（ADR 0015：管理员帮用户找回账号）。
  app.get<{ Params: { id: string } }>(
    '/api/admin/users/:id/recovery-code',
    { preHandler: adminOnly },
    async (request, reply) => {
      const record = deps.userService.get(request.params.id);
      if (!record) return reply.code(404).send({ error: '用户不存在' });
      return {
        userId: record.id,
        username: record.username,
        nickname: record.nickname,
        recoveryCode: deps.userService.getRecoveryCode(record.username),
      };
    },
  );

  // 管理员兜底重置（ADR 0015：用户名与恢复码都丢了）：
  // 作废旧密码与旧恢复码，一次性返回新凭据转交给用户。
  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/reset',
    { preHandler: adminOnly },
    async (request, reply) => {
      const bundle = deps.userService.adminResetPassword(request.params.id);
      if (!bundle) return reply.code(404).send({ error: '用户不存在' });
      return bundle;
    },
  );

  // 角色：提升 / 降级（单角色体系，ADR 0015）。
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/admin/users/:id/role',
    { preHandler: adminOnly },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body.role !== 'user' && body.role !== 'admin') {
        return reply.code(400).send({ error: 'role 必须是 user 或 admin' });
      }
      const result = deps.userService.setRole(request.params.id, body.role);
      if (result === null) return reply.code(404).send({ error: '用户不存在' });
      return { userId: request.params.id, role: body.role };
    },
  );

  // 封禁 / 解封（ADR 0015：封禁用户无法登录、数据保留）。
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/admin/users/:id/ban',
    { preHandler: adminOnly },
    async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.banned !== 'boolean') {
        return reply.code(400).send({ error: 'banned 必须是布尔值' });
      }
      const result = deps.userService.setBanned(request.params.id, body.banned);
      if (result === null) return reply.code(404).send({ error: '用户不存在' });
      return { userId: request.params.id, banned: body.banned };
    },
  );

  // 用户参赛对象明细（含已归档；管理端展开用）。
  app.get<{ Params: { id: string } }>(
    '/api/admin/users/:id/entrants',
    { preHandler: adminOnly },
    async (request, reply) => {
      const record = deps.userService.get(request.params.id);
      if (!record) return reply.code(404).send({ error: '用户不存在' });
      const entrants = deps.entrantService.listAllByUser(record.id);
      return {
        userId: record.id,
        entrants: entrants.map((e) => ({
          id: e.id,
          gameId: e.gameId,
          name: e.name,
          appearance: e.appearance,
          createdAt: e.createdAt,
          archivedAt: e.archivedAt,
        })),
      };
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
