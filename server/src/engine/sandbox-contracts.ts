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

/** 策略调用结果：正常返回值或策略自身故障。 */
export type StrategyStepResult =
  | { kind: 'ok'; action: unknown }
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
