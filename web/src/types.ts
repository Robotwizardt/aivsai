/** 与后端 API 对应的数据形状（见 server/src/app.ts 与各 service）。 */

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
  entrants: ReadonlyArray<{ entrantId: string; strategyVersionId?: string }>;
  kind: MatchKind;
  createdAt: number;
  phase: MatchPhase;
  result: MatchResult | null;
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

/** 坦克大战观众帧 state（server/src/games/tank/tank-game.ts TankGameState）。 */
export interface TankGameState {
  tick: number;
  arena: { width: number; height: number };
  tanks: ReadonlyArray<{
    x: number;
    y: number;
    direction: number;
    hp: number;
    cooldown: number;
  }>;
  bullets: ReadonlyArray<{ x: number; y: number; direction: number; owner: 0 | 1 }>;
  walls: string[];
  events: ReadonlyArray<{
    tick: number;
    target: 0 | 1;
    source: 0 | 1;
    damage: number;
    x: number;
    y: number;
  }>;
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
    Array.isArray(v.bullets) &&
    Array.isArray(v.walls)
  );
}
