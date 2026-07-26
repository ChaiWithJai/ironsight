/**
 * The clock. CORE owns this file.
 *
 * `simTime` is DERIVED FROM THE TICK COUNT, never from the wall clock. This is
 * the file (with profiler.ts) where `performance.now()` is allowed; anywhere
 * else it is a determinism defect, because a shot that renders 32 fixed-dt
 * frames must produce identical world state on a workstation and under
 * SwiftShader at 40× the frame time.
 */
import { Sim, type Clock } from '@/engine/types';

/**
 * Integer microseconds per tick. `Math.round(1e6/60) = 16667`, and the harness
 * feeds `dt = 1/60` whose rounded microsecond value is also 16667 — so a capture
 * gets EXACTLY one tick per `stepFrame()` and `alpha` lands on 0 every frame.
 * Change this and captures stop being bit-comparable.
 */
export const TICK_MICROS = Math.round(1e6 / Sim.TICK_HZ);

/** EMA half-life for the fps/frame-time readouts, in frames. Cosmetic only. */
const EMA_ALPHA = 0.08;

/**
 * The project's ONE wall-clock source, exported so that bake-duration reporting
 * and the profiler do not have to reach for `performance.now()` in their own
 * files (`tools/check-boundaries.mjs` greps for it everywhere but here and
 * `profiler.ts`). NOTHING the simulation reads may derive from this — gameplay
 * time is `Clock.simTime`, which comes from the tick count.
 */
export function nowMs(): number {
  return performance.now();
}

export class EngineClock implements Clock {
  tick = 0;
  frame = 0;
  alpha = 0;
  frameDt = 0;
  fpsEma = 60;
  frameMsEma = 16.6;
  deterministic = false;

  /** Wall-clock timestamp of the previous rAF callback, ms. -1 = first frame. */
  private lastFrameMs = -1;

  get simTime(): number {
    return this.tick * Sim.TICK_DT;
  }

  /** Real seconds since the last rendered frame, clamped. Returns the clamped dt. */
  beginFrame(nowMs: number): number {
    let dt = this.lastFrameMs < 0 ? Sim.TICK_DT : (nowMs - this.lastFrameMs) / 1000;
    this.lastFrameMs = nowMs;
    if (!(dt > 0)) dt = Sim.TICK_DT;
    if (dt > Sim.MAX_FRAME_DT) dt = Sim.MAX_FRAME_DT;
    this.frameDt = dt;
    const ms = dt * 1000;
    this.frameMsEma += (ms - this.frameMsEma) * EMA_ALPHA;
    this.fpsEma += (1 / dt - this.fpsEma) * EMA_ALPHA;
    return dt;
  }

  /** Deterministic path: the harness supplies dt, so wall clock never enters. */
  beginFixedFrame(dt: number): number {
    this.frameDt = dt;
    this.frameMsEma = dt * 1000;
    this.fpsEma = 1 / dt;
    return dt;
  }

  advanceTick(): void {
    this.tick++;
  }

  endFrame(alpha: number): void {
    this.alpha = alpha;
    this.frame++;
  }

  /**
   * Re-enter a known state between captures. The tick counter is NOT reset:
   * shader `time` uniforms that jump backwards re-trigger every temporal filter,
   * and the harness already clears histories separately. What must reset is the
   * wall-clock anchor, or the first live frame after a capture sees a 40 s dt.
   */
  resetTiming(): void {
    this.lastFrameMs = -1;
    this.alpha = 0;
  }

  now(): number {
    return performance.now();
  }
}
