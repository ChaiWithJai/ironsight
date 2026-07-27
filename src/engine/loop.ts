/**
 * The frame lifecycle: integer-µs accumulator, TickPhase and RenderStage
 * dispatch. CORE owns this file.
 *
 *   requestAnimationFrame(t)
 *     frameDt   = min(t - tPrev, Sim.MAX_FRAME_DT)
 *     accumMicros += round(frameDt * 1e6)          ← INTEGER µs
 *     while accumMicros >= TICK_MICROS and ticks < MAX_CATCHUP_TICKS:
 *         runTick(); accumMicros -= TICK_MICROS
 *     if ticks hit the ceiling: accumMicros = 0    ← drop time, never spiral
 *     alpha = accumMicros / TICK_MICROS
 *     runFrame(alpha)
 *
 * THREE THINGS HERE ARE LOAD-BEARING
 * ----------------------------------
 * 1. The accumulator is INTEGER MICROSECONDS. A float accumulator drifts: at
 *    60 Hz the residual error compounds into a visible extra-tick stutter every
 *    few minutes, and worse, it drifts *differently* on two machines, which
 *    breaks bit-comparable captures.
 * 2. The catch-up ceiling DROPS TIME rather than spiralling. If a tick ever
 *    costs more than the tick interval, an uncapped accumulator asks for more
 *    ticks, which cost more time, which asks for more ticks. Five is enough to
 *    absorb a GC pause and small enough that a real stall shows as slow motion
 *    for one frame instead of a lock-up.
 * 3. Systems within one phase MUST be order-independent of each other. That is
 *    the rule that lets sixteen agents register updaters without negotiating.
 *    Registration order is the tiebreak so behaviour is at least deterministic,
 *    but relying on it is a defect.
 */
import { Sim, type FrameCtx, type RenderStage, type RenderSystem, type TickCtx, type TickPhase, type TickSystem } from '@/engine/types';
import { TICK_MICROS } from '@/engine/clock';
import type { EngineProfiler } from '@/engine/profiler';

interface Registered<T> {
  system: T;
  /** Registration sequence — the deterministic tiebreak inside a phase. */
  seq: number;
}

export class FrameLoop {
  private readonly ticks: Registered<TickSystem>[] = [];
  private readonly renders: Registered<RenderSystem>[] = [];
  private seq = 0;
  private tickDirty = false;
  private renderDirty = false;

  /** Integer microseconds of simulation time owed. Never a float. */
  private accumulatorMicros = 0;
  private lastTickCount = 0;

  /**
   * Per-system CALL counts, off by default.
   *
   * `describe()` answers "what is REGISTERED at TickPhase.Ai", which is not the
   * same question as "is it being CALLED every tick" — and the two failure modes
   * (a lane that forgot to register, and a lane whose system runs but does
   * nothing) are indistinguishable from the outside. The soak instrument
   * (`src/engine/soak.ts`, driven by `tools/soak.mjs`) turns this on for the
   * duration of a run and reports both numbers side by side, so "bots do not
   * move" resolves to a phase rather than to a lane's honour.
   *
   * A Map lookup and an increment per system per tick is ~30 ops at 60 Hz; it is
   * still gated so the live game pays literally nothing.
   */
  private counting = false;
  private readonly tickCalls = new Map<string, number>();
  private readonly renderCalls = new Map<string, number>();

  constructor(private readonly profiler: EngineProfiler) {}

  addTick(system: TickSystem): () => void {
    const entry: Registered<TickSystem> = { system, seq: this.seq++ };
    this.ticks.push(entry);
    this.tickDirty = true;
    return () => {
      const i = this.ticks.indexOf(entry);
      if (i >= 0) this.ticks.splice(i, 1);
    };
  }

  addRender(system: RenderSystem): () => void {
    const entry: Registered<RenderSystem> = { system, seq: this.seq++ };
    this.renders.push(entry);
    this.renderDirty = true;
    return () => {
      const i = this.renders.indexOf(entry);
      if (i >= 0) this.renders.splice(i, 1);
    };
  }

  private sortTicks(): void {
    if (!this.tickDirty) return;
    this.ticks.sort((a, b) => {
      const pa = a.system.phase as number;
      const pb = b.system.phase as number;
      if (pa !== pb) return pa - pb;
      const oa = a.system.order ?? 0;
      const ob = b.system.order ?? 0;
      if (oa !== ob) return oa - ob;
      return a.seq - b.seq;
    });
    this.tickDirty = false;
  }

  private sortRenders(): void {
    if (!this.renderDirty) return;
    this.renders.sort((a, b) => {
      const sa = a.system.stage as number;
      const sb = b.system.stage as number;
      if (sa !== sb) return sa - sb;
      const oa = a.system.order ?? 0;
      const ob = b.system.order ?? 0;
      if (oa !== ob) return oa - ob;
      return a.seq - b.seq;
    });
    this.renderDirty = false;
  }

  /**
   * Advance the accumulator by one real frame and run the ticks it buys.
   * Returns `alpha`, the 0..1 fraction into the next tick that the render side
   * interpolates with. Under the harness (dt = 1/60) this is exactly 0.
   */
  advance(frameDt: number, runTick: () => void): { ticks: number; alpha: number } {
    const clamped = Math.min(frameDt, Sim.MAX_FRAME_DT);
    this.accumulatorMicros += Math.round(clamped * 1e6);

    let ticks = 0;
    while (this.accumulatorMicros >= TICK_MICROS && ticks < Sim.MAX_CATCHUP_TICKS) {
      runTick();
      this.accumulatorMicros -= TICK_MICROS;
      ticks++;
    }
    if (ticks === Sim.MAX_CATCHUP_TICKS) {
      // We are behind by more than the catch-up budget. Drop the debt; a frame
      // of slow motion is recoverable, a spiral is not.
      this.accumulatorMicros = 0;
    }
    this.lastTickCount = ticks;
    return { ticks, alpha: this.accumulatorMicros / TICK_MICROS };
  }

  get lastTicks(): number {
    return this.lastTickCount;
  }

  /** Discard owed simulation time. Used when entering a capture. */
  resetAccumulator(): void {
    this.accumulatorMicros = 0;
  }

  /** Dispatch every TickSystem in ascending phase, then order, then registration. */
  runTick(ctx: TickCtx): void {
    this.sortTicks();
    const list = this.ticks;
    for (let i = 0; i < list.length; i++) {
      const s = list[i].system;
      if (this.counting) this.tickCalls.set(s.name, (this.tickCalls.get(s.name) ?? 0) + 1);
      this.profiler.begin(s.name);
      s.tick(ctx);
      this.profiler.end(s.name);
    }
  }

  /** Dispatch every RenderSystem in ascending stage, ending in RenderStage.Submit. */
  runFrame(ctx: FrameCtx): void {
    this.sortRenders();
    const list = this.renders;
    for (let i = 0; i < list.length; i++) {
      const s = list[i].system;
      if (this.counting) this.renderCalls.set(s.name, (this.renderCalls.get(s.name) ?? 0) + 1);
      this.profiler.begin(s.name);
      s.update(ctx);
      this.profiler.end(s.name);
    }
  }

  /** Start (or restart, zeroed) per-system call counting. See `counting`. */
  setCounting(on: boolean): void {
    this.counting = on;
    if (on) {
      this.tickCalls.clear();
      this.renderCalls.clear();
    }
  }

  /** Calls recorded since the last `setCounting(true)`. Empty when counting is off. */
  callCounts(): { ticks: Record<string, number>; renders: Record<string, number> } {
    return {
      ticks: Object.fromEntries(this.tickCalls),
      renders: Object.fromEntries(this.renderCalls),
    };
  }

  /** Introspection for the debug overlay: what runs, in what order. */
  describe(): { ticks: { name: string; phase: TickPhase }[]; renders: { name: string; stage: RenderStage }[] } {
    this.sortTicks();
    this.sortRenders();
    return {
      ticks: this.ticks.map((t) => ({ name: t.system.name, phase: t.system.phase })),
      renders: this.renders.map((r) => ({ name: r.system.name, stage: r.system.stage })),
    };
  }
}
