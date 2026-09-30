/**
 * 游戏包公共契约（平台核心与游戏包之间的接口）。
 *
 * 设计依据 docs/adr/0001-configurable-games-across-action-models.md：
 * 平台核心不感知坦克或五子棋的具体规则；每款游戏实现本接口，
 * 由 GameRegistry 注册、后台导入并动态启用。
 */

/** 一局对战中某一方的运行时句柄（由平台在开局时构造）。 */
export interface EntrantHandle {
  /** 平台内部参赛对象 ID。 */
  readonly entrantId: string;
  /** 策略入口：输入该方视角的观察数据，返回行动。 */
  act(observation: unknown): Promise<unknown>;
}

/** 观众/回放用的完整局面快照（与策略可见信息区分，见 ADR 0002）。 */
export interface FrameSnapshot {
  /** 逻辑帧号（即时制）或回合号（回合制）。 */
  readonly tick: number;
  /** 该帧的完整战场状态，供渲染层直接使用。 */
  readonly state: unknown;
}

export type MatchOutcome =
  | { kind: 'win'; winner: 0 | 1; reason: string }
  | { kind: 'draw'; reason: string }
  | { kind: 'invalid'; reason: string };

/** 对局结束记录。invalid 表示平台或规则执行故障，不计成绩（ADR 0003）。 */
export interface MatchResult {
  readonly outcome: MatchOutcome;
  /** 若有策略方被判负，记录其错误诊断（只对该方管理者可见）。 */
  readonly failures: ReadonlyArray<{ entrant: 0 | 1; message: string }>;
}

/** 游戏包元信息。 */
export interface GameDefinition {
  readonly id: string;
  readonly name: string;
  /** 'instant'（坦克式即时制）或 'turn-based'（棋类回合制）。 */
  readonly pacing: 'instant' | 'turn-based';
  /** 该游戏对策略暴露的可调用行动（供文档与校验用）。 */
  readonly actionNames: readonly string[];
}

/** 游戏实例：绑定一次对局的规则状态机。 */
export interface GameInstance {
  readonly definition: GameDefinition;
  /** 推进一个决策点；返回该点产生的观众帧。 */
  step(): Promise<FrameSnapshot | null>;
  /** 当前是否已结束。 */
  isOver(): boolean;
  /** 结束时返回结果；未结束返回 null。 */
  result(): MatchResult | null;
}

/**
 * 游戏包工厂：平台核心通过它创建对局实例。
 * 每局调用一次 createInstance，两方策略以 EntrantHandle 注入。
 */
export interface GamePackage {
  readonly definition: GameDefinition;
  createInstance(entrants: [EntrantHandle, EntrantHandle]): GameInstance;
}
