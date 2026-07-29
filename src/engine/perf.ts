/**
 * RUNTIME PERFORMANCE PROBE. OWNER: performance agent (with `profiler.ts`).
 *
 * `tools/perf.mjs` drives this object and nothing else, the same way
 * `tools/capture.mjs` drives `window.__HARNESS__` and `tools/soak.mjs` drives
 * `window.__SOAK__`. It is the seam that lets a headless tool read the numbers
 * the in-canvas HUD would otherwise be the only witness to: draw calls,
 * triangles, shader programs, GPU/CPU frame time, and the internal render
 * resolution — none of which a screenshot can report.
 *
 * WHY A PROBE RATHER THAN A PURE TOOL
 * -----------------------------------
 * Navigation Timing, Core Web Vitals, long tasks and JS heap are all standard
 * browser APIs, so `tools/perf.mjs` reads those directly off the page with no
 * cooperation from the engine. But `three.WebGLRenderer.info.render.calls` and
 * `EXT_disjoint_timer_query_webgl2` live behind the renderer, which the page
 * never hands out. `EngineProfiler` already aggregates exactly those figures
 * once per frame (see `profiler.ts`); this file simply publishes the latest
 * `FrameStats` and offers a deterministic way to sample frame time.
 *
 * DETERMINISM. `sampleFrames` reuses the capture path — suspend the live loop,
 * step a fixed number of fixed-dt frames, read the profiler after each — so the
 * FRAME COUNT is reproducible on any machine. The per-frame milliseconds are
 * wall-clock and therefore machine-dependent: they are a directional frame-time
 * distribution for this host, never a portable SLO. `tools/perf.mjs` labels
 * them as such.
 *
 * This file is not a gameplay path. Nothing in `src/` reads it back, it mutates
 * no engine state that survives a call (the loop is left in the same hold a
 * capture leaves behind), and deleting it changes nothing a player sees.
 */
import { tierName } from '@/engine/quality';
import type { IronEngine } from '@/engine/engine';

/** A live, single-frame snapshot of the renderer's own counters. */
export interface PerfSnapshot {
  /** True once the engine has finished booting. Mirrors `__HARNESS__.ready`. */
  ready: boolean;
  tier: string;
  /** Live scale after the dynamic-resolution governor (1.0 while capturing). */
  renderScale: number;
  /** Internal render resolution (canvas × renderScale), pixels. */
  renderWidth: number;
  renderHeight: number;
  /** Native canvas resolution, ignoring renderScale. */
  nativeWidth: number;
  nativeHeight: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  /** A few frames stale (async timer queries); 0 when the GPU timer is absent. */
  gpuMs: number;
  cpuMs: number;
  textureBytes: number;
  renderTargetBytes: number;
  tick: number;
  frame: number;
}

/** A distribution, in milliseconds, over one `sampleFrames` run. */
export interface MsDistribution {
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface FrameSample {
  frames: number;
  dt: number;
  /** Per-frame CPU cost (sim + submit), measured by the profiler each frame. */
  cpuMs: MsDistribution;
  /**
   * Per-frame GPU cost, when `EXT_disjoint_timer_query_webgl2` is present. Null
   * under SwiftShader and on drivers that do not expose the extension, rather
   * than a misleading zero.
   */
  gpuMs: MsDistribution | null;
  /** Draw calls and triangles are stable across the sample; the last is quoted. */
  drawCalls: number;
  triangles: number;
}

export interface PerfApi {
  readonly available: true;
  snapshot(): PerfSnapshot;
  sampleFrames(frames?: number, dt?: number): FrameSample;
}

declare global {
  // eslint-disable-next-line no-var
  var __PERF__: PerfApi | undefined;
}

/** Called once by `src/main.ts`, right after `installSoak`. */
export function installPerf(engine: IronEngine): void {
  globalThis.__PERF__ = {
    available: true,
    snapshot: () => snapshot(engine),
    sampleFrames: (frames?: number, dt?: number) => sampleFrames(engine, frames, dt),
  };
}

function snapshot(engine: IronEngine): PerfSnapshot {
  const f = engine.profiler.frame;
  // `graph` is a real service in the full game, but guard it: a lane running a
  // single real service against 27 nulls can still call the probe.
  const graph = engine.services.graph as
    | { width: number; height: number; nativeWidth: number; nativeHeight: number }
    | undefined;
  return {
    ready: globalThis.__HARNESS__?.ready === true,
    tier: tierName(engine.quality.tier),
    renderScale: round(engine.quality.renderScale, 4),
    renderWidth: graph?.width ?? 0,
    renderHeight: graph?.height ?? 0,
    nativeWidth: graph?.nativeWidth ?? 0,
    nativeHeight: graph?.nativeHeight ?? 0,
    drawCalls: f.drawCalls,
    triangles: f.triangles,
    programs: f.programs,
    gpuMs: round(f.gpuMs, 4),
    cpuMs: round(f.cpuMs, 4),
    textureBytes: f.textureBytes,
    renderTargetBytes: f.renderTargetBytes,
    tick: engine.clock.tick,
    frame: engine.clock.frame,
  };
}

/**
 * Step `frames` fixed-dt render frames and record the profiler's per-frame CPU
 * and GPU milliseconds, then return their distributions. Reuses the capture
 * hold so a sample cannot leak into a later shot, and warms two frames first so
 * the first measured frame is not paying an amortised cost (a distant shadow
 * cascade rendered on a `[1,1,2,4]` cadence, a lazily-uploaded instance buffer).
 */
function sampleFrames(engine: IronEngine, framesArg?: number, dtArg?: number): FrameSample {
  const frames = clampInt(framesArg ?? 120, 1, 2000);
  const dt = dtArg && dtArg > 0 ? dtArg : 1 / 60;
  const driver = engine.driver;

  driver.setLoopSuspended(true);
  try {
    // Warm-up frames, discarded: the GPU timer ring is a few frames deep and the
    // first frames after a hold pay one-off upload and cascade-cadence costs.
    for (let i = 0; i < 3; i++) engine.stepFrame(dt);

    const cpu: number[] = [];
    const gpu: number[] = [];
    let drawCalls = 0;
    let triangles = 0;
    for (let i = 0; i < frames; i++) {
      engine.stepFrame(dt);
      const s = engine.profiler.frame;
      cpu.push(s.cpuMs);
      // A zero here is "the query has not landed yet" or "no timer extension",
      // not a genuinely free frame — drop it rather than skew the distribution.
      if (s.gpuMs > 0) gpu.push(s.gpuMs);
      drawCalls = s.drawCalls;
      triangles = s.triangles;
    }

    return {
      frames,
      dt,
      cpuMs: distribution(cpu),
      gpuMs: gpu.length > 0 ? distribution(gpu) : null,
      drawCalls,
      triangles,
    };
  } finally {
    // Leave the world parked in the same HOLD a capture leaves behind.
    driver.setLoopSuspended(false);
  }
}

/* ---------------------------------------------------------------- statistics */

function distribution(values: number[]): MsDistribution {
  if (values.length === 0) {
    return { min: 0, median: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: round(sorted[0], 4),
    median: round(percentile(sorted, 50), 4),
    p95: round(percentile(sorted, 95), 4),
    p99: round(percentile(sorted, 99), 4),
    max: round(sorted[sorted.length - 1], 4),
    mean: round(sum / sorted.length, 4),
  };
}

/** Nearest-rank percentile over an already-sorted array. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[clampInt(rank - 1, 0, sorted.length - 1)];
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.floor(v);
  return n < lo ? lo : n > hi ? hi : n;
}
