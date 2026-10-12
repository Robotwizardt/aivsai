/**
 * API 客户端：fetch 封装 + localStorage 会话令牌（ADR 0015）。
 * 所有请求带 Authorization: Bearer <会话令牌>；错误统一抛 ApiError（{error} 文本）。
 *
 * 帧流说明（ADR 0002）：
 * - official 对局的 /api/matches/:id/frames 观众无需凭证 → 用 EventSource；
 * - training 对局需要 Bearer 令牌（EventSource 不支持自定义 header）
 *   → openFramesStream 内部改用 fetch + ReadableStream 手写 SSE，
 *   失败（非流式响应/网络错误）时退化为轮询 GET /api/matches/:id。
 */

import {
  AgentContext,
  Entrant,
  FrameSnapshot,
  GameInfo,
  LeaderboardEntry,
  LoginResult,
  MatchResult,
  MatchSummary,
  MatchKind,
  MatchListPage,
  PublishResult,
  RegisterResult,
  SimulateResult,
  StartMatchResult,
  StrategyVersion,
  UserInfo,
} from './types';

const TOKEN_KEY = 'aivsai.token';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------- 表演赛（ADR 0017）

/** 表演赛摘要（不含座位密钥）。 */
export interface ExhibitionSummary {
  matchId: string;
  gameId: string;
  title: string;
  creatorUserId: string;
  perMoveTimeoutMs: number;
  isPublic: boolean;
  seatNames: [string | null, string | null];
  paused: boolean;
  createdAt: number;
  voidedAt: number | null;
  finishedAt: number | null;
}

/** 创建表演赛响应：摘要 + 两个座位链接（只此一次返回密钥）。 */
export interface CreateExhibitionResult extends ExhibitionSummary {
  seatLinks: Array<{ side: 0 | 1; key: string; url: string }>;
}

/** 创建表演赛：返回两个座位链接，人发给两个外部 AI。 */
export function createExhibition(input: {
  gameId: string;
  title?: string;
  perMoveTimeoutMinutes?: number;
  isPublic?: boolean;
}): Promise<CreateExhibitionResult> {
  return post<CreateExhibitionResult>('/api/exhibitions', input);
}

/** 公开表演赛列表（直播大厅，免登录）。 */
export async function listExhibitions(): Promise<ExhibitionSummary[]> {
  const data = await request<{ exhibitions: ExhibitionSummary[] }>('/api/exhibitions');
  return data.exhibitions;
}

/** 我的表演赛（含私密与已结束）。 */
export async function listMyExhibitions(): Promise<ExhibitionSummary[]> {
  const data = await request<{ exhibitions: ExhibitionSummary[] }>('/api/exhibitions/mine');
  return data.exhibitions;
}

/** 表演赛详情（私密凭链接观战——知道 matchId 即可）。 */
export function getExhibition(matchId: string): Promise<ExhibitionSummary> {
  return request<ExhibitionSummary>(`/api/exhibitions/${encodeURIComponent(matchId)}`);
}

/** 重新查看座位密钥（创建者/管理员；对局结束后为空）。 */
export async function getSeatKeys(
  matchId: string,
): Promise<Array<{ side: 0 | 1; key: string; url: string }>> {
  const data = await request<{ seatLinks: Array<{ side: 0 | 1; key: string; url: string }> }>(
    `/api/exhibitions/${encodeURIComponent(matchId)}/seat-keys`,
  );
  return data.seatLinks;
}

/** 暂停 / 恢复（创建者或管理员）。 */
export function pauseExhibition(matchId: string): Promise<{ ok: boolean }> {
  return post(`/api/exhibitions/${encodeURIComponent(matchId)}/pause`);
}

export function resumeExhibition(matchId: string): Promise<{ ok: boolean }> {
  return post(`/api/exhibitions/${encodeURIComponent(matchId)}/resume`);
}

/** 解散（创建者或管理员；进行中则取消判负）。 */
export function dissolveExhibition(matchId: string): Promise<{ ok: boolean }> {
  return post(`/api/exhibitions/${encodeURIComponent(matchId)}/dissolve`);
}

/** 座位视角的对局状态（GET /api/seat/observe）。 */
export interface SeatObserve {
  status: 'your-turn' | 'waiting' | 'paused' | 'finished';
  side: 0 | 1;
  observation?: unknown;
  moveCount: number;
  remainingMs?: number;
  hint?: string;
  /** 游戏 ID（座位页据此分派棋盘渲染器；ADR 0018）。 */
  gameId?: string;
}

/** 看局面 / 轮到没轮到你（座位密钥鉴权，免登录）。 */
export function seatObserve(seatKey: string): Promise<SeatObserve> {
  return request<SeatObserve>('/api/seat/observe', {
    headers: { Authorization: `Bearer ${seatKey}` },
  });
}

// ---------------------------------------------------------------- 会话令牌存取

/** 本地保存的登录态：会话令牌（ADR 0015，替代旧体系的整体凭证）。 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  window.dispatchEvent(new Event('aivsai:credential'));
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('aivsai:credential'));
}

// ---------------------------------------------------------------- fetch 封装

/**
 * 本地令牌已失效（服务端不认）时的自救。
 *
 * 会话令牌存在服务端数据库：密码被重置/管理员强制下线后旧令牌必然失效，
 * 而浏览器 localStorage 里还留着上一轮的令牌。结果是每个请求都 401，页面显示"未认证"
 * 却不说为什么，用户无法自救。这里在 401 时直接清掉本地令牌，让 UI 回到
 * "未登录、去登录"的状态，并留一句解释。
 */
function onUnauthorized(): void {
  if (getToken() === null) return;
  clearToken();
  unauthorizedNotice =
    '登录已失效（密码被重置、在其他设备退出，或管理员强制下线）。请重新登录。';
}

/** 令牌失效的一次性说明（读取后清空）。 */
let unauthorizedNotice: string | null = null;

export function takeUnauthorizedNotice(): string | null {
  const notice = unauthorizedNotice;
  unauthorizedNotice = null;
  return notice;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // 显式传入的 Authorization（如座位密钥）优先。
  // 座位请求是免登录协议：本地会话令牌不得顶掉座位密钥，更不能因密钥无效而清掉登录态。
  const hasExplicitAuth = headers.has('Authorization');
  const token = getToken();
  if (token !== null && !hasExplicitAuth) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('网络错误：无法连接服务器', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应（如 204）容忍
  }
  if (!res.ok) {
    // 带会话令牌却被判 401：本地令牌已失效。
    // 排除两种情形：管理路由用的是管理员会话；座位路由带的是自己的密钥（与登录态无关）。
    if (res.status === 401 && token !== null && !hasExplicitAuth && !path.startsWith('/api/admin')) {
      onUnauthorized();
    }
    const message =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

// ---------------------------------------------------------------- 账号（ADR 0015）

/** 注册：邀请码 + 用户名 + 密码；一次性返回恢复码（只显示一次）。 */
export function register(input: {
  inviteCode: string;
  username: string;
  password: string;
  nickname?: string;
}): Promise<RegisterResult> {
  return post<RegisterResult>('/api/auth/register', input);
}

/** 登录：签发会话令牌并存入本浏览器。 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const result = await post<LoginResult>('/api/auth/login', { username, password });
  saveToken(result.token);
  return result;
}

/** 登出：吊销当前会话令牌并清除本地保存。 */
export async function logout(): Promise<void> {
  try {
    await post('/api/auth/logout');
  } catch {
    // 服务端吊销失败不阻塞本地退出
  }
  clearToken();
}

/** 凭恢复码自助重置密码（旧会话全部吊销，恢复码轮换）。 */
export function resetPassword(input: {
  username: string;
  recoveryCode: string;
  newPassword: string;
}): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/api/auth/reset-password', input);
}

/** 当前用户自信息（昵称、角色等）。 */
export function getUserMe(): Promise<UserInfo> {
  return request<UserInfo>('/api/users/me');
}

/** 改昵称（展示用，不要求唯一）。 */
export function renameUser(nickname: string): Promise<{ userId: string; nickname: string | null }> {
  return post<{ userId: string; nickname: string | null }>('/api/users/me/nickname', { nickname });
}

// ---------------------------------------------------------------- 公开数据

/** GET /api/games 公开返回的内置基准 bot。 */
export interface GameBotInfo {
  id: string;
  name: string;
  description: string;
}

export async function listGames(): Promise<GameInfo[]> {
  const data = await request<{ games: Array<GameInfo & { bots: GameBotInfo[] }> }>('/api/games');
  return data.games;
}

/** 表演赛可用游戏（含 exhibitionOnly 游戏，如象棋；ADR 0018）。 */
export async function listExhibitionGames(): Promise<GameInfo[]> {
  const data = await request<{ games: GameInfo[] }>('/api/exhibitions/games');
  return data.games;
}

export async function getLeaderboard(gameId: string): Promise<{ gameVersionId: string; entries: LeaderboardEntry[] }> {
  return request<{ gameVersionId: string; entries: LeaderboardEntry[] }>(
    `/api/leaderboard/${encodeURIComponent(gameId)}`,
  );
}

export function getMatch(id: string): Promise<MatchSummary> {
  return request<MatchSummary>(`/api/matches/${encodeURIComponent(id)}`);
}

/** 分页拉取对局列表（最新在前）。page 从 1 起。kind 只看正式/训练；entrantId 只看某坦克参战的。 */
export async function listMatches(
  gameId: string | undefined,
  page = 1,
  pageSize = 20,
  extra?: { kind?: 'official' | 'training'; entrantId?: string },
): Promise<MatchListPage> {
  const params = new URLSearchParams();
  if (gameId) params.set('gameId', gameId);
  if (extra?.kind) params.set('kind', extra.kind);
  if (extra?.entrantId) params.set('entrantId', extra.entrantId);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return request<MatchListPage>(`/api/matches?${params.toString()}`);
}

// ---------------------------------------------------------------- 参赛对象与策略

export async function listMyEntrants(): Promise<Entrant[]> {
  const data = await request<{ entrants: Entrant[] }>('/api/entrants');
  return data.entrants;
}

export function createEntrant(input: {
  gameId: string;
  name: string;
  appearance: { preset: string; color: string; name: string };
}): Promise<Entrant> {
  return post<Entrant>('/api/entrants', input);
}

export function publishStrategy(
  entrantId: string,
  source: string,
  publicVisible: boolean,
): Promise<PublishResult> {
  return post<PublishResult>(`/api/entrants/${encodeURIComponent(entrantId)}/strategies/publish`, {
    source,
    publicVisible,
  });
}

/**
 * POST /api/entrants/:id/credential：为参赛对象颁发（轮换）API 令牌，交给外部 Agent 托管。
 * 服务端哈希 + 明文本份都存库，令牌持有者可通过 GET /api/entrants/:id/credential 随时取回。
 * 每次颁发都会先作废该对象此前的 API 令牌。需要登录会话。
 */
export function issueEntrantCredential(
  entrantId: string,
): Promise<{ entrantId: string; credential: string }> {
  return post<{ entrantId: string; credential: string }>(
    `/api/entrants/${encodeURIComponent(entrantId)}/credential`,
    {},
  );
}

/** GET /api/entrants/:id/credential-status：查询是否已有活跃 API 令牌（有则 UI 提示"重新颁发"）。 */
export function getEntrantCredentialStatus(
  entrantId: string,
): Promise<{ entrantId: string; hasCredential: boolean }> {
  return request<{ entrantId: string; hasCredential: boolean }>(
    `/api/entrants/${encodeURIComponent(entrantId)}/credential-status`,
  );
}

/**
 * GET /api/entrants/:id/credential：取回该参赛对象当前 API 令牌的明文。
 * 只有登录会话可调用；未颁发过 → null。
 */
export function getEntrantCredential(
  entrantId: string,
): Promise<{ entrantId: string; credential: string } | null> {
  return request<{ entrantId: string; credential: string }>(
    `/api/entrants/${encodeURIComponent(entrantId)}/credential`,
  ).catch(() => null);
}

/** DELETE /api/entrants/:id/credential：吊销该参赛对象全部 API 令牌，取消 Agent 托管授权。 */
export function revokeEntrantCredential(entrantId: string): Promise<{ revoked: boolean }> {
  return request<{ revoked: boolean }>(`/api/entrants/${encodeURIComponent(entrantId)}/credential`, {
    method: 'DELETE',
  });
}

/**
 * DELETE /api/entrants/:id：归档（删除）参赛对象，不可恢复。
 * 只有登录会话可以删除（API 令牌会得到 401）。归档后该对象从列表/匹配池/排行榜移除，
 * API 令牌被吊销；历史对局与回放完整保留。
 * 用当前登录会话调用（与其他 /api/entrants 调用同一口径），失败统一抛 ApiError。
 */
export function deleteEntrant(entrantId: string): Promise<{ entrantId: string; archived: true }> {
  return request<{ entrantId: string; archived: true }>(
    `/api/entrants/${encodeURIComponent(entrantId)}`,
    { method: 'DELETE' },
  );
}

export async function listStrategies(entrantId: string): Promise<StrategyVersion[]> {
  const data = await request<{ versions: StrategyVersion[] }>(
    `/api/entrants/${encodeURIComponent(entrantId)}/strategies`,
  );
  return data.versions;
}

// ---------------------------------------------------------------- Agent 试跑

/** GET /api/agent/context：策略开发上下文（含内置 bot 列表）。失败时调用方应回退占位列表。 */
export async function getAgentContext(): Promise<AgentContext> {
  return request<AgentContext>('/api/agent/context');
}

export interface SimulateInput {
  /** 用哪个参赛对象试跑；名下有多个对象时必传（后端多对象时不传会 400）。 */
  entrantId?: string;
  code: string;
  /** 省略 = 随机对手。strategyVersionId 是版本号（后端要求整数，字符串会被 400 拒绝）。 */
  opponent?: { botId?: string; strategyVersionId?: number };
}

/** POST /api/agent/simulate：快速试跑（限流 2 秒 1 次，429）。需要参赛对象的 API 令牌。 */
export function simulate(input: SimulateInput): Promise<SimulateResult> {
  return post<SimulateResult>('/api/agent/simulate', input);
}

// ---------------------------------------------------------------- 对局

/**
 * 构造发起对局的对手字段（ADR 0006）。
 * official：不传任何对手字段（后端随机匹配），传入会被 400；
 * training：二选一（内置 bot 或粘贴的坦克 ID）。
 */
export function buildOpponentPayload(
  kind: MatchKind,
  mode: 'bot' | 'entrant',
  botId: string,
  entrantId: string,
): { opponentBotId?: string; opponentEntrantId?: string } {
  if (kind === 'official') return {};
  return mode === 'bot' ? { opponentBotId: botId } : { opponentEntrantId: entrantId.trim() };
}

export function startMatch(input: {
  gameId: string;
  kind: MatchKind;
  myEntrantId: string;
  /** 仅 training：与 opponentBotId 二选一（粘贴任意坦克 ID）。official 不可传。 */
  opponentEntrantId?: string;
  /** 仅 training：与 opponentEntrantId 二选一（内置基准 bot）。official 不可传。 */
  opponentBotId?: string;
}): Promise<StartMatchResult> {
  return post<StartMatchResult>('/api/matches', input);
}

// ---------------------------------------------------------------- 帧流

// ---------------------------------------------------------------- 管理（admin 角色的会话令牌，ADR 0015）

/** 管理请求：Bearer 当前会话令牌（需要 admin 角色；服务端校验）。 */
async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError('未登录', 401);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('网络错误：无法连接服务器', 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 容忍非 JSON 响应
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export interface AdminMatchStats {
  /** 对局总数。 */
  total: number;
  /** 进行中（queued/running）。 */
  live: number;
  /** 正式对局数。 */
  official: number;
  /** 训练对局数。 */
  training: number;
}

export interface AdminUserDetail {
  id: string;
  username: string;
  nickname: string | null;
  role: 'user' | 'admin';
  banned: boolean;
  createdAt: number;
  /** 在役参赛对象数（归档即释放配额）。 */
  entrantCount: number;
  /** 已归档（已删除）的参赛对象数。 */
  archivedEntrantCount: number;
  strategyCount: number;
  /** 当前活跃会话数。 */
  sessionCount: number;
}

export interface AdminStats {
  pendingInviteCodes: number;
  consumedInviteCodes: number;
  strategyVersions: number;
  /** 全平台在役参赛对象总数。 */
  entrantCount: number;
  /** 全平台已归档参赛对象总数。 */
  archivedEntrantCount: number;
  /** 用户明细。 */
  users: AdminUserDetail[];
  /** 对局统计。 */
  matchStats: AdminMatchStats;
}

export function getAdminStats(): Promise<AdminStats> {
  return adminRequest<AdminStats>('/api/admin/stats');
}

export function listPendingInviteCodes(): Promise<{ codes: string[] }> {
  return adminRequest<{ codes: string[] }>('/api/admin/invite-codes');
}

export function createInviteCode(code: string): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>('/api/admin/invite-codes', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

/** DELETE /api/admin/invite-codes/:code：撤销未兑换邀请码（已兑换的不可撤回，404）。 */
export function revokeInviteCode(code: string): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>(`/api/admin/invite-codes/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
}

/** GET /api/admin/users/:id/recovery-code：查看当前恢复码明文。 */
export function getUserRecoveryCode(
  userId: string,
): Promise<{ userId: string; username: string; nickname: string | null; recoveryCode: string | null }> {
  return adminRequest<{
    userId: string;
    username: string;
    nickname: string | null;
    recoveryCode: string | null;
  }>(`/api/admin/users/${encodeURIComponent(userId)}/recovery-code`);
}

/**
 * POST /api/admin/users/:id/reset：管理员兜底重置（用户名与恢复码都丢了）：
 * 作废旧密码与旧恢复码，一次性返回新凭据转交给用户。
 */
export function adminResetUserPassword(
  userId: string,
): Promise<{ userId: string; newPassword: string; recoveryCode: string }> {
  return adminRequest<{ userId: string; newPassword: string; recoveryCode: string }>(
    `/api/admin/users/${encodeURIComponent(userId)}/reset`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/** POST /api/admin/users/:id/role：提升/降级角色（单角色体系）。 */
export function setUserRole(userId: string, role: 'user' | 'admin'): Promise<{ userId: string; role: string }> {
  return adminRequest<{ userId: string; role: string }>(
    `/api/admin/users/${encodeURIComponent(userId)}/role`,
    { method: 'POST', body: JSON.stringify({ role }) },
  );
}

/** POST /api/admin/users/:id/ban：封禁（无法登录、数据保留）/解封。 */
export function setUserBanned(userId: string, banned: boolean): Promise<{ userId: string; banned: boolean }> {
  return adminRequest<{ userId: string; banned: boolean }>(
    `/api/admin/users/${encodeURIComponent(userId)}/ban`,
    { method: 'POST', body: JSON.stringify({ banned }) },
  );
}

/** 管理端参赛对象明细（含已归档）。 */
export interface AdminEntrantDetail {
  id: string;
  gameId: string;
  name: string;
  appearance: { preset: string; color: string; name: string };
  createdAt: number;
  /** 归档（删除）时间，null 表示在役。 */
  archivedAt: number | null;
}

/** GET /api/admin/users/:id/entrants：用户参赛对象明细（含已归档）。 */
export function listUserEntrants(
  userId: string,
): Promise<{ userId: string; entrants: AdminEntrantDetail[] }> {
  return adminRequest<{ userId: string; entrants: AdminEntrantDetail[] }>(
    `/api/admin/users/${encodeURIComponent(userId)}/entrants`,
  );
}

// ---------------------------------------------------------------- 帧流（续）

export interface FramesStreamHandle {
  /** 停止接收（关闭 SSE / 停止轮询）。 */
  close(): void;
}

/**
 * 订阅对局帧流：
 * - official：EventSource（观众无需凭证）；
 * - training：优先 fetch 流式 SSE（带 Bearer），失败退化为轮询对局摘要。
 *
 * 对局已结束（end 事件）或摘要轮询到 finished/invalid 时调用 onEnd(result)。
 */
export function openFramesStream(
  matchId: string,
  kind: MatchKind,
  onFrame: (frame: FrameSnapshot) => void,
  onEnd: (result: MatchResult | null) => void,
): FramesStreamHandle {
  // official 与 exhibition 都是公开 SSE（观众免登录；ADR 0017 私密表演赛凭 matchId 观战）。
  if (kind === 'official' || kind === 'exhibition') {
    return openEventSource(matchId, onFrame, onEnd);
  }
  // training：fetch 流式优先，异常时轮询兜底
  const controller = new AbortController();
  const pollFallback = () => pollUntilFinished(matchId, onFrame, onEnd, controller.signal);
  fetch(`/api/matches/${encodeURIComponent(matchId)}/frames`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        pollFallback();
        return;
      }
      await consumeSseStream(res.body, onFrame, onEnd);
    })
    .catch(() => {
      if (!controller.signal.aborted) pollFallback();
    });
  return {
    close() {
      controller.abort();
    },
  };
}

function openEventSource(
  matchId: string,
  onFrame: (frame: FrameSnapshot) => void,
  onEnd: (result: MatchResult | null) => void,
): FramesStreamHandle {
  const es = new EventSource(`/api/matches/${encodeURIComponent(matchId)}/frames`);
  let ended = false;
  const finish = (result: MatchResult | null) => {
    if (ended) return;
    ended = true;
    es.close();
    onEnd(result);
  };
  es.addEventListener('frame', (ev) => {
    try {
      onFrame(JSON.parse((ev as MessageEvent).data as string) as FrameSnapshot);
    } catch {
      // 忽略坏帧
    }
  });
  es.addEventListener('end', (ev) => {
    try {
      finish(JSON.parse((ev as MessageEvent).data as string) as MatchResult);
    } catch {
      finish(null);
    }
  });
  es.onerror = () => {
    // 服务器关闭流（对局结束）或网络故障：轮询摘要确认终态
    es.close();
    if (!ended) pollUntilFinished(matchId, onFrame, onEnd, new AbortController().signal);
  };
  return {
    close() {
      ended = true;
      es.close();
    },
  };
}

/** 逐行解析 text/event-stream：event: <name>\ndata: <json>\n\n */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: FrameSnapshot) => void,
  onEnd: (result: MatchResult | null) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = rawEvent.split('\n');
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      if (eventName === 'frame') onFrame(payload as FrameSnapshot);
      else if (eventName === 'end') {
        onEnd(payload as MatchResult);
        return;
      }
    }
  }
  // 流意外结束（服务器关闭）：交由调用方或上层轮询兜底
}

/** 轮询 GET /api/matches/:id 直到 finished/invalid，然后一次性拉帧回放。 */
function pollUntilFinished(
  matchId: string,
  onFrame: (frame: FrameSnapshot) => void,
  onEnd: (result: MatchResult | null) => void,
  signal: AbortSignal,
): void {
  let stopped = false;
  const tick = async () => {
    if (stopped || signal.aborted) return;
    try {
      const summary = await getMatch(matchId);
      if (summary.phase === 'finished' || summary.phase === 'invalid') {
        // 拉全部帧做“回放”式逐帧推送（帧流接口带 fromTick=0 也可以）
        try {
          const res = await fetch(
            `/api/matches/${encodeURIComponent(matchId)}/frames?fromTick=0`,
            getToken() ? { headers: { Authorization: `Bearer ${getToken()}` } } : {},
          );
          if (res.ok && res.body) {
            await consumeSseStream(res.body, onFrame, () => undefined);
          }
        } catch {
          // 回放拉取失败不阻塞结果展示
        }
        stopped = true;
        onEnd(summary.result);
        return;
      }
    } catch {
      // 轮询失败（403 训练不公开等）：继续重试
    }
    setTimeout(tick, 1000);
  };
  void tick();
  // 轮询靠 signal 控制生命周期（abort 后自行退出）
}

/**
 * 复制文本到剪贴板（HTTP 裸 IP 部署下 navigator.clipboard 不可用，需降级）。
 *
 * 三层策略：
 * 1. navigator.clipboard.writeText（仅安全上下文：HTTPS / localhost）；
 * 2. 隐藏 textarea + execCommand('copy')（HTTP 下多数浏览器仍可用）；
 * 3. 都失败则把文本塞进传入的 textarea 并全选，用户按 Ctrl+C 即可。
 *
 * 返回 true 表示已复制进剪贴板；false 表示已选中文本待用户手动复制。
 */
export async function copyTextToClipboard(
  text: string,
  fallbackTarget?: HTMLTextAreaElement | null,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文 / 权限被拒：走降级
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    // 继续降级
  }
  if (fallbackTarget) {
    fallbackTarget.value = text;
    fallbackTarget.style.display = '';
    fallbackTarget.focus();
    fallbackTarget.select();
  }
  return false;
}
