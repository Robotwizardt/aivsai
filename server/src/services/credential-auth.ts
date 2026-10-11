/**
 * 认证：从 Authorization: Bearer <token> 识别会话令牌或 API 令牌（ADR 0015/0016）。
 *
 * - 会话令牌（人）：登录签发，授予账号全部权限；admin 角色附加管理权。
 * - API 令牌（外部 Agent）：仅授权指定参赛对象（原「对象凭证」，ADR 0016）。
 * - 座位密钥（表演赛，ADR 0017）由表演赛路由自行解析，不在此列。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserService } from './user-service.js';
import type { EntrantService } from './entrant-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 makeAuthPlugin 在 onRequest 阶段写入。 */
    auth: AuthPrincipal | null;
  }
}

/** 通过认证的主体。 */
export type AuthPrincipal =
  | { kind: 'user'; userId: string; role: 'user' | 'admin' }
  | { kind: 'entrant'; entrantId: string; userId: string };

export interface AuthService {
  userService: UserService;
  /** 缺省时跳过 API 令牌识别（表演赛等不需要参赛对象服务的调用方）。 */
  entrantService?: EntrantService;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

export { extractBearerToken };

/**
 * 识别请求凭据：会话令牌 / API 令牌。
 * 无法识别返回 null（调用方负责 401）。
 */
export function authenticate(
  services: AuthService,
  request: FastifyRequest,
  _reply?: FastifyReply,
): AuthPrincipal | null {
  const token = extractBearerToken(request);
  if (!token) return null;

  // 会话令牌优先；API 令牌不授予账号级权限。
  const user = services.userService.findBySessionToken(token);
  if (user) return { kind: 'user', userId: user.id, role: user.role };

  const entrant = services.entrantService?.findByCredential(token);
  if (entrant) return { kind: 'entrant', ...entrant };

  return null;
}

/**
 * Fastify 插件：decorate request.auth，并在 onRequest 阶段解析凭据。
 * 具体路由再用 requirePrincipal / requireAdmin 做 401 拦截。
 */
export function makeAuthPlugin(services: AuthService) {
  return async function authPlugin(fastify: FastifyInstance): Promise<void> {
    fastify.decorateRequest('auth', null);
    fastify.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
      request.auth = authenticate(services, request);
    });
  };
}

/** 业务路由认证：要求会话令牌或 API 令牌。 */
export function requirePrincipal() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.auth === null) {
      await reply.code(401).send({ error: '未认证' });
    }
  };
}

/** 管理路由认证：要求 admin 角色的会话令牌（ADR 0015）。 */
export function requireAdmin() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth || auth.kind !== 'user' || auth.role !== 'admin') {
      await reply.code(401).send({ error: '需要管理员权限' });
    }
  };
}
