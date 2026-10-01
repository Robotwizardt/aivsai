/**
 * 坦克大战平滑补间渲染器：
 * 逻辑帧以离散间隔（默认 50ms = 20 FPS）到达，直接逐帧绘制会显得"跳跃"。
 * 本模块在相邻两帧之间按 requestAnimationFrame（≈60 FPS）线性插值
 * 坦克位置/朝向与子弹位置，输出平滑动画。
 *
 * 注意：
 * - 补间只影响视觉，不影响逻辑（tick、HP、命中判定仍按离散帧）。
 * - 帧到达快于渲染时只保留最新两帧（旧的直接丢弃）。
 * - 坦克方向是离散的 0/1/2/3，插值按最短路径旋转（0→3 是逆时针 90°）。
 */

import { renderTankFrame } from './tank-renderer';
import { TankGameState } from './types';

export interface TankInterpolatorOptions {
  /** 逻辑帧间隔（ms），即补间时长。默认 50（20 FPS 逻辑帧 → 60 FPS 渲染）。 */
  frameDuration?: number;
}

export class TankInterpolator {
  private prevFrame: TankGameState | null = null;
  private currentFrame: TankGameState | null = null;
  /** 补间起点时间（performance.now()）。 */
  private segmentStart = 0;
  private animationId: number | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameDuration: number;

  constructor(options: TankInterpolatorOptions = {}) {
    this.frameDuration = options.frameDuration ?? 50;
  }

  /** 调整补间时长（回放变速时调用）。 */
  setFrameDuration(ms: number): void {
    if (ms > 0) this.frameDuration = ms;
  }

  /**
   * 接收新帧并启动/推进补间动画。
   * 从"上一帧"平滑过渡到"当前帧"，用时 frameDuration 毫秒。
   */
  pushFrame(state: TankGameState, ctx: CanvasRenderingContext2D): void {
    this.prevFrame = this.currentFrame;
    this.currentFrame = state;
    this.segmentStart = performance.now();
    this.ctx = ctx;

    if (this.animationId === null) {
      this.animationId = requestAnimationFrame(this.step);
    }
    // 已有动画在跑：无需重启，step 每帧都会读最新的 prev/current
  }

  /** 直接绘制当前最新帧（无补间）。用于拖动进度条等跳帧场景。 */
  drawImmediate(state: TankGameState, ctx: CanvasRenderingContext2D): void {
    this.stop();
    this.prevFrame = state;
    this.currentFrame = state;
    this.ctx = ctx;
    renderTankFrame(ctx, state);
  }

  private step = (): void => {
    const { currentFrame, ctx } = this;
    if (!currentFrame || !ctx) {
      this.animationId = null;
      return;
    }

    const elapsed = performance.now() - this.segmentStart;
    const t = Math.min(1, elapsed / this.frameDuration);

    renderInterpolatedFrame(ctx, this.prevFrame, currentFrame, t);

    if (t >= 1) {
      // 到达当前帧：停止动画，等下一帧到达
      this.animationId = null;
      return;
    }
    this.animationId = requestAnimationFrame(this.step);
  };

  /** 停止动画（组件卸载时调用）。 */
  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
}

/** 渲染插值帧（t=0 完全是 prev，t=1 完全是 current）。 */
export function renderInterpolatedFrame(
  ctx: CanvasRenderingContext2D,
  prev: TankGameState | null,
  current: TankGameState,
  t: number,
): void {
  // 无 prev（首帧）或已到达终点：直接绘制 current
  if (!prev || t >= 1) {
    renderTankFrame(ctx, current);
    return;
  }
  renderTankFrame(ctx, interpolateState(prev, current, t));
}

/** 插值 state：坦克位置/方向、子弹位置。 */
function interpolateState(
  prev: TankGameState,
  current: TankGameState,
  t: number,
): TankGameState {
  const result: TankGameState = { ...current };

  // 坦克插值（按下标对应；双方坦克数量固定为 2，顺序稳定）
  result.tanks = current.tanks.map((tank, i) => {
    const prevTank = prev.tanks[i];
    if (!prevTank) return tank;
    return {
      ...tank,
      x: lerp(prevTank.x, tank.x, t),
      y: lerp(prevTank.y, tank.y, t),
      direction: lerpDirection(prevTank.direction, tank.direction, t),
    };
  });

  // 子弹插值（无稳定 id：用 x+y+direction+owner 做近似匹配，
  // 匹配不到就保持当前位置——新出生的子弹本就没有 prev）
  result.bullets = current.bullets.map((bullet) => {
    const prevBullet = prev.bullets.find(
      (b) => b.owner === bullet.owner && b.direction === bullet.direction,
    );
    if (!prevBullet) return bullet;
    return {
      ...bullet,
      x: lerp(prevBullet.x, bullet.x, t),
      y: lerp(prevBullet.y, bullet.y, t),
    };
  });

  return result;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 方向插值（0=北 1=东 2=南 3=西）。
 * 按最短路径旋转：0→3 是逆时针 90°，不是顺时针 270°。
 * 返回整型方向（渲染器按整数方向查表）。
 */
function lerpDirection(prev: number, current: number, t: number): number {
  let diff = current - prev;
  // 处理环绕：3→0 应为 +1，不是 -3
  if (diff > 2) diff -= 4;
  if (diff < -2) diff += 4;
  const interpolated = prev + diff * t;
  // 过半即切换方向（转向是瞬间动作，视觉上中途切换最自然）
  return ((Math.round(interpolated) % 4) + 4) % 4;
}
