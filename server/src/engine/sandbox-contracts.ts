/**
 * 策略沙箱接口：平台核心只依赖此接口执行策略，
 * 具体隔离技术（QuickJS 等）是实现细节（ADR 0005）。
 */

export interface StrategyBudget {
  /** 累计 CPU 时间上限（毫秒）。 */
  readonly cpuMs: number;
  /** 累计内存上限（字节）。 */
  readonly memoryBytes: number;
}

export const DEFAULT_STRATEGY_BUDGET: StrategyBudget = {
  cpuMs: 2000,
  memoryBytes: 64 * 1024 * 1024,
};

/**
 * onIdle 命令队列中策略排入的单条命令（agentank 形态：
 * 策略在 onIdle 内调用 me.go()/me.turn()/me.fire() 等方法排队，
 * 引擎每 tick 只执行每方一条；具体游戏包消费自己认识的命令类型，
 * 不认识的类型静默忽略）。
 */
export type QueuedCommand =
  | { type: 'go' }
  | { type: 'turn'; dir: 'left' | 'right' }
  | { type: 'fire' }
  | { type: 'bomb' }
  | { type: 'speak'; text: string }
  | { type: 'place'; x: number; y: number }
  | { type: 'skill'; name: string; args?: unknown[] };

/**
 * act 的返回信封：命令队列 + 策略日志（print/speak）+ 原始返回值。
 * 回合制游戏（如五子棋）可继续用 returned（如 { place: [x, y] }），
 * 即时制游戏（如坦克）消费 commands；两者不冲突。
 */
export interface StrategyActionEnvelope {
  readonly commands: readonly QueuedCommand[];
  readonly logs: readonly string[];
  readonly returned: unknown;
}

/** 判断 act 结果是否为命令信封（防御性：假沙箱/旧实现可能直接返回动作对象）。 */
export function isStrategyActionEnvelope(value: unknown): value is StrategyActionEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { commands?: unknown }).commands) &&
    'returned' in value
  );
}

/** 从 act 结果中取出动作：信封取 returned，非信封原样返回（兼容旧动作对象）。 */
export function unwrapEnvelope(value: unknown): unknown {
  return isStrategyActionEnvelope(value) ? value.returned : value;
}

/** 策略调用结果：正常返回值或策略自身故障。 */
export type StrategyStepResult =
  | { kind: 'ok'; action: StrategyActionEnvelope }
  | { kind: 'error'; message: string };

/**
 * 受限策略执行环境：每个参赛方每局一个实例。
 * 不允许联网、文件、宿主 API —— 由实现保证。
 */
export interface StrategySandbox {
  /** 载入策略源码（已发布版本或训练候选，见 ADR 0004）。 */
  load(source: string, budget: StrategyBudget): Promise<void>;
  /** 执行一个决策点。 */
  act(observation: unknown): Promise<StrategyStepResult>;
  /** 释放资源。 */
  dispose(): Promise<void>;
}

/** 沙箱工厂——平台通过它创建每个参赛方的执行环境。 */
export interface SandboxFactory {
  create(): StrategySandbox;
}
