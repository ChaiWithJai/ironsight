/**
 * Deterministic capture harness.
 *
 * `tools/capture.mjs` drives the game through this object and nothing else. The
 * contract is deliberately tiny so it stays stable while the rest of the engine
 * churns:
 *
 *   window.__HARNESS__.ready      → true once every subsystem finished warm-up
 *   window.__HARNESS__.status     → human-readable progress, for failure diags
 *   window.__HARNESS__.shots()    → names of every registered shot
 *   window.__HARNESS__.capture(n) → poses the world for shot `n`, renders a
 *                                   fixed number of frames, resolves when the
 *                                   framebuffer is settled and safe to grab
 *
 * Two invariants make screenshots reproducible on any machine, GPU or software:
 *
 *  1. Frame budget is counted in FRAMES, never wall-clock. A shot that needs 24
 *     frames for TAA to converge gets exactly 24 frames whether that takes 200ms
 *     on a GPU or 40s under SwiftShader.
 *  2. While a capture is in flight the normal rAF loop is suspended and every
 *     stochastic system is fed a fixed seed and a fixed dt, so two runs of the
 *     same shot are bit-comparable.
 */

/** Everything a shot is allowed to poke at when posing the world. */
export interface ShotContext {
  /** Seconds since midnight, drives sun/moon elevation and sky colour. */
  setTimeOfDay(hours: number): void;
  /** 0 = clear, 1 = full overcast/storm. */
  setWeather(overcast: number, options?: { wind?: number; rain?: number; fog?: number }): void;
  /** Place the camera in world space, looking at `target`. */
  poseCamera(position: [number, number, number], target: [number, number, number], fovDeg?: number): void;
  /** Show/hide the first-person viewmodel + HUD for clean environment shots. */
  setOverlays(options: { viewmodel?: boolean; hud?: boolean }): void;
  /** Force a named gameplay state (e.g. 'ads', 'sprint', 'firing'). */
  setPlayerState(state: string): void;
  /** Deterministic RNG seed for particles, wind phase, bot chatter, etc. */
  seed(n: number): void;
}

export interface ShotSpec {
  /** Stable identifier; becomes `<name>.png`. */
  name: string;
  /** One line explaining what this shot is meant to prove. Shown in review packets. */
  description: string;
  /** Pose the world. May be async (e.g. awaiting a streamed chunk). */
  setup: (ctx: ShotContext) => void | Promise<void>;
  /**
   * Frames to render before grabbing the framebuffer. Default 32 — enough for an
   * 8-sample TAA history plus bloom/GTAO temporal filters to fully settle.
   * Raise it for shots with slow-converging effects (volumetrics, SSR).
   */
  frames?: number;
  /** Fixed timestep in seconds fed to every frame of the warm-up. */
  dt?: number;
}

/** Implemented by the engine; the harness calls into it to advance the world. */
export interface HarnessDriver {
  context: ShotContext;
  /** Advance simulation + render exactly one frame with the given fixed dt. */
  stepFrame(dt: number): void;
  /** Suspend/resume the normal requestAnimationFrame loop. */
  setLoopSuspended(suspended: boolean): void;
  /** Resolve once all pending GPU work for the last frame has landed. */
  flush(): Promise<void>;
}

interface HarnessApi {
  ready: boolean;
  status: string;
  shots(): string[];
  capture(name: string): Promise<Record<string, unknown>>;
  describe(): Array<{ name: string; description: string }>;
}

const registry = new Map<string, ShotSpec>();
let driver: HarnessDriver | null = null;

/**
 * Register a shot. Every subsystem author is expected to contribute at least one
 * shot that isolates their work (see docs/SHOTS.md), so the critic loop can
 * review each area without hunting for a camera angle that happens to show it.
 */
export function registerShot(spec: ShotSpec): void {
  if (registry.has(spec.name)) {
    console.warn(`[harness] shot "${spec.name}" registered twice; last one wins`);
  }
  registry.set(spec.name, spec);
}

export function registerShots(specs: ShotSpec[]): void {
  for (const s of specs) registerShot(s);
}

/** Called once by the engine when the driver is live but before assets finish. */
export function attachDriver(d: HarnessDriver): void {
  driver = d;
}

export function setStatus(status: string): void {
  api.status = status;
}

/** Flip the flag the capture tool is waiting on. */
export function markReady(): void {
  api.status = 'ready';
  api.ready = true;
}

const api: HarnessApi = {
  ready: false,
  status: 'boot',
  shots: () => [...registry.keys()].sort(),
  describe: () =>
    [...registry.values()]
      .map((s) => ({ name: s.name, description: s.description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  async capture(name: string) {
    const spec = registry.get(name);
    if (!spec) throw new Error(`unknown shot "${name}"`);
    if (!driver) throw new Error('no harness driver attached');

    const frames = spec.frames ?? 32;
    const dt = spec.dt ?? 1 / 60;

    driver.setLoopSuspended(true);
    try {
      // Reset to a known state before every shot so shots cannot contaminate
      // each other through leftover recoil, particle pools or TAA history.
      driver.context.seed(0x1205);
      driver.context.setOverlays({ viewmodel: true, hud: true });
      driver.context.setPlayerState('idle');
      await spec.setup(driver.context);

      for (let i = 0; i < frames; i++) driver.stepFrame(dt);
      await driver.flush();

      return { name, frames, dt, description: spec.description };
    } finally {
      driver.setLoopSuspended(false);
    }
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __HARNESS__: HarnessApi;
}

globalThis.__HARNESS__ = api;

export const harness = api;
