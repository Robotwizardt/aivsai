/**
 * 坦克大战游戏包 v2（1v1 即时制，agentank.ai 式命令队列 + 战场四件套）。
 *
 * 规则摘要：
 * - 20x15 网格；mulberry32 固定种子随机生成左右镜像对称的地形：
 *   墙 "x"（不可摧毁，挡移动挡子弹）、土堆 "m"（挡移动挡子弹，被子弹
 *   命中后摧毁变为空地，子弹同时消失）、草 "o"（可通行不挡子弹，敌方
 *   坦克站在草上时对敌方策略不可见）、空地 "."；中央走廊（y=7）保持
 *   无墙无土堆，出生点周边留空；
 * - 出生点 (2,7) 朝东 / (17,7) 朝西，HP 100，子弹伤害 34，开火冷却
 *   8 tick，300 tick 上限；
 * - 命令队列：每 tick 若该方队列为空则调用策略 act(观察)，act 返回
 *   StrategyActionEnvelope，识别 go/turn/fire/speak 追加进队列；每方每
 *   tick 从队列消耗一条执行（go 前进一格，撞墙/土堆/坦克/出界为 no-op；
 *   turn 原地转 90 度；fire 仅在自己无存活子弹且冷却为 0 时发射——每方
 *   同屏只能有一发自己的子弹）；speak 不消耗动作，立即进入观众帧
 *   bubbles；不认识的命令类型静默丢弃；
 * - 星星：场上始终恰好一颗；坦克移动后所在格为星 → 星数 +1 并立即
 *   重新生成；胜负判定优先级：击毁 > 超时星数多者胜 > 星同则 HP 多者
 *   胜 > 平局；
 * - 观察为 TankObservationV2（self/enemy/map/star/frames/arena），
 *   全图对策略可见，可见性只由草丛决定（敌方站草上时 enemy 为 null，
 *   敌方子弹始终可见）；
 * - 旧式动作对象（非命令信封）一律 no-op；策略抛错累计 3 次判负。
 *
 * 简化（相对完整坦克玩法）：无技能/炸弹/放置（命令保留在通用契约中，
 * 坦克包不消费）、无视锥遮挡、命中伤害固定无散布。
 */

import type {
  EntrantHandle,
  FrameSnapshot,
  GameDefinition,
  GameInstance,
  GamePackage,
  MatchResult,
} from '../contracts.js';
import {
  isStrategyActionEnvelope,
  type QueuedCommand,
} from '../../engine/sandbox-contracts.js';

// ---------------------------------------------------------------- 常量

const WIDTH = 20;
const HEIGHT = 15;
const MAX_TICKS = 300;
const INITIAL_HP = 100;
const BULLET_DAMAGE = 34;
const FIRE_COOLDOWN_TICKS = 8;
const MAX_STRATEGY_ERRORS = 3;
const WALL_DENSITY = 0.1;
const MOUND_DENSITY = 0.08;
const GRASS_DENSITY = 0.08;
const CENTER_ROW = HEIGHT >> 1; // 7：中央走廊行，保持无墙无土堆
const MAX_EVENTS = 30;
const MAX_BUBBLES = 10;
const SPEAK_TEXT_MAX = 40;

/** 方向：0=北(up) 1=东(right) 2=南(down) 3=西(left)（顺时针）；北为 y-1。 */
const DIRS: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

const DIR_NAMES = ['up', 'right', 'down', 'left'] as const;
type DirName = (typeof DIR_NAMES)[number];

function dirVec(dir: number): { dx: number; dy: number } {
  return DIRS[((dir % 4) + 4) % 4]!;
}

function dirName(dir: number): DirName {
  return DIR_NAMES[((dir % 4) + 4) % 4]!;
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
  actionNames: ['go', 'turn', 'fire', 'speak'],
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
  /** 已收集的星星数。 */
  stars: number;
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
  /** 地形三件套：各自 "x,y" 字符串集合（已排序）。 */
  terrain: { walls: string[]; mounds: string[]; grass: string[] };
  /** 当前场上星星位置（始终恰好一颗，除非地图异常）。 */
  star: { x: number; y: number } | null;
  /** 最近的命中事件（新事件在末尾）。 */
  events: TankHitEvent[];
  /** 最近 10 条发言气泡。 */
  bubbles: { side: 0 | 1; text: string; tick: number }[];
}

/** 单方视角的观察数据 v2（agentank 风格形状）。 */
export interface TankObservationV2 {
  self: {
    tank: {
      id: number;
      position: [number, number];
      direction: DirName;
      crashed: boolean;
    };
    hp: number;
    cooldown: number;
    stars: number;
    bullet: { position: [number, number]; direction: DirName } | null;
  };
  /** 与 self 同构；敌方站草上时为 null（敌方子弹始终可见）。 */
  enemy: TankObservationV2['self'] | null;
  /** map[x][y] ∈ 'x'|'m'|'o'|'.'，全图可见。 */
  map: string[][];
  star: [number, number] | null;
  /** 当前 tick。 */
  frames: number;
  arena: { width: number; height: number };
}

export interface TankInstanceOptions {
  /** 伪随机种子；平台应传由 matchId 哈希派生的值（见 deriveSeedFromMatchId）。 */
  seed?: number;
}

// ---------------------------------------------------------------- 地图生成

type TerrainKind = 'x' | 'm' | 'o';

function nearSpawn(x: number, y: number): boolean {
  for (const s of SPAWNS) {
    if (Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) <= 2) return true;
  }
  return false;
}

/**
 * 左半随机撒地形，镜像到右半，保证双方对称；中央走廊无墙无土堆
 * （草可以有），出生点周边留空。三层地形互斥：同一格只放一种。
 */
function generateTerrain(rng: () => number): {
  walls: Set<string>;
  mounds: Set<string>;
  grass: Set<string>;
} {
  const walls = new Set<string>();
  const mounds = new Set<string>();
  const grass = new Set<string>();
  const halfMax = Math.floor((WIDTH - 1) / 2); // 9
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x <= halfMax; x++) {
      const mx = WIDTH - 1 - x;
      if (nearSpawn(x, y) || nearSpawn(mx, y)) continue;
      const roll = rng();
      let kind: TerrainKind | null = null;
      if (y !== CENTER_ROW) {
        // 中央走廊无墙无土堆（草可以有）
        if (roll < WALL_DENSITY) kind = 'x';
        else if (roll < WALL_DENSITY + MOUND_DENSITY) kind = 'm';
      }
      if (kind === null && roll < WALL_DENSITY + MOUND_DENSITY + GRASS_DENSITY) {
        kind = 'o';
      }
      if (!kind) continue;
      const target = kind === 'x' ? walls : kind === 'm' ? mounds : grass;
      target.add(`${x},${y}`);
      if (mx !== x) target.add(`${mx},${y}`);
    }
  }
  return { walls, mounds, grass };
}

// ---------------------------------------------------------------- 观察构造

/** 构造某方视角的观察数据 v2（供 step 内部与测试使用）。 */
export function buildTankObservation(
  state: TankGameState,
  side: Side,
): TankObservationV2 {
  const self = state.tanks[side];
  const enemySide = side === 0 ? 1 : 0;
  const enemy = state.tanks[enemySide];
  if (!self || !enemy) {
    throw new Error(`invalid tank state: missing tank for side ${side}`);
  }

  const map: string[][] = [];
  const wallSet = new Set(state.terrain.walls);
  const moundSet = new Set(state.terrain.mounds);
  const grassSet = new Set(state.terrain.grass);
  for (let x = 0; x < state.arena.width; x++) {
    const column: string[] = [];
    for (let y = 0; y < state.arena.height; y++) {
      const key = `${x},${y}`;
      column.push(
        wallSet.has(key) ? 'x' : moundSet.has(key) ? 'm' : grassSet.has(key) ? 'o' : '.',
      );
    }
    map.push(column);
  }

  const buildSide = (side: number, tank: TankState): TankObservationV2['self'] => {
    const bullet = state.bullets.find((b) => b.owner === side) ?? null;
    return {
      tank: {
        id: side,
        position: [tank.x, tank.y],
        direction: dirName(tank.direction),
        crashed: tank.hp <= 0,
      },
      hp: tank.hp,
      cooldown: tank.cooldown,
      stars: tank.stars,
      bullet: bullet
        ? { position: [bullet.x, bullet.y], direction: dirName(bullet.direction) }
        : null,
    };
  };

  // 可见性只由草丛决定：敌方站草上 → enemy 为 null（敌方子弹始终可见）
  const enemyHidden = grassSet.has(`${enemy.x},${enemy.y}`);

  return {
    self: buildSide(side, self),
    enemy: enemyHidden || enemy.hp <= 0 ? null : buildSide(enemySide, enemy),
    map,
    star: state.star ? [state.star.x, state.star.y] : null,
    frames: state.tick,
    arena: { width: state.arena.width, height: state.arena.height },
  };
}

// ---------------------------------------------------------------- 游戏实例

/** 引擎内部使用的命令（识别 go/turn/fire，speak 单独处理，其余丢弃）。 */
type EngineCommand =
  | { type: 'go' }
  | { type: 'turn'; dir: 'left' | 'right' }
  | { type: 'fire' };

class TankGameInstance implements GameInstance {
  readonly definition = TANK_DEFINITION;

  private tick = 0;
  private readonly tanks: [TankState, TankState];
  private bullets: BulletState[] = [];
  private readonly walls: ReadonlySet<string>;
  private mounds: Set<string>;
  private readonly grass: ReadonlySet<string>;
  private star: { x: number; y: number } | null = null;
  private readonly events: TankHitEvent[] = [];
  private readonly bubbles: { side: 0 | 1; text: string; tick: number }[] = [];
  private readonly errorCounts: [number, number] = [0, 0];
  private readonly errorMessages: [string, string] = ['', ''];
  private readonly queues: [EngineCommand[], EngineCommand[]] = [[], []];
  private finished = false;

  constructor(
    private readonly entrants: readonly [EntrantHandle, EntrantHandle],
    seed: number,
  ) {
    const rng = mulberry32(seed >>> 0);
    const terrain = generateTerrain(rng);
    this.walls = terrain.walls;
    this.mounds = terrain.mounds;
    this.grass = terrain.grass;
    this.tanks = [
      { x: SPAWNS[0].x, y: SPAWNS[0].y, direction: SPAWNS[0].direction, hp: INITIAL_HP, cooldown: 0, stars: 0 },
      { x: SPAWNS[1].x, y: SPAWNS[1].y, direction: SPAWNS[1].direction, hp: INITIAL_HP, cooldown: 0, stars: 0 },
    ];
    this.star = this.pickStarCell(rng, null);
  }

  async step(): Promise<FrameSnapshot | null> {
    if (this.isOver()) return null;
    this.tick += 1;

    // 1) 队列为空的方调用 act(观察)；观察基于上一 tick 结束时的局面。
    //    act 返回命令信封：识别的命令 append 到队列；speak 立即生效
    //    （不占动作、不入队列）。act reject / 策略错误 → 错误计数。
    const state = this.snapshotState();
    const needsAct: [boolean, boolean] = [
      this.queues[0].length === 0,
      this.queues[1].length === 0,
    ];
    const settled = await Promise.allSettled([
      needsAct[0] ? this.entrants[0].act(buildTankObservation(state, 0)) : Promise.resolve(null),
      needsAct[1] ? this.entrants[1].act(buildTankObservation(state, 1)) : Promise.resolve(null),
    ]);
    for (const side of SIDES) {
      if (!needsAct[side]) continue;
      const r = settled[side]!;
      if (r.status === 'rejected') {
        this.recordError(side, r.reason);
        continue;
      }
      this.consumeEnvelope(side, r.value);
    }
    if (this.finished) {
      // 策略故障判负：本 tick 不再推进战场
      return { tick: this.tick, state: this.snapshotState() };
    }

    // 2) 每方从队列 shift 一条执行
    for (const side of SIDES) {
      const cmd = this.queues[side].shift();
      if (!cmd) continue;
      if (cmd.type === 'go') this.applyGo(side);
      else if (cmd.type === 'turn') this.applyTurn(side, cmd.dir);
      else if (cmd.type === 'fire') this.applyFire(side);
    }

    // 3) 子弹推进与命中结算
    this.advanceBullets();
    // 4) 冷却递减
    for (const t of this.tanks) {
      if (t.cooldown > 0) t.cooldown -= 1;
    }
    // 5) 吃星判定（移动后所在格为星 → +1 并重新生成）
    this.checkStar();
    // 6) 死亡结算
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

    // 优先级：被击毁 > 策略累计错误判负（规格顺序）。
    // 若同一 tick 内某方既被击毁又凑满第 3 次错误，按“被击毁”结算。
    const [a0, b0] = this.tanks;
    if (a0.hp <= 0 || b0.hp <= 0) return this.destructionResult();

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

    // 超时：星数多者胜 > 星同则 HP 多者胜 > 平局
    const [a, b] = this.tanks;
    if (a.stars !== b.stars) {
      const winner: 0 | 1 = a.stars > b.stars ? 0 : 1;
      return {
        outcome: {
          kind: 'win',
          winner,
          reason: `达到 ${MAX_TICKS} tick 上限，按星数判定（${a.stars} vs ${b.stars}）`,
        },
        failures: [],
      };
    }
    if (a.hp !== b.hp) {
      const winner: 0 | 1 = a.hp > b.hp ? 0 : 1;
      return {
        outcome: {
          kind: 'win',
          winner,
          reason: `达到 ${MAX_TICKS} tick 上限，星数相同按剩余 HP 判定`,
        },
        failures: [],
      };
    }
    return {
      outcome: { kind: 'draw', reason: `达到 ${MAX_TICKS} tick 上限，双方星数与 HP 相同` },
      failures: [],
    };
  }

  // ------------------------------------------------ 内部规则

  /** 消费 act 返回值：信封取命令，识别的入队 / speak 立即生效；非信封 no-op。 */
  private consumeEnvelope(side: Side, value: unknown): void {
    if (!isStrategyActionEnvelope(value)) return; // 旧式动作对象 → no-op
    let spoke = false;
    for (const cmd of value.commands) {
      if (!cmd || typeof cmd !== 'object') continue;
      const c = cmd as QueuedCommand;
      if (c.type === 'go' || c.type === 'fire') {
        this.queues[side].push({ type: c.type });
      } else if (c.type === 'turn' && (c.dir === 'left' || c.dir === 'right')) {
        this.queues[side].push({ type: 'turn', dir: c.dir });
      } else if (c.type === 'speak') {
        // 每次 act 最多 1 条 speak；不占动作，立即进观众帧
        if (spoke) continue;
        spoke = true;
        const text = typeof c.text === 'string' ? c.text.slice(0, SPEAK_TEXT_MAX) : '';
        if (!text) continue;
        this.bubbles.push({ side, text, tick: this.tick });
        if (this.bubbles.length > MAX_BUBBLES) this.bubbles.shift();
      }
      // bomb / place / skill / 其他：坦克包不认识，静默丢弃
    }
  }

  private tankAt(x: number, y: number): Side | null {
    if (this.tanks[0].x === x && this.tanks[0].y === y) return 0;
    if (this.tanks[1].x === x && this.tanks[1].y === y) return 1;
    return null;
  }

  private cellFree(x: number, y: number): boolean {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
    if (this.walls.has(`${x},${y}`)) return false;
    if (this.mounds.has(`${x},${y}`)) return false;
    return this.tankAt(x, y) === null;
  }

  private applyGo(side: Side): void {
    const tank = this.tanks[side];
    const d = dirVec(tank.direction);
    if (!this.cellFree(tank.x + d.dx, tank.y + d.dy)) return;
    tank.x += d.dx;
    tank.y += d.dy;
  }

  private applyTurn(side: Side, dir: 'left' | 'right'): void {
    const tank = this.tanks[side];
    // left = 逆时针 90 度，right = 顺时针 90 度
    tank.direction = ((tank.direction + (dir === 'right' ? 1 : 3)) % 4 + 4) % 4;
  }

  private applyFire(side: Side): void {
    const tank = this.tanks[side];
    if (tank.hp <= 0 || tank.cooldown > 0) return;
    // 每方同屏只能有一发自己的子弹
    if (this.bullets.some((b) => b.owner === side)) return;
    this.bullets.push({ x: tank.x, y: tank.y, direction: tank.direction, owner: side });
    tank.cooldown = FIRE_COOLDOWN_TICKS;
  }

  private advanceBullets(): void {
    // 推进一格；出界或撞墙的子弹消失（墙不可摧毁）
    const moved: BulletState[] = [];
    for (const b of this.bullets) {
      const d = dirVec(b.direction);
      const nb: BulletState = { ...b, x: b.x + d.dx, y: b.y + d.dy };
      if (nb.x < 0 || nb.x >= WIDTH || nb.y < 0 || nb.y >= HEIGHT) continue;
      if (this.walls.has(`${nb.x},${nb.y}`)) continue;
      // 土堆被命中摧毁变为空地，子弹同时消失
      if (this.mounds.has(`${nb.x},${nb.y}`)) {
        this.mounds.delete(`${nb.x},${nb.y}`);
        continue;
      }
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

  /** 坦克 HP 归零的结算（至少有一方已阵亡时才调用）。 */
  private destructionResult(): MatchResult {
    const [a, b] = this.tanks;
    if (a.hp <= 0 && b.hp <= 0) {
      return { outcome: { kind: 'draw', reason: '双方坦克同归于尽' }, failures: [] };
    }
    if (a.hp <= 0) {
      return { outcome: { kind: 'win', winner: 1, reason: '参赛方 0 坦克被击毁' }, failures: [] };
    }
    return { outcome: { kind: 'win', winner: 0, reason: '参赛方 1 坦克被击毁' }, failures: [] };
  }

  private checkStar(): void {
    // 自愈：地图候选集曾为空（极度罕见）时星星可能已为 null，这里补回一颗，
    // 保证“场上始终恰好一颗星”的第二胜利路线不会中途消失。
    if (!this.star) {
      this.star = this.pickStarCell(mulberry32(this.tick * 7919), null);
      if (!this.star) return;
    }
    for (const side of SIDES) {
      if (this.tanks[side].x === this.star.x && this.tanks[side].y === this.star.y) {
        this.tanks[side].stars += 1;
        this.star = this.pickStarCell(mulberry32(this.tick * 7919 + side), this.star);
        return;
      }
    }
  }

  /**
   * 生成星星位置：空地或草、非坦克所在格、距两坦克曼哈顿距离≥3、非出生点 2 格内。
   *
   * 候选集为空时逐级放宽约束（宁可放宽也不要让星星消失）：
   * ① 允许落在上一颗的位置；② 取消“距两坦克≥3”。全部为空才返回 null。
   */
  private pickStarCell(
    rng: () => number,
    previous: { x: number; y: number } | null,
  ): { x: number; y: number } | null {
    const candidates = this.collectStarCandidates(previous, true);
    const relaxed = candidates.length > 0 ? candidates : this.collectStarCandidates(null, true);
    const loosest = relaxed.length > 0 ? relaxed : this.collectStarCandidates(null, false);
    const pool = loosest.length > 0 ? loosest : relaxed;
    if (pool.length === 0) return null;
    return pool[Math.floor(rng() * pool.length)]!;
  }

  /** @param keepAwayFromTanks 是否要求距两坦克曼哈顿距离 ≥3。 */
  private collectStarCandidates(
    previous: { x: number; y: number } | null,
    keepAwayFromTanks: boolean,
  ): { x: number; y: number }[] {
    const cells: { x: number; y: number }[] = [];
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (this.walls.has(`${x},${y}`) || this.mounds.has(`${x},${y}`)) continue;
        if (this.tankAt(x, y) !== null) continue;
        if (nearSpawn(x, y)) continue;
        if (
          keepAwayFromTanks &&
          (Math.abs(x - this.tanks[0].x) + Math.abs(y - this.tanks[0].y) < 3 ||
            Math.abs(x - this.tanks[1].x) + Math.abs(y - this.tanks[1].y) < 3)
        ) {
          continue;
        }
        if (previous && previous.x === x && previous.y === y) continue;
        cells.push({ x, y });
      }
    }
    return cells;
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
      terrain: {
        walls: [...this.walls].sort(),
        mounds: [...this.mounds].sort(),
        grass: [...this.grass].sort(),
      },
      star: this.star ? { ...this.star } : null,
      events: this.events.slice(),
      bubbles: this.bubbles.slice(),
    };
  }
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
