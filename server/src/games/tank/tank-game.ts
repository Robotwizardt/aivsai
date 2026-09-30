/**
 * 坦克大战游戏包（1v1 即时制，ADR 0001：坦克是首个游戏包）。
 *
 * 规则摘要：
 * - 20x15 网格；固定种子伪随机（mulberry32）生成双方对称的墙块布局，
 *   中央走廊（y=7）保持畅通，双方出生点 (2,7) 朝东 / (17,7) 朝西，HP 100；
 * - 子弹每 tick 前进一格，命中伤害 34，开火冷却 8 tick；
 * - 每方行动：{ move: 'forward'|'back'|'left'|'right'|'none', turn?: 0..3, fire?: boolean }，
 *   move 的 left/right 为沿车身左右平移一格（不改朝向）；
 *   turn 为目标朝向（0=北 1=东 2=南 3=西），每 tick 顺时针旋转 90 度一步；
 * - 非法行动值一律视为 no-op；
 * - 观察只含自己视角（buildTankObservation）；观众帧 state 为完整信息；
 * - 300 tick 上限；HP 先归零者负，双方同亡平局，超时按 HP 判定，HP 相同平局；
 * - 策略抛错或返回 { kind: 'error' }：该 tick 不行动，累计 3 次判负。
 *
 * 简化（相对完整坦克玩法）：无草丛/隐蔽、无技能、墙不可摧毁、
 * 子弹不区分敌我（弹道远离发射者，实际不会自伤）、命中伤害固定无散布。
 */

import type {
  EntrantHandle,
  FrameSnapshot,
  GameDefinition,
  GameInstance,
  GamePackage,
  MatchResult,
} from '../contracts.js';

// ---------------------------------------------------------------- 常量

const WIDTH = 20;
const HEIGHT = 15;
const MAX_TICKS = 300;
const INITIAL_HP = 100;
const BULLET_DAMAGE = 34;
const FIRE_COOLDOWN_TICKS = 8;
const MAX_STRATEGY_ERRORS = 3;
const WALL_DENSITY = 0.22;
const CENTER_ROW = HEIGHT >> 1; // 7：中央走廊行，保持无墙
const MAX_EVENTS = 30;

/** 方向：0=北 1=东 2=南 3=西（顺时针）；北为 y-1。 */
const DIRS: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

function dirVec(dir: number): { dx: number; dy: number } {
  return DIRS[((dir % 4) + 4) % 4]!;
}

const SIDES = [0, 1] as const;
type Side = 0 | 1;

/** 出生点关于地图中轴对称。 */
const SPAWNS: readonly [
  { x: number; y: number; direction: number },
  { x: number; y: number; direction: number },
] = [
  { x: 2, y: CENTER_ROW, direction: 1 },
  { x: WIDTH - 3, y: CENTER_ROW, direction: 3 },
];

const TANK_DEFINITION: GameDefinition = {
  id: 'tank',
  name: '坦克大战',
  pacing: 'instant',
  actionNames: ['move', 'turn', 'fire'],
};

// ---------------------------------------------------------------- 伪随机

/** mulberry32：固定种子的确定性伪随机，同 seed 同序列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 matchId 派生 32 位种子（FNV-1a）：同场可复现、不同场多样。 */
export function deriveSeedFromMatchId(matchId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- 状态类型

export interface TankState {
  x: number;
  y: number;
  /** 0=北 1=东 2=南 3=西。 */
  direction: number;
  hp: number;
  /** 距下次可开火剩余 tick。 */
  cooldown: number;
}

export interface BulletState {
  x: number;
  y: number;
  direction: number;
  owner: 0 | 1;
}

export interface TankHitEvent {
  tick: number;
  /** 被命中方。 */
  target: 0 | 1;
  /** 开火方。 */
  source: 0 | 1;
  damage: number;
  x: number;
  y: number;
}

/** 观众帧中的完整战场状态（渲染层直接使用，不隐藏信息）。 */
export interface TankGameState {
  tick: number;
  arena: { width: number; height: number };
  tanks: [TankState, TankState];
  bullets: BulletState[];
  /** "x,y" 字符串集合（已排序）。 */
  walls: string[];
  /** 最近的命中事件（新事件在末尾）。 */
  events: TankHitEvent[];
}

/** 单方视角的观察数据（敌方仅有直线视线时可见）。 */
export interface TankObservation {
  tick: number;
  arena: { width: number; height: number };
  self: { x: number; y: number; direction: number; hp: number; cooldown: number };
  enemy: { x: number; y: number; direction: number; hp: number } | null;
  /** 最近（最多 5 条）自己被命中的事件。 */
  hitEvents: TankHitEvent[];
}

export interface TankInstanceOptions {
  /** 伪随机种子；平台应传由 matchId 哈希派生的值（见 deriveSeedFromMatchId）。 */
  seed?: number;
}

// ---------------------------------------------------------------- 行动解析

type TankMove = 'forward' | 'back' | 'left' | 'right' | 'none';

interface TankAction {
  move: TankMove | null;
  turn: 0 | 1 | 2 | 3 | null;
  fire: boolean;
}

const NOOP: TankAction = { move: null, turn: null, fire: false };
const VALID_MOVES = new Set<string>(['forward', 'back', 'left', 'right', 'none']);

/** 非法/缺失字段一律 no-op，不视为策略错误。 */
function parseAction(value: unknown): TankAction {
  if (typeof value !== 'object' || value === null) return NOOP;
  const v = value as Record<string, unknown>;
  const move = typeof v.move === 'string' && VALID_MOVES.has(v.move) ? (v.move as TankMove) : null;
  const turn =
    typeof v.turn === 'number' && Number.isInteger(v.turn) && v.turn >= 0 && v.turn <= 3
      ? (v.turn as 0 | 1 | 2 | 3)
      : null;
  const fire = v.fire === true;
  return { move, turn, fire };
}

/** act 返回值形如 StrategyStepResult 的 error 分支。 */
function isStrategyErrorResult(value: unknown): value is { kind: 'error'; message?: unknown } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'error';
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

// ---------------------------------------------------------------- 地图生成

function nearSpawn(x: number, y: number): boolean {
  for (const s of SPAWNS) {
    if (Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) <= 2) return true;
  }
  return false;
}

/** 左半随机撒墙，镜像到右半，保证双方对称；中央走廊与出生点周边留空。 */
function generateWalls(rng: () => number): Set<string> {
  const walls = new Set<string>();
  const halfMax = Math.floor((WIDTH - 1) / 2); // 9
  for (let y = 1; y < HEIGHT - 1; y++) {
    for (let x = 1; x <= halfMax; x++) {
      const mx = WIDTH - 1 - x;
      if (y === CENTER_ROW) continue; // 中央走廊保持畅通
      if (nearSpawn(x, y) || nearSpawn(mx, y)) continue;
      if (rng() < WALL_DENSITY) {
        walls.add(`${x},${y}`);
        walls.add(`${mx},${y}`);
      }
    }
  }
  return walls;
}

// ---------------------------------------------------------------- 视线与观察

/** 直线视线：同行 / 同列 / 同对角线，且中间无墙。 */
function hasLineOfSight(
  a: { x: number; y: number },
  b: { x: number; y: number },
  walls: ReadonlySet<string>,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let sx = 0;
  let sy = 0;
  if (dy === 0) sx = Math.sign(dx);
  else if (dx === 0) sy = Math.sign(dy);
  else if (Math.abs(dx) === Math.abs(dy)) {
    sx = Math.sign(dx);
    sy = Math.sign(dy);
  } else {
    return false;
  }
  let x = a.x + sx;
  let y = a.y + sy;
  while (x !== b.x || y !== b.y) {
    if (walls.has(`${x},${y}`)) return false;
    x += sx;
    y += sy;
  }
  return true;
}

/** 构造某方视角的观察数据（供 step 内部与测试使用）。 */
export function buildTankObservation(state: TankGameState, side: Side): TankObservation {
  const self = state.tanks[side];
  const enemy = state.tanks[side === 0 ? 1 : 0];
  if (!self || !enemy) {
    throw new Error(`invalid tank state: missing tank for side ${side}`);
  }
  const walls = new Set(state.walls);
  const enemyVisible = enemy.hp > 0 && hasLineOfSight(self, enemy, walls);
  return {
    tick: state.tick,
    arena: { width: state.arena.width, height: state.arena.height },
    self: {
      x: self.x,
      y: self.y,
      direction: self.direction,
      hp: self.hp,
      cooldown: self.cooldown,
    },
    enemy: enemyVisible
      ? { x: enemy.x, y: enemy.y, direction: enemy.direction, hp: enemy.hp }
      : null,
    hitEvents: state.events.filter((e) => e.target === side).slice(-5),
  };
}

// ---------------------------------------------------------------- 游戏实例

class TankGameInstance implements GameInstance {
  readonly definition = TANK_DEFINITION;

  private tick = 0;
  private readonly tanks: [TankState, TankState];
  private bullets: BulletState[] = [];
  private readonly walls: ReadonlySet<string>;
  private readonly events: TankHitEvent[] = [];
  private readonly errorCounts: [number, number] = [0, 0];
  private readonly errorMessages: [string, string] = ['', ''];
  private finished = false;

  constructor(
    private readonly entrants: readonly [EntrantHandle, EntrantHandle],
    seed: number,
  ) {
    const rng = mulberry32(seed >>> 0);
    this.walls = generateWalls(rng);
    this.tanks = [
      { x: SPAWNS[0].x, y: SPAWNS[0].y, direction: SPAWNS[0].direction, hp: INITIAL_HP, cooldown: 0 },
      { x: SPAWNS[1].x, y: SPAWNS[1].y, direction: SPAWNS[1].direction, hp: INITIAL_HP, cooldown: 0 },
    ];
  }

  async step(): Promise<FrameSnapshot | null> {
    if (this.isOver()) return null;
    this.tick += 1;

    // 1) 并行收集双方行动；观察基于上一 tick 结束时的局面（自己视角）
    const state = this.snapshotState();
    const settled = await Promise.allSettled([
      this.entrants[0].act(buildTankObservation(state, 0)),
      this.entrants[1].act(buildTankObservation(state, 1)),
    ]);
    const actions: [TankAction, TankAction] = [NOOP, NOOP];
    for (const side of SIDES) {
      const r = settled[side];
      if (r.status === 'rejected') {
        this.recordError(side, r.reason);
        continue;
      }
      if (isStrategyErrorResult(r.value)) {
        this.recordError(side, r.value.message);
        continue;
      }
      actions[side] = parseAction(r.value);
    }
    if (this.finished) {
      // 策略故障判负：本 tick 不再推进战场
      return { tick: this.tick, state: this.snapshotState() };
    }

    // 2) 移动（出界/撞墙/被占 → no-op）
    for (const side of SIDES) this.applyMove(side, actions[side]);
    // 3) 转向（每 tick 顺时针 90 度一步）
    for (const side of SIDES) this.applyTurn(side, actions[side]);
    // 4) 开火（冷却中 no-op）
    for (const side of SIDES) this.applyFire(side, actions[side]);
    // 5) 子弹推进与碰撞
    this.advanceBullets();
    // 6) 冷却推进
    for (const t of this.tanks) {
      if (t.cooldown > 0) t.cooldown -= 1;
    }
    // 7) 死亡结算
    if (this.tanks[0].hp <= 0 || this.tanks[1].hp <= 0) this.finished = true;

    return { tick: this.tick, state: this.snapshotState() };
  }

  isOver(): boolean {
    return (
      this.finished ||
      this.tick >= MAX_TICKS ||
      this.tanks[0].hp <= 0 ||
      this.tanks[1].hp <= 0
    );
  }

  result(): MatchResult | null {
    if (!this.isOver()) return null;

    const faulty = SIDES.filter((s) => this.errorCounts[s] >= MAX_STRATEGY_ERRORS);
    if (faulty.length === 2) {
      return {
        outcome: { kind: 'draw', reason: '双方策略均累计 3 次执行错误' },
        failures: [
          { entrant: 0, message: this.errorMessages[0] },
          { entrant: 1, message: this.errorMessages[1] },
        ],
      };
    }
    if (faulty.length === 1) {
      const loser = faulty[0]!;
      return {
        outcome: {
          kind: 'win',
          winner: loser === 0 ? 1 : 0,
          reason: `参赛方 ${loser} 策略累计 ${MAX_STRATEGY_ERRORS} 次执行错误，判负`,
        },
        failures: [{ entrant: loser, message: this.errorMessages[loser] }],
      };
    }

    const [a, b] = this.tanks;
    if (a.hp <= 0 && b.hp <= 0) {
      return { outcome: { kind: 'draw', reason: '双方坦克同归于尽' }, failures: [] };
    }
    if (a.hp <= 0) {
      return { outcome: { kind: 'win', winner: 1, reason: '参赛方 0 坦克被击毁' }, failures: [] };
    }
    if (b.hp <= 0) {
      return { outcome: { kind: 'win', winner: 0, reason: '参赛方 1 坦克被击毁' }, failures: [] };
    }
    if (a.hp > b.hp) {
      return {
        outcome: { kind: 'win', winner: 0, reason: `达到 ${MAX_TICKS} tick 上限，按剩余 HP 判定` },
        failures: [],
      };
    }
    if (b.hp > a.hp) {
      return {
        outcome: { kind: 'win', winner: 1, reason: `达到 ${MAX_TICKS} tick 上限，按剩余 HP 判定` },
        failures: [],
      };
    }
    return { outcome: { kind: 'draw', reason: `达到 ${MAX_TICKS} tick 上限，双方 HP 相同` }, failures: [] };
  }

  // ------------------------------------------------ 内部规则

  private tankAt(x: number, y: number): Side | null {
    if (this.tanks[0].x === x && this.tanks[0].y === y) return 0;
    if (this.tanks[1].x === x && this.tanks[1].y === y) return 1;
    return null;
  }

  private cellFree(x: number, y: number): boolean {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
    if (this.walls.has(`${x},${y}`)) return false;
    return this.tankAt(x, y) === null;
  }

  private applyMove(side: Side, action: TankAction): void {
    const tank = this.tanks[side];
    const move = action.move;
    if (move === null || move === 'none') return;
    const dir = tank.direction;
    let dx = 0;
    let dy = 0;
    if (move === 'forward') {
      const d = dirVec(dir);
      dx = d.dx;
      dy = d.dy;
    } else if (move === 'back') {
      const d = dirVec(dir);
      dx = -d.dx;
      dy = -d.dy;
    } else if (move === 'left') {
      const d = dirVec(dir + 3); // 车身左侧（逆时针 90 度方向）
      dx = d.dx;
      dy = d.dy;
    } else {
      const d = dirVec(dir + 1); // 车身右侧
      dx = d.dx;
      dy = d.dy;
    }
    if (this.cellFree(tank.x + dx, tank.y + dy)) {
      tank.x += dx;
      tank.y += dy;
    }
  }

  private applyTurn(side: Side, action: TankAction): void {
    const tank = this.tanks[side];
    if (action.turn === null || action.turn === tank.direction) return;
    tank.direction = (tank.direction + 1) % 4; // 顺时针一步
  }

  private applyFire(side: Side, action: TankAction): void {
    const tank = this.tanks[side];
    if (!action.fire || tank.hp <= 0 || tank.cooldown > 0) return;
    this.bullets.push({ x: tank.x, y: tank.y, direction: tank.direction, owner: side });
    tank.cooldown = FIRE_COOLDOWN_TICKS;
  }

  private advanceBullets(): void {
    // 推进一格；出界或撞墙的子弹消失（墙不摧毁）
    const moved: BulletState[] = [];
    for (const b of this.bullets) {
      const d = dirVec(b.direction);
      const nb: BulletState = { ...b, x: b.x + d.dx, y: b.y + d.dy };
      if (nb.x < 0 || nb.x >= WIDTH || nb.y < 0 || nb.y >= HEIGHT) continue;
      if (this.walls.has(`${nb.x},${nb.y}`)) continue;
      moved.push(nb);
    }
    // 子弹对撞（同一格）双双消失
    const survived: BulletState[] = moved.filter(
      (b, i) => !moved.some((o, j) => j !== i && o.x === b.x && o.y === b.y),
    );
    // 命中判定与 HP 结算
    const remaining: BulletState[] = [];
    for (const b of survived) {
      const target = this.tankAt(b.x, b.y);
      if (target !== null && this.tanks[target].hp > 0) {
        this.tanks[target].hp -= BULLET_DAMAGE;
        this.events.push({
          tick: this.tick,
          target,
          source: b.owner,
          damage: BULLET_DAMAGE,
          x: b.x,
          y: b.y,
        });
        if (this.events.length > MAX_EVENTS) this.events.shift();
      } else {
        remaining.push(b);
      }
    }
    this.bullets = remaining;
  }

  private recordError(side: Side, err: unknown): void {
    const message = errorText(err).slice(0, 200) || '未知策略错误';
    this.errorCounts[side] += 1;
    this.errorMessages[side] = message;
    if (this.errorCounts[side] >= MAX_STRATEGY_ERRORS) this.finished = true;
  }

  private snapshotState(): TankGameState {
    return {
      tick: this.tick,
      arena: { width: WIDTH, height: HEIGHT },
      tanks: [{ ...this.tanks[0] }, { ...this.tanks[1] }],
      bullets: this.bullets.map((b) => ({ ...b })),
      walls: [...this.walls].sort(),
      events: this.events.slice(),
    };
  }
}

// ---------------------------------------------------------------- 包导出

/**
 * 坦克游戏包类型：GamePackage 的扩展。
 * createInstance 额外接受可选 options?: { seed }，供平台传入由 matchId
 * 哈希派生的伪随机种子（见 deriveSeedFromMatchId）；不传时使用固定默认种子。
 * 契约接口（contracts.ts）只声明单参数，双参数（第二参可选）方法与契约方法
 * 双变兼容，因此 TankGamePackage 可直接赋给 GamePackage，无需修改契约。
 */
export interface TankGamePackage extends GamePackage {
  createInstance(
    entrants: [EntrantHandle, EntrantHandle],
    options?: TankInstanceOptions,
  ): GameInstance;
}

export const tankGamePackage: TankGamePackage = {
  definition: TANK_DEFINITION,
  createInstance(entrants, options): GameInstance {
    const seed = options?.seed ?? deriveSeedFromMatchId('tank-default');
    return new TankGameInstance(entrants, seed);
  },
};
