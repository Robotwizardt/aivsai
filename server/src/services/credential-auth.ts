/**
 * 凭证认证：从 Authorization: Bearer <token> 识别工作台凭证或对象凭证（ADR 0002）。
 *
 * - 工作台凭证授予整个工作台的管理权；对象凭证仅授权指定参赛对象。
 * - 管理员密钥（环境变量 ADMIN_KEY）与上述凭证不混用（ADR 0002）。
 * - 无状态凭证（哈希即会话）；工作台恢复时由 WorkspaceService 联动作废对象凭证。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceService } from './workspace-service.js';
import type { EntrantService } from './entrant-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 makeAuthPlugin 在 onRequest 阶段写入。 */
    auth: AuthPrincipal | null;
  }
}

/** 通过认证的主体。 */
export type AuthPrincipal =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'entrant'; entrantId: string; workspaceId: string }
  | { kind: 'admin' };

export interface AuthService {
  workspaceService: WorkspaceService;
  entrantService: EntrantService;
  /** 管理员密钥（环境变量注入，不与工作台/对象凭证混用）。 */
  adminKey?: string;
}

function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

/**
 * 识别请求凭证：工作台凭证 / 对象凭证 / 管理员密钥。
 * 无法识别返回 null（调用方负责 401）。
 */
export function authenticate(
  services: AuthService,
  request: FastifyRequest,
  _reply?: FastifyReply,
): AuthPrincipal | null {
  const token = extractBearerToken(request);
  if (!token) return null;

  if (services.adminKey && token === services.adminKey) {
    return { kind: 'admin' };
  }

  // 工作台凭证优先；对象凭证不授予整个工作台的管理权。
  const workspace = services.workspaceService.findByCredential(token);
  if (workspace) return { kind: 'workspace', workspaceId: workspace.id };

  const entrant = services.entrantService.findByCredential(token);
  if (entrant) return { kind: 'entrant', ...entrant };

  return null;
}

/**
 * Fastify 插件：decorate request.auth，并在 onRequest 阶段解析凭证。
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

/** 业务路由认证：要求工作台或对象凭证（管理员密钥不属于管理凭证体系）。 */
export function requirePrincipal() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth || auth.kind === 'admin') {
      await reply.code(401).send({ error: '未认证' });
    }
  };
}

/** 管理路由认证：要求环境变量 ADMIN_KEY 的 Bearer。 */
export function requireAdmin(services: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = extractBearerToken(request);
    if (!services.adminKey || token !== services.adminKey) {
      await reply.code(401).send({ error: '未认证' });
    }
  };
}
