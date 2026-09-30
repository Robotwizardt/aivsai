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
  StrategyActionEnvelope,
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

/**
 * 单次 VM 调用的墙钟下限（毫秒）。
 *
 * 正常策略单次 act 只需几十微秒～几毫秒，但 QuickJS 调用本身、观察 JSON 序列化、
 * 宿主 GC 停顿都要计进墙钟。设得过紧（早先按“整局 2000ms ÷ 600 帧 ≈ 3.3ms”当单帧上限）
 * 会把平台自身开销误判成策略超时，让完全无害的策略被冤枉判负——这是直接影响
 * 对局胜负的正确性路径。这里给出单调用的最小可用余量，只在预算还剩很多时才放宽。
 */
const PER_CALL_CPU_MS_FLOOR = 200;

/**
 * budget.cpuMs 是【整局累计】CPU 预算（默认 2000ms）。
 * 真正限制总消耗的是累计记账：每帧实际用量累加，超支即判策略超时（见 accountCpu）。
 * 预估帧数只用于推导“单帧平均可用”，不直接当单帧上限。
 */
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

/**
 * 单次 VM 调用的墙钟时间上限（毫秒）。
 *
 * 在“剩余总预算”之下，给到至少一个 PER_CALL_CPU_MS_FLOOR，
 * 使正常策略不会被平台自身开销误伤；同时永远不超过剩余预算，
 * 保证累计消耗不会突破 budget.cpuMs。
 */
function frameCpuBudgetMs(budget: StrategyBudget, remainingMs: number): number {
  const perFrameAverage = budget.cpuMs / ASSUMED_FRAMES_PER_MATCH;
  return Math.max(1, Math.min(Math.max(perFrameAverage, PER_CALL_CPU_MS_FLOOR), remainingMs));
}

/** load 阶段（含 WASM 预热）的墙钟时间下限（毫秒）。 */
const LOAD_CPU_MS_FLOOR = 100;

/** 单次 act 命令队列上限：防止策略循环里爆队列。 */
const MAX_COMMANDS_PER_ACT = 64;
/** 单次 act 日志条数上限。 */
const MAX_LOGS_PER_ACT = 32;

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
  /** 整局累计已消耗的 CPU 时间（毫秒）。budget.cpuMs 是整局上限，越过即判策略超时。 */
  private cpuUsedMs = 0;

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
      const loadStart = Date.now();
      const loadDeadline = loadStart + frameCpuBudgetMs(budget, budget.cpuMs);
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
      // load 本身也算策略消耗：计入整局累计预算。
      this.cpuUsedMs += Math.max(0, Date.now() - loadStart);
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

    // 整局累计预算已耗尽：不再进 VM，直接判策略超时（ADR 0002 策略故障判负）。
    const remainingMs = budget.cpuMs - this.cpuUsedMs;
    if (remainingMs <= 0) {
      return {
        kind: 'error',
        message: `strategy exceeded total CPU budget (${budget.cpuMs}ms)`,
      };
    }

    const actStart = Date.now();
    try {
      // 单次调用的墙钟上限：既不会被平台自身开销误伤，也永远不超过剩余总预算。
      // 到点后中断 handler 让 QuickJS 停止执行，抛 InternalError("interrupted")——
      // 单帧内死循环的策略在这里被拦截。
      const deadline = actStart + frameCpuBudgetMs(budget, remainingMs);
      runtime.setInterruptHandler(() => Date.now() > deadline);

      // 观察数据以纯 JSON 文本传入 VM 再解析，宿主对象无法跨边界泄漏。
      // 契约是 onIdle(me, enemy, game)；游戏包观察字段不一（tank 用 self、
      // gomoku 用 me），在 VM 内归一化：me ← self|me，其余字段（tick/arena/
      // board/hitEvents 等）全部合并进 game，供策略按需读取。
      //
      // 命令队列（对齐 agentank 运行时）：onIdle 内策略调用 me.go() /
      // me.turn() / me.fire() / me.throwBomb() / me.speak() / me.place()
      // 不直接作用于引擎，而是排入本次调用的命令队列；print() 收集日志。
      // 队列与日志随返回值一起作为 act 结果交回引擎（StrategyActionEnvelope），
      // 由具体游戏包消费自己认识的命令类型。
      const obsJson = JSON.stringify(observation ?? {});
      const buildEnv = `(() => {
        const o = JSON.parse(${JSON.stringify(obsJson)});
        const meData = 'self' in o ? o.self : o.me;
        const game = { ...o, ...(o.game && typeof o.game === 'object' ? o.game : {}) };
        delete game.me; delete game.self; delete game.enemy; delete game.game;
        const commands = [];
        const logs = [];
        const push = (cmd) => { if (commands.length < ${MAX_COMMANDS_PER_ACT}) commands.push(cmd); };
        const me = { ...meData };
        me.go = (n) => {
          const count = n === undefined ? 1 : n;
          if (count >= 1) {
            const times = Number.isInteger(count) && count <= 10 ? count : 1;
            for (let i = 0; i < times; i++) push({ type: 'go' });
          }
        };
        me.turn = (dir) => { if (dir === 'left' || dir === 'right') push({ type: 'turn', dir }); };
        me.fire = () => push({ type: 'fire' });
        me.throwBomb = () => push({ type: 'bomb' });
        me.speak = (t) => push({ type: 'speak', text: String(t).slice(0, 40) });
        me.place = (x, y) => {
          if (Number.isInteger(x) && Number.isInteger(y)) push({ type: 'place', x, y });
        };
        globalThis.print = (...a) => {
          if (logs.length >= ${MAX_LOGS_PER_ACT}) return;
          const parts = a.map((x) => {
            try { return typeof x === 'string' ? x : JSON.stringify(x); }
            catch (e) { return String(x); }
          });
          logs.push(parts.join(' ').slice(0, 200));
        };
        return { me, enemy: o.enemy, game, commands, logs };
      })()`;
      const envResult = ctx.evalCode(buildEnv, '__obs.js', { type: 'global' });
      const env = ctx.unwrapResult(envResult);
      // 传入 VM 的只是 JSON 数据的副本句柄 + 命令队列钩子，不引用任何宿主 API。
      const me = ctx.getProp(env, 'me');
      const enemy = ctx.getProp(env, 'enemy');
      const game = ctx.getProp(env, 'game');
      const commands = ctx.getProp(env, 'commands');
      const logs = ctx.getProp(env, 'logs');
      env.dispose();

      const onIdle = ctx.getProp(ctx.global, 'onIdle');
      const call = ctx.callFunction(onIdle, ctx.undefined, me, enemy, game);
      onIdle.dispose();
      me.dispose();
      enemy.dispose();
      game.dispose();

      if (call.error) {
        const message = describeVmError(ctx, call.error);
        call.error.dispose();
        commands.dispose();
        logs.dispose();
        return { kind: 'error', message };
      }
      const ret = call.value;

      // 结果统一走 JSON：命令队列 + 日志 + 返回值在 VM 内打包为信封后
      // stringify 回宿主解析。返回值不可序列化（函数/循环引用等）时
      // returned 置 null——命令队列游戏不依赖返回值，不视为策略错误。
      ctx.setProp(ctx.global, '__envRet', ret);
      ret.dispose();
      ctx.setProp(ctx.global, '__envCmd', commands);
      commands.dispose();
      ctx.setProp(ctx.global, '__envLogs', logs);
      logs.dispose();
      const envelopeResult = ctx.evalCode(
        `JSON.stringify((() => {
          let returned = null;
          try {
            const s = JSON.stringify(globalThis.__envRet);
            if (s !== undefined) returned = JSON.parse(s);
          } catch (e) { returned = null; }
          return {
            commands: JSON.parse(JSON.stringify(globalThis.__envCmd)),
            logs: JSON.parse(JSON.stringify(globalThis.__envLogs)),
            returned,
          };
        })())`,
        '__envelope.js',
        { type: 'global' },
      );
      const envelopeHandle = ctx.unwrapResult(envelopeResult);
      const envelopeText = ctx.getString(envelopeHandle) ?? '{"commands":[],"logs":[],"returned":null}';
      envelopeHandle.dispose();
      const action = JSON.parse(envelopeText) as StrategyActionEnvelope;
      return { kind: 'ok', action };
    } catch (err) {
      return { kind: 'error', message: truncate(describeError(err)) };
    } finally {
      try {
        runtime.removeInterruptHandler();
      } catch {
        // runtime 已不可用则无需清理
      }
      // 记账：本帧实际用量计入整局累计，后续帧据此收窄可用时间。
      this.cpuUsedMs += Math.max(0, Date.now() - actStart);
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
