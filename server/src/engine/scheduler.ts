/**
 * 对局调度器（ADR 0003：容量与排队）。
 *
 * - 正式 + 训练合计最多 maxConcurrent（默认 20）并发；
 * - official 优先于 training（同优先级 FIFO，训练不会被饿死——
 *   排队中无 official 时训练立即获得名额）；
 * - 每个用户并行占用上限 perUser（默认 2）。
 */

export type SchedulerTaskKind = 'official' | 'training';

export interface SchedulerTask {
  readonly kind: SchedulerTaskKind;
  readonly userId: string;
  /** 真正开跑后执行；其 promise 完成视为任务完成。 */
  readonly run: () => Promise<void>;
}

export interface SchedulerOptions {
  /** 总并发上限（official + training 合计），默认 20。 */
  readonly maxConcurrent?: number;
  /** 单用户并行占用上限，默认 2。 */
  readonly perUser?: number;
  /** 轮询间隔（backstop），默认 200ms；0 表示禁用轮询。 */
  readonly pollMs?: number;
}

interface QueueEntry {
  readonly seq: number;
  readonly task: SchedulerTask;
  readonly settle: () => void;
  readonly fail: (err: unknown) => void;
}

const PRIORITY: Readonly<Record<SchedulerTaskKind, number>> = {
  official: 0,
  training: 1,
};

export class Scheduler {
  private readonly maxConcurrent: number;
  private readonly perUser: number;
  private readonly pollMs: number;

  private queue: QueueEntry[] = [];
  private seq = 0;
  private active = 0;
  private readonly userActive = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SchedulerOptions = {}) {
    if (options.maxConcurrent !== undefined && options.maxConcurrent < 1) {
      throw new Error('maxConcurrent 必须 >= 1');
    }
    if (options.perUser !== undefined && options.perUser < 1) {
      throw new Error('perUser 必须 >= 1');
    }
    this.maxConcurrent = options.maxConcurrent ?? 20;
    this.perUser = options.perUser ?? 2;
    this.pollMs = options.pollMs ?? 200;
  }

  /**
   * 入队一个任务；返回的 promise 在任务真正开跑并完成之后 resolve
   * （即 await enqueue(...) 等价于等待该任务执行完毕）。
   */
  enqueue(task: SchedulerTask): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { seq: this.seq++, task, settle: resolve, fail: reject };
      this.insertSorted(entry);
      this.ensureTimer();
      this.drain();
    });
  }

  /** 当前正在执行的任务数。 */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队中的任务数。 */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** 停止后台轮询（进行中的任务不受影响）。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 按优先级（official < training）+ FIFO 序插入队列。 */
  private insertSorted(entry: QueueEntry): void {
    const priority = PRIORITY[entry.task.kind];
    let i = this.queue.length;
    while (i > 0) {
      const prev = this.queue[i - 1]!;
      if (PRIORITY[prev.task.kind] <= priority) break;
      i--;
    }
    this.queue.splice(i, 0, entry);
  }

  private ensureTimer(): void {
    if (this.timer === null && this.pollMs > 0) {
      this.timer = setInterval(() => this.drain(), this.pollMs);
      // 不阻止进程退出
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      // 队列已按优先级排序；跳过用户额度已满的队首条目
      const idx = this.queue.findIndex(
        (e) => (this.userActive.get(e.task.userId) ?? 0) < this.perUser,
      );
      if (idx < 0) break;
      const entry = this.queue.splice(idx, 1)[0]!;
      void this.start(entry);
    }
    if (this.queue.length === 0 && this.active === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async start(entry: QueueEntry): Promise<void> {
    this.active++;
    const uid = entry.task.userId;
    this.userActive.set(uid, (this.userActive.get(uid) ?? 0) + 1);
    try {
      await entry.task.run();
      entry.settle();
    } catch (err) {
      entry.fail(err);
    } finally {
      this.active--;
      const remaining = (this.userActive.get(uid) ?? 1) - 1;
      if (remaining > 0) this.userActive.set(uid, remaining);
      else this.userActive.delete(uid);
      this.drain();
    }
  }
}
