/** 与后端 API 对应的数据形状（见 server/src/app.ts 与各 service）。 */

/** GET /api/agent/context 响应（形状可能演进，多余字段容忍）。 */
export interface AgentContext {
  game?: string;
  /** 后端返回 { id, name, description }（server/src/app.ts）；旧形状 botId 仍兼容。 */
  bots?: Array<string | { id?: string; botId?: string; name?: string; description?: string }>;
  [key: string]: unknown;
}

export interface GameInfo {
  id: string;
  name: string;
  pacing: 'instant' | 'turn-based';
}

/** 兑换邀请码 / 恢复凭证成功时一次性返回的明文凭据。 */
export interface CredentialBundle {
  workspaceId: string;
  credential: string;
  recoveryCode: string;
}

export interface LeaderboardEntry {
  entrantId: string;
  score: number;
  wins: number;
  losses: number;
  draws: number;
}

export type MatchPhase = 'queued' | 'running' | 'finished' | 'invalid';
export type MatchKind = 'official' | 'training';

export interface MatchOutcome {
  kind: 'win' | 'draw' | 'invalid';
  reason: string;
  /** kind === 'win' 时的胜方（0/1）。 */
  winner?: 0 | 1;
}

export interface MatchResult {
  outcome: MatchOutcome;
  failures?: ReadonlyArray<{ entrant: 0 | 1; message: string }>;
}

/** 对局摘要：GET /api/matches/:id 与 GET /api/matches 列表条目。 */
export interface MatchSummary {
  matchId: string;
  gameId: string;
  gameVersionId: string;
  /** 双方参赛对象；name 为坦克名（bot:xxx 为内置基准名），可能为 null；appearance 为自选外观（bot 为 null）。 */
  entrants: ReadonlyArray<{
    entrantId: string;
    strategyVersionId?: string;
    name: string | null;
    appearance: { color: string; preset: string } | null;
  }>;
  kind: MatchKind;
  createdAt: number;
  phase: MatchPhase;
  result: MatchResult | null;
}

/** GET /api/matches 分页响应。 */
export interface MatchListPage {
  matches: MatchSummary[];
  page: number;
  pageSize: number;
  total: number | undefined;
}

export interface Appearance {
  preset: string;
  color: string;
  name: string;
  customImageUrl?: string;
}

export interface Entrant {
  id: string;
  gameId: string;
  name: string;
  appearance: Appearance;
  createdAt: number;
}

export interface StrategyVersion {
  versionId: number;
  publicVisible: boolean;
  createdAt: number;
  source: string;
}

export interface PublishResult {
  entrantId: string;
  versionId: number;
  publicVisible: boolean;
  createdAt: number;
}

export interface StartMatchResult {
  matchId: string;
  summary: MatchSummary | null;
}

/** 观众帧快照（FrameSnapshot）。 */
export interface FrameSnapshot {
  tick: number;
  state: unknown;
}

/** 坦克大战观众帧 state（server/src/games/tank/tank-game.ts TankGameState，v2）。
 * v2 新增 terrain/star/bubbles/tank.stars；旧回放缺这些字段也能渲染（walls 兼容）。 */
export interface TankStateV2 {
  x: number;
  y: number;
  direction: number;
  hp: number;
  cooldown: number;
  /** 已收集星星数（v2）。 */
  stars?: number;
}

export interface TankTerrain {
  /** 墙（"x,y" 集合，不可摧毁）。 */
  walls: string[];
  /** 土堆（"x,y" 集合，可被子弹摧毁）。 */
  mounds: string[];
  /** 草（"x,y" 集合，站上去对敌方隐身）。 */
  grass: string[];
}

export interface TankBubble {
  side: 0 | 1;
  text: string;
  tick: number;
}

export interface TankGameState {
  tick: number;
  arena: { width: number; height: number };
  tanks: ReadonlyArray<TankStateV2>;
  bullets: ReadonlyArray<{ x: number; y: number; direction: number; owner: 0 | 1 }>;
  /** v1 旧字段：墙集合（存在旧 state 时当墙渲染）。 */
  walls?: string[];
  /** v2：地形（墙/土堆/草）。 */
  terrain?: TankTerrain;
  /** v2：星星位置（null = 当前无星）。 */
  star?: { x: number; y: number } | null;
  events?: ReadonlyArray<{
    tick: number;
    target: 0 | 1;
    source: 0 | 1;
    damage: number;
    x: number;
    y: number;
  }>;
  /** v2：最近的发言气泡。 */
  bubbles?: ReadonlyArray<TankBubble>;
}

export function isTankGameState(value: unknown): value is TankGameState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const arena = v.arena as { width?: unknown; height?: unknown } | undefined;
  return (
    typeof v.tick === 'number' &&
    typeof arena === 'object' &&
    arena !== null &&
    typeof arena.width === 'number' &&
    typeof arena.height === 'number' &&
    Array.isArray(v.tanks) &&
    Array.isArray(v.bullets)
  );
}

/** POST /api/agent/simulate 响应（快速试跑）。 */
export interface SimulateResult {
  outcome: {
    kind: 'win' | 'draw' | 'invalid';
    /** 'self' = 我方胜，'opponent' = 对方胜。 */
    winner?: 'self' | 'opponent';
    reason: string;
  };
  ticks: number;
  frames: FrameSnapshot[];
  selfStats: { hp: number; stars: number } | Record<string, unknown>;
  opponentStats: { hp: number; stars: number } | Record<string, unknown>;
  selfName: string;
  opponentName: string;
  logs: { self: string[]; opponent: string[] };
}
