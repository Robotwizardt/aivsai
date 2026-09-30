/**
 * API 客户端：fetch 封装 + localStorage 凭证（workspace credential）。
 * 所有请求带 Authorization: Bearer <credential>；错误统一抛 ApiError（{error} 文本）。
 *
 * 帧流说明（ADR 0002）：
 * - official 对局的 /api/matches/:id/frames 观众无需凭证 → 用 EventSource；
 * - training 对局需要 Bearer 凭证（EventSource 不支持自定义 header）
 *   → openFramesStream 内部改用 fetch + ReadableStream 手写 SSE，
 *   失败（非流式响应/网络错误）时退化为轮询 GET /api/matches/:id。
 */

import {
  AgentContext,
  CredentialBundle,
  Entrant,
  FrameSnapshot,
  GameInfo,
  LeaderboardEntry,
  MatchResult,
  MatchSummary,
  PublishResult,
  SimulateResult,
  StartMatchResult,
  StrategyVersion,
} from './types';

const CREDENTIAL_KEY = 'aivsai.credential';
const WORKSPACE_ID_KEY = 'aivsai.workspaceId';

/**
 * 本地保存的凭证种类（ADR 0002）。
 *
 * 本地只存一份凭证（KEY = aivsai.credential），来源是「兑换邀请码 / 恢复凭证」，
 * 即工作台凭证；对象凭证目前只由服务端一次性返回、不落 localStorage。
 * 因此这里非 null 即 'workspace'——保留分类是为了在页面上明确提示
 * 「交给外部 Agent 前建议换成对象凭证」，并在将来本地真的存对象凭证时
 * 只需改这一个函数。
 */
export type CredentialKind = 'workspace' | 'entrant';

export function getCredentialKind(): CredentialKind | null {
  return getCredential() === null ? null : 'workspace';
}

/** 凭证脱敏展示（保留前 4 位，其余打码）。 */
export function maskCredential(credential: string): string {
  if (credential.length <= 4) return '••••';
  return `${credential.slice(0, 4)}${'•'.repeat(Math.min(12, credential.length - 4))}`;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------- 凭证存取

export function getCredential(): string | null {
  return localStorage.getItem(CREDENTIAL_KEY);
}

export function getWorkspaceId(): string | null {
  return localStorage.getItem(WORKSPACE_ID_KEY);
}

export function saveCredential(bundle: CredentialBundle): void {
  localStorage.setItem(CREDENTIAL_KEY, bundle.credential);
  localStorage.setItem(WORKSPACE_ID_KEY, bundle.workspaceId);
  window.dispatchEvent(new Event('aivsai:credential'));
}

export function clearCredential(): void {
  localStorage.removeItem(CREDENTIAL_KEY);
  localStorage.removeItem(WORKSPACE_ID_KEY);
  window.dispatchEvent(new Event('aivsai:credential'));
}

// ---------------------------------------------------------------- fetch 封装

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const credential = getCredential();
  if (credential) headers.set('Authorization', `Bearer ${credential}`);
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

// ---------------------------------------------------------------- 工作台

export function redeemInvite(inviteCode: string, nickname?: string): Promise<CredentialBundle> {
  return post<CredentialBundle>('/api/workspaces/redeem', {
    inviteCode,
    ...(nickname !== undefined && nickname !== '' ? { nickname } : {}),
  });
}

export function resetCredential(workspaceId: string, recoveryCode: string): Promise<CredentialBundle> {
  return post<CredentialBundle>(`/api/workspaces/${encodeURIComponent(workspaceId)}/reset`, {
    recoveryCode,
  });
}

// ---------------------------------------------------------------- 公开数据

export async function listGames(): Promise<GameInfo[]> {
  const data = await request<{ games: GameInfo[] }>('/api/games');
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

export async function listMatches(gameId?: string): Promise<MatchSummary[]> {
  const query = gameId ? `?gameId=${encodeURIComponent(gameId)}` : '';
  const data = await request<{ matches: MatchSummary[] }>(`/api/matches${query}`);
  return data.matches;
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
 * POST /api/entrants/:id/credential：为参赛对象颁发（轮换）对象凭证，交给外部 Agent 托管。
 * 明文只返回一次；每次颁发都会先作废该对象此前的对象凭证。需要工作台凭证。
 */
export function issueEntrantCredential(
  entrantId: string,
): Promise<{ entrantId: string; credential: string }> {
  return post<{ entrantId: string; credential: string }>(
    `/api/entrants/${encodeURIComponent(entrantId)}/credential`,
    {},
  );
}

/** DELETE /api/entrants/:id/credential：吊销该对象全部对象凭证，取消 Agent 托管授权。 */
export function revokeEntrantCredential(entrantId: string): Promise<{ revoked: boolean }> {
  return request<{ revoked: boolean }>(`/api/entrants/${encodeURIComponent(entrantId)}/credential`, {
    method: 'DELETE',
  });
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
  code: string;
  /** 省略 = 随机对手。strategyVersionId 是版本号（后端要求整数，字符串会被 400 拒绝）。 */
  opponent?: { botId?: string; strategyVersionId?: number };
}

/** POST /api/agent/simulate：快速试跑（限流 2 秒 1 次，429）。需要参赛对象凭证。 */
export function simulate(input: SimulateInput): Promise<SimulateResult> {
  return post<SimulateResult>('/api/agent/simulate', input);
}

// ---------------------------------------------------------------- 对局

export function startMatch(input: {
  gameId: string;
  kind: 'official' | 'training';
  myEntrantId: string;
  opponentEntrantId: string;
}): Promise<StartMatchResult> {
  return post<StartMatchResult>('/api/matches', input);
}

// ---------------------------------------------------------------- 帧流

// ---------------------------------------------------------------- 管理（管理员密钥，独立于工作台凭证体系）

const ADMIN_KEY_STORAGE = 'aivsai.adminKey';

export function getAdminKey(): string | null {
  return sessionStorage.getItem(ADMIN_KEY_STORAGE);
}

export function saveAdminKey(key: string): void {
  sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
}

export function clearAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
}

/** 管理请求：Bearer 管理员密钥，不复用工作台凭证。 */
async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getAdminKey();
  if (!key) throw new ApiError('未输入管理员密钥', 401);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${key}`);
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

export interface AdminStats {
  workspaces: Array<{
    id: string;
    nickname: string | null;
    createdAt: number;
    entrantCount: number;
    strategyCount: number;
  }>;
  pendingInviteCodes: number;
  consumedInviteCodes: number;
  strategyVersions: number;
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
  kind: 'official' | 'training',
  onFrame: (frame: FrameSnapshot) => void,
  onEnd: (result: MatchResult | null) => void,
): FramesStreamHandle {
  if (kind === 'official') {
    return openEventSource(matchId, onFrame, onEnd);
  }
  // training：fetch 流式优先，异常时轮询兜底
  const controller = new AbortController();
  const pollFallback = () => pollUntilFinished(matchId, onFrame, onEnd, controller.signal);
  fetch(`/api/matches/${encodeURIComponent(matchId)}/frames`, {
    headers: getCredential() ? { Authorization: `Bearer ${getCredential()}` } : {},
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
            getCredential() ? { headers: { Authorization: `Bearer ${getCredential()}` } } : {},
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
