/**
 * 直播推送中枢（ADR 0003：对局运行过程中提供直播）。
 *
 * runner 每产生一帧调用 publish；观众通过 subscribe 建立连接，
 * 订阅时先同步重放 fromTick 起的历史帧（追进度 backstop），
 * 之后接收增量帧与结束信号。
 */

import type { FrameSnapshot, MatchResult } from '../games/contracts.js';
import type { LiveFeed, MatchRecord } from './match-contracts.js';
import type { MatchStore } from './match-store.js';

export type OnFrame = (frame: FrameSnapshot) => void;
export type OnEnd = (result: MatchResult | null) => void;

interface Subscriber {
  readonly fromTick: number;
  readonly onFrame: OnFrame;
  readonly onEnd: OnEnd;
}

export class LiveHub {
  /** matchId -> 订阅者集合 */
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /** matchId -> attach 时绑定的 store（用于历史帧重放） */
  private readonly stores = new Map<string, MatchStore>();

  /** 将一场对局的记录与本 hub 关联；runner 推流前调用。 */
  attach(matchId: string, store: MatchStore): void {
    this.stores.set(matchId, store);
    if (!this.subscribers.has(matchId)) {
      this.subscribers.set(matchId, new Set());
    }
  }

  /** runner 每帧调用：推送给该对局所有活跃订阅者。 */
  publish(matchId: string, frame: FrameSnapshot): void {
    for (const sub of this.subscribers.get(matchId) ?? []) {
      if (frame.tick >= sub.fromTick) {
        try {
          sub.onFrame(frame);
        } catch {
          // 订阅者回调异常不影响对局推进
        }
      }
    }
  }

  /** 对局结束：向所有订阅者推送结束信号并清空集合。 */
  publishEnd(matchId: string, result: MatchResult | null): void {
    const subs = this.subscribers.get(matchId);
    if (!subs) return;
    for (const sub of subs) {
      try {
        sub.onEnd(result);
      } catch {
        // 同上
      }
    }
    subs.clear();
  }

  /**
   * 订阅某场对局的增量帧与结束信号；返回取消函数。
   * 订阅时先同步重放 framesFrom(fromTick)（backstop，防丢帧），
   * 若对局已结束则立即回调 onEnd。
   */
  subscribe(matchId: string, fromTick: number, onFrame: OnFrame, onEnd: OnEnd): () => void {
    // 1) 同步重放历史帧
    const record = this.stores.get(matchId)?.get(matchId);
    if (record) {
      for (const frame of record.frames) {
        if (frame.tick >= fromTick) onFrame(frame);
      }
    }

    // 2) 注册增量订阅
    const sub: Subscriber = { fromTick, onFrame, onEnd };
    let subs = this.subscribers.get(matchId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(matchId, subs);
    }
    subs.add(sub);

    // 3) attach 后从未收到 publishEnd、但对局实际已结束（迟到的订阅者）
    if (record && (record.phase === 'finished' || record.phase === 'invalid')) {
      subs.delete(sub);
      onEnd(record.result);
    }

    return () => {
      subs.delete(sub);
    };
  }

  detach(matchId: string): void {
    this.subscribers.delete(matchId);
    this.stores.delete(matchId);
  }

  /** 以 match-contracts.ts 的 LiveFeed 接口暴露某场对局的订阅能力。 */
  liveFeed(matchId: string): LiveFeed {
    const store = this.stores.get(matchId);
    const framesFrom = (fromTick: number): FrameSnapshot[] => {
      const record: MatchRecord | undefined = store?.get(matchId);
      return record ? record.frames.filter((f) => f.tick >= fromTick) : [];
    };
    return {
      framesFrom,
      subscribe: (onFrame: OnFrame, onEnd: OnEnd): (() => void) =>
        this.subscribe(matchId, 0, onFrame, onEnd),
    };
  }
}
