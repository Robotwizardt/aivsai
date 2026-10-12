/**
 * 表演赛服务（ADR 0017）：座位协议 + 对局生命周期 + SeatHandle 适配器。
 *
 * 核心思想：引擎只依赖 EntrantHandle.act 接口——把实现从「QuickJS 沙箱回调」
 * 换成「等待外部 HTTP 提交」，帧循环、LiveHub 直播、回放落库语义全部复用
 * （此处为无沙箱的最小循环，与 MatchRunner 同构）。
 *
 * 关键语义：
 * - 创建即开跑：createExhibition 落库后自动 runMatch；runMatch 幂等，
 *   重复调用返回同一场对局的完成 Promise；
 * - 座位协议：observe 轮询局面（挂起 act 的 observation），act 提交行动；
 *   提交后等待引擎处理完本步再返回（响应返回时下一待命座位已就位）；
 * - 非法行动：游戏包 validateAction 预校验 → HTTP 400 + 原因；同时 reject
 *   挂起的 act，引擎按策略错误计数（与五子棋 3 次判负一致），AI 可立即重试；
 * - 每步时限：扫描器检测超时 → 直接落判负结果（不走引擎错误计数）；
 * - 解散 / 首手超时作废：取消对局，结果记 invalid，密钥即刻失效；
 * - 暂停：冻结计时（stepStartedAt 平移），座位 API 返回 paused / 409。
 *
 * 注：tickDelayMs > 0 时，act 返回与下一座位待命之间存在延迟窗口
 * （默认 0，逐手由外部 AI 节奏决定，无此问题）。
 */

import type { EntrantHandle, GamePackage, MatchResult, TurnBasedFrameState } from '../games/contracts.js';
import type { ExhibitionStore } from './exhibition-store.js';
import type { LiveHub } from '../engine/live-hub.js';
import type { MatchStore } from '../engine/match-store.js';
import type { MatchRecord } from '../engine/match-contracts.js';
import { FIRST_MOVE_DEADLINE_MS } from './exhibition-contracts.js';

/** 服务层错误：带 HTTP 状态码（路由层直接透传）。 */
export class ExhibitionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ExhibitionError';
  }
}

export interface ExhibitionServiceDeps {
  readonly exhibitionStore: ExhibitionStore;
  readonly matchStore: MatchStore;
  readonly liveHub: LiveHub;
  /** 已注册游戏包（含 createInstance）。 */
  readonly games: Map<string, GamePackage>;
  /** 时钟（测试注入）。 */
  readonly now?: () => number;
  /** 超时扫描间隔，默认 500ms；0 = 禁用（测试手动控制）。 */
  readonly timeoutScanMs?: number;
  /** 帧间延迟（表演赛逐手直播，默认 0）。 */
  readonly tickDelayMs?: number;
}

/** 座位观察结果（轮询响应）。 */
export interface SeatObserveResult {
  /** your-turn = 轮到你；waiting = 等对手；paused = 暂停中；finished = 已结束。 */
  readonly status: 'your-turn' | 'waiting' | 'paused' | 'finished';
  readonly side: 0 | 1;
  /** your-turn 时的该方视角观察数据（游戏包定义）。 */
  readonly observation?: unknown;
  /** 已接受的行动数（手数）；被拒绝的行动不计，终局后取最后一帧的真值。 */
  readonly moveCount: number;
  /** 你的步时剩余毫秒（your-turn 时提供）。 */
  readonly remainingMs?: number;
  /** 状态语义提示（AI 文档）。 */
  readonly hint?: string;
  /** 游戏 ID（座位页据此分派棋盘渲染器；ADR 0018）。 */
  readonly gameId?: string;
}

/** 引擎侧挂起的一次 act 调用（等待 HTTP 提交）。 */
interface PendingAct {
  readonly resolve: (action: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly observation: unknown;
  readonly createdAt: number;
}

/** 一场进行中表演赛的运行时状态（内存态）。 */
interface RunningExhibition {
  readonly matchId: string;
  /** 座位 0/1 的挂起 act（同一时间至多一个挂起）。 */
  readonly pending: [PendingAct | null, PendingAct | null];
  /** 已成功提交的手数。 */
  moveCount: number;
  /** 引擎当前在等哪方（-1 = 尚未询问）。 */
  currentSide: -1 | 0 | 1;
  /** 本步计时起点（每个决策点重置）。 */
  stepStartedAt: number;
  /** 暂停时间点（null = 未在暂停中）；恢复时把暂停时长从计时里扣除。 */
  stepFrozenAt: number | null;
  /** 座位已提交过行动（首手后锁定自报名称）。 */
  sideActed: [boolean, boolean];
  /** 取消标记（超时/解散/作废）：主循环退出后以 finalResult 收场。 */
  cancelled: boolean;
  /** 取消时服务层直接落的对局结果。 */
  finalResult: MatchResult | null;
  finalPhase: 'finished' | 'invalid';
  /** 当前步完成信号：引擎处理完该步（帧落库+推送、下一座位待命）后 resolve。 */
  stepDone: Promise<void> | null;
  settleStepDone: (() => void) | null;
  /** 完成信号（重复 runMatch 返回同一 Promise）。 */
  readonly completion: Promise<MatchRecord>;
  readonly resolveCompletion: (record: MatchRecord) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

export class ExhibitionService {
  private readonly store: ExhibitionStore;
  private readonly matchStore: MatchStore;
  private readonly liveHub: LiveHub;
  private readonly games: Map<string, GamePackage>;
  private readonly now: () => number;
  private readonly running = new Map<string, RunningExhibition>();
  private readonly timeoutScanMs: number;
  private readonly tickDelayMs: number;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ExhibitionServiceDeps) {
    this.store = deps.exhibitionStore;
    this.matchStore = deps.matchStore;
    this.liveHub = deps.liveHub;
    this.games = deps.games;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutScanMs = deps.timeoutScanMs ?? 500;
    this.tickDelayMs = deps.tickDelayMs ?? 0;
  }

  // ---------------------------------------------------------------- 创建

  /**
   * 创建表演赛（校验限额 + 游戏存在），并立即开跑（创建即开跑）。
   * 返回记录不含座位密钥——密钥用 listSeatKeys 另取（创建者/管理员）。
   */
  createExhibition(input: {
    gameId: string;
    creatorUserId: string;
    title?: string;
    perMoveTimeoutMs?: number;
    isPublic?: boolean;
  }) {
    const game = this.games.get(input.gameId);
    if (!game) {
      throw new ExhibitionError(404, '游戏不存在');
    }
    // ADR 0017：座位协议需同步校验非法行动 + 轮次制；未声明 exhibitionEligible 的游戏（如坦克）不可建表演赛。
    if (!game.definition.exhibitionEligible) {
      throw new ExhibitionError(400, `游戏 ${game.definition.name} 暂不支持表演赛`);
    }
    let record;
    try {
      record = this.store.create(input);
    } catch (err) {
      // 限额超限 → 429（ADR 0017）
      throw new ExhibitionError(429, err instanceof Error ? err.message : String(err));
    }
    // 创建即开跑：后台驱动对局（不阻塞创建响应；失败不影响记录存在）
    this.runMatch(record.matchId).catch(() => undefined);
    return record;
  }

  // ---------------------------------------------------------------- 座位协议

  /** 座位观察（AI 轮询入口）：局面 + 轮转状态 + 步时。 */
  async observe(seatKey: string): Promise<SeatObserveResult> {
    const { matchId, side } = this.requireSeat(seatKey);
    const ex = this.store.get(matchId);
    if (!ex) throw new ExhibitionError(404, '对局不存在');
    if (ex.finishedAt !== null) {
      return { status: 'finished', side, moveCount: this.moveCountOf(matchId), gameId: ex.gameId };
    }
    if (ex.voidedAt !== null) {
      return { status: 'finished', side, moveCount: this.moveCountOf(matchId), hint: '对局已作废', gameId: ex.gameId };
    }
    const run = this.running.get(matchId);
    if (!run) {
      // 防御分支：创建即开跑后正常不会走到（runMatch 前置失败等异常场景）
      return {
        status: side === 0 ? 'your-turn' : 'waiting',
        side,
        moveCount: 0,
        remainingMs: Math.max(0, ex.perMoveTimeoutMs - (this.now() - ex.createdAt)),
        hint: '对局即将开始',
        gameId: ex.gameId,
      };
    }
    if (ex.paused) {
      return { status: 'paused', side, moveCount: run.moveCount, hint: '对局暂停中，请稍后重试', gameId: ex.gameId };
    }
    if (run.currentSide === side && run.pending[side]) {
      return {
        status: 'your-turn',
        side,
        observation: run.pending[side]!.observation,
        moveCount: run.moveCount,
        remainingMs: Math.max(0, ex.perMoveTimeoutMs - (this.now() - run.stepStartedAt)),
        gameId: ex.gameId,
      };
    }
    if (run.currentSide === -1) {
      return { status: side === 0 ? 'your-turn' : 'waiting', side, moveCount: 0, gameId: ex.gameId };
    }
    return { status: 'waiting', side, moveCount: run.moveCount, hint: '等待对手行动', gameId: ex.gameId };
  }

  /** 座位提交行动（AI 落子入口）。非法行动 400 + 原因；未轮到/暂停/已结束 409。 */
  async act(seatKey: string, action: unknown): Promise<{ ok: true }> {
    const { matchId, side } = this.requireSeat(seatKey);
    const ex = this.store.get(matchId);
    if (!ex) throw new ExhibitionError(404, '对局不存在');
    if (ex.finishedAt !== null || ex.voidedAt !== null) {
      throw new ExhibitionError(409, '对局已结束');
    }
    if (ex.paused) {
      throw new ExhibitionError(409, '对局暂停中，请等待恢复后重试');
    }
    const run = this.running.get(matchId);
    if (!run) throw new ExhibitionError(409, '对局尚未开始，请稍后重试');
    if (run.cancelled) throw new ExhibitionError(409, '对局已结束');
    const pending = run.pending[side];
    if (!pending) {
      throw new ExhibitionError(409, run.currentSide === side ? '请先观察局面后重试' : '未轮到你');
    }
    const stepDone = run.stepDone;

    // 预校验（游戏包提供时）：非法行动 400 + 原因；同时 reject 挂起的 act，
    // 引擎按策略错误计数（3 次判负），座位可立即重试（引擎会重新询问该方）。
    const validate = this.games.get(ex.gameId)?.validateAction;
    if (validate) {
      const error = validate(action, pending.observation);
      if (error !== null) {
        run.pending[side] = null;
        pending.reject(new Error(error));
        if (stepDone) await stepDone;
        throw new ExhibitionError(400, error);
      }
    }

    run.pending[side] = null;
    run.moveCount += 1;
    run.sideActed[side] = true;
    pending.resolve(action);
    // 等引擎处理完本步（帧落库、直播推送、下一座位待命或对局结束）再响应
    if (stepDone) await stepDone;
    return { ok: true };
  }

  /** 座位自报名称（该方首手前有效；首手后锁定）。 */
  async setName(seatKey: string, name: string): Promise<boolean> {
    const { matchId, side } = this.requireSeat(seatKey);
    const ex = this.store.get(matchId);
    if (!ex) throw new ExhibitionError(404, '对局不存在');
    if (ex.finishedAt !== null || ex.voidedAt !== null) {
      throw new ExhibitionError(409, '对局已结束');
    }
    if (this.running.get(matchId)?.sideActed[side]) {
      throw new ExhibitionError(409, '已提交过行动，名称锁定');
    }
    const ok = this.store.setSeatName(matchId, side, name);
    if (!ok) throw new ExhibitionError(400, '名称无效（1-64 字符）');
    return true;
  }

  // ---------------------------------------------------------------- 查询

  /** 表演赛详情（路由层用）。 */
  getExhibition(matchId: string) {
    return this.store.get(matchId);
  }

  /** 公开表演赛列表（直播大厅；私密不进列表）。 */
  listPublic() {
    return this.store.listPublic();
  }

  /** 按创建者列出（含私密与已结束）。 */
  listByCreator(userId: string) {
    return this.store.listByCreator(userId);
  }

  /** 座位密钥列表（创建者/管理员查看座位链接用；对局结束后为空）。 */
  listSeatKeys(matchId: string) {
    return this.store.listSeatKeys(matchId);
  }

  // ---------------------------------------------------------------- 生命周期管理

  /** 暂停（创建者/管理员；冻结全部计时）。 */
  pause(matchId: string, byUserId: string, isAdmin = false): void {
    this.requireManager(matchId, byUserId, isAdmin);
    const ex = this.store.get(matchId)!;
    if (ex.finishedAt !== null || ex.voidedAt !== null) {
      throw new ExhibitionError(409, '对局已结束');
    }
    if (!this.store.setPaused(matchId, true)) {
      throw new ExhibitionError(409, '对局已结束');
    }
    const run = this.running.get(matchId);
    if (run && run.stepFrozenAt === null) run.stepFrozenAt = this.now();
  }

  /** 恢复（把暂停时长从本步计时里扣除）。 */
  resume(matchId: string, byUserId: string, isAdmin = false): void {
    this.requireManager(matchId, byUserId, isAdmin);
    if (!this.store.setPaused(matchId, false)) {
      throw new ExhibitionError(409, '对局未暂停或已结束');
    }
    const run = this.running.get(matchId);
    if (run && run.stepFrozenAt !== null) {
      run.stepStartedAt += this.now() - run.stepFrozenAt;
      run.stepFrozenAt = null;
    }
  }

  /** 解散（作废）：创建者/管理员；密钥即刻失效。 */
  async dissolve(matchId: string, byUserId: string, isAdmin = false): Promise<void> {
    this.requireManager(matchId, byUserId, isAdmin);
    const ex = this.store.get(matchId)!;
    if (ex.finishedAt !== null || ex.voidedAt !== null) {
      throw new ExhibitionError(409, '对局已结束');
    }
    this.store.void(matchId);
    this.cancelRun(
      matchId,
      { outcome: { kind: 'invalid', reason: '创建者解散，对局作废' }, failures: [] },
      'invalid',
      '对局已解散',
    );
  }

  // ---------------------------------------------------------------- 引擎驱动

  /**
   * 开跑一场表演赛：两个 SeatHandle 注入游戏实例，驱动 step 循环
   * （无沙箱、无节拍的最小循环；帧落库 + LiveHub 直播，与 MatchRunner 同构）。
   *
   * 幂等：同一场对局重复调用返回同一个完成 Promise。
   */
  async runMatch(matchId: string): Promise<MatchRecord> {
    const existing = this.running.get(matchId);
    if (existing) return existing.completion;
    const ex = this.store.get(matchId);
    if (!ex) throw new ExhibitionError(404, '对局不存在');
    if (ex.finishedAt !== null || ex.voidedAt !== null) {
      throw new ExhibitionError(409, '对局已结束');
    }
    const gamePackage = this.games.get(ex.gameId);
    if (!gamePackage) throw new ExhibitionError(500, `游戏包缺失: ${ex.gameId}`);

    // 对局记录：kind=exhibition（复用 matches 表；座位无策略版本，用 'seat' 占位）
    this.matchStore.create({
      matchId,
      gameId: ex.gameId,
      entrants: [
        { entrantId: `seat:${matchId}:0`, strategyVersionId: 'seat' },
        { entrantId: `seat:${matchId}:1`, strategyVersionId: 'seat' },
      ],
      kind: 'exhibition',
    });
    this.liveHub.attach(matchId, this.matchStore);

    let resolveCompletion!: (record: MatchRecord) => void;
    const completion = new Promise<MatchRecord>((resolve) => {
      resolveCompletion = resolve;
    });
    const run: RunningExhibition = {
      matchId,
      pending: [null, null],
      moveCount: 0,
      currentSide: -1,
      stepStartedAt: this.now(),
      stepFrozenAt: null,
      sideActed: [false, false],
      cancelled: false,
      finalResult: null,
      finalPhase: 'invalid',
      stepDone: null,
      settleStepDone: null,
      completion,
      resolveCompletion,
    };
    this.running.set(matchId, run);

    try {
      const handles: [EntrantHandle, EntrantHandle] = [
        this.makeSeatHandle(matchId, 0),
        this.makeSeatHandle(matchId, 1),
      ];
      const game = gamePackage.createInstance(handles);
      this.ensureScanner();

      let guard = 0;
      while (!run.cancelled && !game.isOver()) {
        if (++guard > 100_000) {
          throw new Error('对局超过最大帧数上限（疑似死循环）');
        }
        run.stepDone = new Promise<void>((resolve) => {
          run.settleStepDone = resolve;
        });
        const frame = await game.step();
        if (frame) {
          this.matchStore.updateFrame(matchId, frame);
          this.liveHub.publish(matchId, frame);
        }
        // 本步处理完毕：放行等待中的 act()（此时下一座位已在本同步块内待命）
        run.settleStepDone?.();
        run.stepDone = null;
        if (this.tickDelayMs > 0 && !run.cancelled && !game.isOver()) {
          await sleep(this.tickDelayMs);
        }
      }
      if (run.cancelled && run.finalResult) {
        // 超时判负 / 解散作废：服务层直接落结果
        this.matchStore.finish(matchId, run.finalResult, run.finalPhase);
      } else {
        const result = game.result();
        if (!result) {
          throw new Error('对局已结束但游戏未提供结果');
        }
        this.matchStore.finish(matchId, result, 'finished');
      }
    } catch (err) {
      // 平台侧异常 → invalid（对齐 MatchRunner 语义，不计成绩）
      const message = err instanceof Error ? err.message : String(err);
      this.matchStore.finish(
        matchId,
        { outcome: { kind: 'invalid', reason: `平台执行故障: ${message}` }, failures: [] },
        'invalid',
      );
    } finally {
      // 兜底放行异常路径下等待 stepDone 的 act()
      run.settleStepDone?.();
      const finalRecord = this.matchStore.get(matchId)!;
      this.running.delete(matchId);
      // exhibitions 表收尾：置 finishedAt + 删两把密钥（已作废则幂等跳过）
      this.store.finish(matchId);
      this.liveHub.publishEnd(matchId, finalRecord.result);
      run.resolveCompletion(finalRecord);
    }
    return this.matchStore.get(matchId)!;
  }

  /** 构造座位方的 EntrantHandle：act() 挂起，等待 HTTP 提交或被取消唤醒。 */
  private makeSeatHandle(matchId: string, side: 0 | 1): EntrantHandle {
    return {
      entrantId: `seat:${matchId}:${side}`,
      act: (observation: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const run = this.running.get(matchId);
          if (!run) {
            reject(new Error('对局运行态不存在'));
            return;
          }
          run.currentSide = side;
          run.stepStartedAt = this.now();
          run.pending[side] = { resolve, reject, observation, createdAt: this.now() };
        }),
    };
  }

  // ---------------------------------------------------------------- 取消与超时

  /**
   * 取消进行中的对局：置取消标记 + 记最终结果 + reject 挂起方唤醒主循环。
   * 引擎会把 reject 记为一次策略错误，但结果由服务层的 finalResult 覆盖。
   */
  private cancelRun(
    matchId: string,
    result: MatchResult,
    phase: 'finished' | 'invalid',
    wakeMessage: string,
  ): void {
    const run = this.running.get(matchId);
    if (!run || run.cancelled) return;
    run.cancelled = true;
    run.finalResult = result;
    run.finalPhase = phase;
    for (const side of [0, 1] as const) {
      const p = run.pending[side];
      if (p) {
        run.pending[side] = null;
        p.reject(new Error(wakeMessage));
      }
    }
  }

  private ensureScanner(): void {
    if (this.scanTimer === null && this.timeoutScanMs > 0) {
      this.scanTimer = setInterval(() => this.scanTimeouts(), this.timeoutScanMs);
      (this.scanTimer as { unref?: () => void }).unref?.();
    }
  }

  /** 扫描进行中表演赛：每步超时 → 判负；创建后 1 小时无第一手 → 作废。 */
  private scanTimeouts(): void {
    const now = this.now();
    for (const [matchId, run] of this.running) {
      if (run.cancelled) continue;
      const ex = this.store.get(matchId);
      if (!ex || ex.paused) continue;
      // 1 小时无第一手 → 自动作废（ADR 0017）
      if (run.moveCount === 0 && now - ex.createdAt >= FIRST_MOVE_DEADLINE_MS) {
        this.store.void(matchId);
        this.cancelRun(
          matchId,
          {
            outcome: {
              kind: 'invalid',
              reason: `创建后 ${FIRST_MOVE_DEADLINE_MS / 60000} 分钟无第一手，自动作废`,
            },
            failures: [],
          },
          'invalid',
          '对局自动作废',
        );
        continue;
      }
      // 当前挂起方的每步时限
      const pendingSide = run.pending[0] !== null ? 0 : run.pending[1] !== null ? 1 : null;
      if (pendingSide === null) continue;
      const elapsed = now - run.stepStartedAt;
      if (elapsed >= ex.perMoveTimeoutMs) {
        const seconds = Math.round(ex.perMoveTimeoutMs / 1000);
        this.cancelRun(
          matchId,
          {
            outcome: {
              kind: 'win',
              winner: pendingSide === 0 ? 1 : 0,
              reason: `参赛方 ${pendingSide} 每步超时（${seconds} 秒），判负`,
            },
            failures: [{ entrant: pendingSide, message: `每步超时（${seconds} 秒）` }],
          },
          'finished',
          `参赛方 ${pendingSide} 每步超时`,
        );
      }
    }
  }

  // ---------------------------------------------------------------- 内部工具

  private requireSeat(seatKey: string): { matchId: string; side: 0 | 1 } {
    const principal = this.store.authenticateSeat(seatKey);
    if (!principal) throw new ExhibitionError(401, '座位密钥无效');
    return principal;
  }

  private requireManager(matchId: string, actor: string, isAdmin = false): void {
    const ex = this.store.get(matchId);
    if (!ex) throw new ExhibitionError(404, '对局不存在');
    // ADR 0017：暂停/恢复/解散由创建者与管理员可用；actor 形如 "admin:<userId>" 时视为管理员。
    const isAdminActor = isAdmin || actor.startsWith('admin:');
    const userId = isAdminActor ? actor.slice(6) : actor;
    if (ex.creatorUserId !== userId && !isAdminActor) {
      throw new ExhibitionError(403, '只有创建者或管理员可操作');
    }
  }

  /**
   * 终局/作废后的真实手数：取最后一帧局面里的 moveCount。
   *
   * 不能用帧数代替：被拒绝的行动（非法/超时）同样会产出帧，帧数 ≥ 手数。
   * 无帧（创建后即作废）时回 0。
   */
  private moveCountOf(matchId: string): number {
    const record = this.matchStore.get(matchId);
    const state = record?.frames[record.frames.length - 1]?.state as TurnBasedFrameState | undefined;
    return typeof state?.moveCount === 'number' ? state.moveCount : 0;
  }

  /** 停止扫描器（测试/关停用）。 */
  shutdown(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}
