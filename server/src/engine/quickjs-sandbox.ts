/**
 * QuickJS 策略执行沙箱（ADR 0005）。
 *
 * 隔离保证：
 * - 策略在独立的 QuickJS WebAssembly runtime/context 中执行，与 Node 宿主隔离。
 * - 本实现从不向 QuickJS 全局注入任何宿主对象（fs / net / process / fetch
 *   等 Node API 在 QuickJS 中本就不存在，保持零注入即可保证策略无法访问
 *   平台层或操作系统；唯一注入的数据是每次 act 的纯 JSON 观察值）。
 * - 内存与 CPU 预算由 QuickJS 运行时强制执行：
 *   setMemoryLimit（超限抛 InternalError "out of memory"）与
 *   setInterruptHandler（超时中断执行，抛 InternalError "interrupted"）。
 */

import type {
  SandboxFactory,
  StrategyBudget,
  StrategySandbox,
  StrategyStepResult,
} from './sandbox-contracts.js';
import {
  newQuickJSWASMModule,
  RELEASE_SYNC,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';

/** 共享的 QuickJS 引擎单例；每个沙箱仍持有独立 runtime/context。 */
let enginePromise: Promise<QuickJSWASMModule> | undefined;

export function getQuickJSEngine(): Promise<QuickJSWASMModule> {
  // Node 环境必须使用同步 variant（RELEASE_SYNC）。ASYNCIFY variant
  // 在同一 WASM 模块内只允许一次并发挂起调用，不适合本用途。
  enginePromise ??= newQuickJSWASMModule(RELEASE_SYNC);
  return enginePromise;
}

const MAX_MESSAGE_LENGTH = 2000;

/** 单帧 act 墙钟时间上限（毫秒）。 */
const PER_FRAME_CPU_MS_CAP = 50;
/** budget.cpuMs 是整局累计 CPU 预算，按帧率上限折算为每帧份额。 */
const ASSUMED_FRAMES_PER_MATCH = 600;

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? message.slice(0, MAX_MESSAGE_LENGTH)
    : message;
}

/** 把异常（Error / dump 出的普通对象）转为可读文本。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (err !== null && typeof err === 'object') {
    const { name, message } = err as { name?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return typeof name === 'string' && name !== '' ? `${name}: ${message}` : message;
    }
  }
  return String(err);
}

/** 每帧 act 可用的 CPU 时间份额（毫秒），至少 1ms。 */
function frameCpuBudgetMs(budget: StrategyBudget): number {
  const perFrame = budget.cpuMs / ASSUMED_FRAMES_PER_MATCH;
  return Math.max(1, Math.min(perFrame, PER_FRAME_CPU_MS_CAP));
}

/** load 阶段（含 WASM 预热）的墙钟时间下限（毫秒）。 */
const LOAD_CPU_MS_FLOOR = 100;

/** 从 VM error handle 提取截断后的错误文本（不抛出到平台层）。 */
function describeVmError(ctx: QuickJSContext, error: QuickJSHandle): string {
  const dumped = ctx.dump(error);
  return truncate(describeError(dumped));
}

export class QuickJsSandbox implements StrategySandbox {
  private ctx: QuickJSContext | undefined;
  private budget: StrategyBudget | undefined;
  private loaded = false;
  private disposed = false;

  async load(source: string, budget: StrategyBudget): Promise<void> {
    if (this.disposed || this.loaded) {
      throw new Error('sandbox is not loadable (already loaded or disposed)');
    }
    const QuickJS = await getQuickJSEngine();
    // 独立 runtime：内存限制与中断处理器只作用于该参赛方独享的运行时。
    const runtime = QuickJS.newRuntime();
    const ctx = runtime.newContext();

    // 编译/执行失败时确保资源被回收。
    let ok = false;
    try {
      // 内存预算：超限时 QuickJS 在分配处抛 InternalError("out of memory")。
      runtime.setMemoryLimit(budget.memoryBytes);
      // load 阶段同样有时间片限制，防止策略顶层死循环卡死平台；
      // 给一个较小的下限，避免首次 WASM 预热被误判为超时。
      const loadDeadline =
        Date.now() + Math.max(frameCpuBudgetMs(budget), LOAD_CPU_MS_FLOOR);
      runtime.setInterruptHandler(() => Date.now() > loadDeadline);

      // 策略源码在全局作用域求值；编译错误与运行期错误都以
      // result.error 返回，在此捕获并转成 Error 抛给调用方
      // （load 的失败语义：load 本身 reject，act 阶段则返回 error）。
      const result = ctx.evalCode(source, 'strategy.js', { type: 'global' });
      if (result.error) {
        const message = describeVmError(ctx, result.error);
        result.error.dispose();
        throw new Error(message);
      }
      result.value.dispose();

      // 契约：策略必须定义全局函数 onIdle(me, enemy, game)。
      const onIdle = ctx.getProp(ctx.global, 'onIdle');
      const isFunction = ctx.typeof(onIdle) === 'function';
      onIdle.dispose();
      if (!isFunction) {
        throw new Error(
          'strategy must define a global function onIdle(me, enemy, game)',
        );
      }

      runtime.removeInterruptHandler();
      this.ctx = ctx;
      this.budget = budget;
      this.loaded = true;
      ok = true;
    } finally {
      if (!ok) {
        try {
          ctx.dispose();
        } catch {
          // ignore
        }
        try {
          runtime.dispose();
        } catch {
          // ignore
        }
      }
    }
  }

  async act(observation: unknown): Promise<StrategyStepResult> {
    if (this.disposed || !this.loaded) {
      return { kind: 'error', message: 'sandbox not available' };
    }
    const ctx = this.ctx;
    const runtime = ctx?.runtime;
    const budget = this.budget;
    if (!ctx || !runtime || !ctx.alive || !budget) {
      return { kind: 'error', message: 'sandbox not available' };
    }

    try {
      // CPU 预算：每帧墙钟份额到期后中断 handler 让 QuickJS 停止执行，
      // 抛出 InternalError("interrupted")——死循环策略在这里被拦截。
      const deadline = Date.now() + frameCpuBudgetMs(budget);
      runtime.setInterruptHandler(() => Date.now() > deadline);

      // 观察数据以纯 JSON 文本传入 VM 再解析，宿主对象无法跨边界泄漏。
      // 契约是 onIdle(me, enemy, game)；游戏包观察字段不一（tank 用 self、
      // gomoku 用 me），在 VM 内归一化：me ← self|me，其余字段（tick/arena/
      // board/hitEvents 等）全部合并进 game，供策略按需读取。
      const obsJson = JSON.stringify(observation ?? {});
      const obsResult = ctx.evalCode(
        `(() => {
          const o = JSON.parse(${JSON.stringify(obsJson)});
          const me = 'self' in o ? o.self : o.me;
          const game = {
            ...o,
            ...(o.game && typeof o.game === 'object' ? o.game : {}),
          };
          delete game.me;
          delete game.self;
          delete game.enemy;
          delete game.game;
          return { me, enemy: o.enemy, game };
        })()`,
        '__obs.js',
        { type: 'global' },
      );
      const obs = ctx.unwrapResult(obsResult);
      // 传入 VM 的只是 JSON 数据的副本句柄，不引用任何宿主 API。
      const me = ctx.getProp(obs, 'me');
      const enemy = ctx.getProp(obs, 'enemy');
      const game = ctx.getProp(obs, 'game');
      obs.dispose();

      const onIdle = ctx.getProp(ctx.global, 'onIdle');
      const call = ctx.callFunction(onIdle, ctx.undefined, me, enemy, game);
      onIdle.dispose();
      me.dispose();
      enemy.dispose();
      game.dispose();

      if (call.error) {
        const message = describeVmError(ctx, call.error);
        call.error.dispose();
        return { kind: 'error', message };
      }
      const ret = call.value;

      // 返回值统一走 JSON：在 VM 内 stringify 后回宿主解析。
      // 不可序列化返回值（undefined / 函数 / 循环引用 / Symbol 等）
      // stringify 结果为 undefined，归为 error。
      ctx.setProp(ctx.global, '__ret', ret);
      ret.dispose();
      const jsonResult = ctx.evalCode(
        'JSON.stringify(globalThis.__ret)',
        '__ret.js',
        { type: 'global' },
      );
      const jsonHandle = ctx.unwrapResult(jsonResult);
      const isUndefined = ctx.typeof(jsonHandle) === 'undefined';
      let action: unknown;
      if (isUndefined) {
        jsonHandle.dispose();
        return {
          kind: 'error',
          message: 'strategy returned a non-serializable value',
        };
      }
      action = JSON.parse(ctx.getString(jsonHandle));
      jsonHandle.dispose();
      return { kind: 'ok', action };
    } catch (err) {
      return { kind: 'error', message: truncate(describeError(err)) };
    } finally {
      try {
        runtime.removeInterruptHandler();
      } catch {
        // runtime 已不可用则无需清理
      }
    }
  }

  async dispose(): Promise<void> {
    // 幂等：重复调用安全；act 在 dispose 后返回 error 而不抛出。
    const ctx = this.ctx;
    this.ctx = undefined;
    this.budget = undefined;
    this.disposed = true;
    if (ctx) {
      try {
        ctx.dispose();
      } catch {
        // ignore（含 dispose ctx 时连带释放 runtime）
      }
    }
  }
}

export class QuickJsSandboxFactory implements SandboxFactory {
  create(): StrategySandbox {
    return new QuickJsSandbox();
  }
}
