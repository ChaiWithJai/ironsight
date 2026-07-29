/**
 * CPU marks, GPU disjoint timer queries and budget assertions.
 * CORE owns this file; from Wave 1b the performance agent owns it alone.
 *
 * This and `clock.ts` are the ONLY two files allowed to call
 * `performance.now()`. Everywhere else it is a determinism defect.
 *
 * GPU timing uses `EXT_disjoint_timer_query_webgl2`, which is asynchronous: a
 * query issued this frame is not readable for two or three more. We therefore
 * keep a small ring of query objects and report results as they land, which
 * means `frame.gpuMs` is a few frames stale. That is fine for a governor and a
 * HUD; it is NOT fine for anything that must be deterministic, which is why the
 * dynamic-resolution governor is hard-disabled during captures.
 */
import type * as THREE from 'three';
import type { BudgetLimits, FrameStats, Profiler, QualitySettings } from '@/engine/types';

interface GpuQuery {
  query: WebGLQuery;
  label: string;
  frame: number;
}

const RING_SIZE = 12;

export class EngineProfiler implements Profiler {
  private readonly openCpu = new Map<string, number>();
  private readonly cpuMs: Record<string, number> = {};
  private readonly passMs: Record<string, number> = {};
  private readonly gpuRing: GpuQuery[] = [];
  private activeQuery: GpuQuery | null = null;
  private ext: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null = null;

  private frameStart = 0;
  private frameIndex = 0;
  private stats: FrameStats = emptyStats();
  private budgets: BudgetLimits | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
      TIME_ELAPSED_EXT: number;
      GPU_DISJOINT_EXT: number;
    } | null;
    this.ext = ext;
    // `renderer.info.render` is what feeds `FrameStats.drawCalls`/`triangles`,
    // and three RESETS it on every `renderer.render()` call. The render graph
    // issues ~30 passes per frame, so with the default `autoReset = true` the
    // counter only ever holds the LAST pass's tally — for us the fullscreen
    // present, i.e. a permanent "1 draw, 1 triangle". Turn autoReset off and
    // reset exactly once per frame (in `beginFrame`) so the count accumulates
    // across the whole frame. Without this the drawCalls budget assertion in
    // `checkBudgets` compares against 1 and can never fire.
    renderer.info.autoReset = false;
  }

  setBudgets(quality: Readonly<QualitySettings>): void {
    this.budgets = quality.budgets;
  }

  get frame(): Readonly<FrameStats> {
    return this.stats;
  }

  begin(label: string): void {
    this.openCpu.set(label, performance.now());
  }

  end(label: string): void {
    const t0 = this.openCpu.get(label);
    if (t0 === undefined) return;
    this.openCpu.delete(label);
    const ms = performance.now() - t0;
    // Accumulate rather than assign: a system that runs several times in one
    // frame (five catch-up ticks) should report its total, not its last slice.
    this.cpuMs[label] = (this.cpuMs[label] ?? 0) + ms;
  }

  scope<T>(label: string, fn: () => T): T {
    this.begin(label);
    try {
      return fn();
    } finally {
      this.end(label);
    }
  }

  gpuBegin(label: string): void {
    if (!this.ext || this.activeQuery) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (this.gpuRing.length >= RING_SIZE) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.activeQuery = { query, label, frame: this.frameIndex };
  }

  gpuEnd(_label: string): void {
    if (!this.ext || !this.activeQuery) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.gpuRing.push(this.activeQuery);
    this.activeQuery = null;
  }

  beginFrame(): void {
    this.frameStart = performance.now();
    // One reset per frame (autoReset is off — see the constructor), so
    // `info.render` accumulates every pass's draws and triangles until the
    // matching `endFrame` reads the whole-frame total.
    this.renderer.info.reset();
    for (const k of Object.keys(this.cpuMs)) delete this.cpuMs[k];
    for (const k of Object.keys(this.passMs)) delete this.passMs[k];
    this.openCpu.clear();
  }

  /** Called once per frame after submit, with three's own draw counters. */
  endFrame(): void {
    const cpu = performance.now() - this.frameStart;
    const info = this.renderer.info;
    const gpuMs = this.collectGpu();
    this.stats = {
      cpuMs: cpu,
      gpuMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textureBytes: this.textureBytes,
      renderTargetBytes: this.renderTargetBytes,
      passMs: { ...this.passMs },
      systemMs: { ...this.cpuMs },
    };
    this.frameIndex++;
  }

  /** RCORE reports render-target residency; BAKE reports texture residency. */
  textureBytes = 0;
  renderTargetBytes = 0;

  private lastGpuMs = 0;

  private collectGpu(): number {
    if (!this.ext || this.gpuRing.length === 0) return this.lastGpuMs;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      // A context switch invalidated every in-flight query; throw them away
      // rather than reporting a garbage spike into the governor.
      for (const q of this.gpuRing) gl.deleteQuery(q.query);
      this.gpuRing.length = 0;
      return this.lastGpuMs;
    }
    let total = 0;
    let landed = 0;
    for (let i = this.gpuRing.length - 1; i >= 0; i--) {
      const q = this.gpuRing[i];
      if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(q.query, gl.QUERY_RESULT) as number;
      const ms = ns / 1e6;
      this.passMs[q.label] = ms;
      total += ms;
      landed++;
      gl.deleteQuery(q.query);
      this.gpuRing.splice(i, 1);
    }
    if (landed > 0) this.lastGpuMs = total;
    return this.lastGpuMs;
  }

  /**
   * One string per violated budget. Empty array means we are inside the frame
   * budget. CI treats a non-empty result as build-breaking — see the CPU
   * per-draw note in quality.ts for why draw calls are the one to watch.
   */
  checkBudgets(): readonly string[] {
    const b = this.budgets;
    if (!b) return [];
    const out: string[] = [];
    const s = this.stats;
    if (s.drawCalls > b.drawCalls) out.push(`drawCalls ${s.drawCalls} > ${b.drawCalls}`);
    if (s.triangles > b.triangles) out.push(`triangles ${s.triangles} > ${b.triangles}`);
    if (s.programs > b.shaderPrograms) out.push(`programs ${s.programs} > ${b.shaderPrograms}`);
    if (s.textureBytes > b.textureBytes) {
      out.push(`textureBytes ${mb(s.textureBytes)} > ${mb(b.textureBytes)}`);
    }
    if (s.renderTargetBytes > b.renderTargetBytes) {
      out.push(`renderTargetBytes ${mb(s.renderTargetBytes)} > ${mb(b.renderTargetBytes)}`);
    }
    if (s.gpuMs > b.gpuMs && s.gpuMs > 0) out.push(`gpuMs ${s.gpuMs.toFixed(2)} > ${b.gpuMs}`);
    if (s.cpuMs > b.cpuMs) out.push(`cpuMs ${s.cpuMs.toFixed(2)} > ${b.cpuMs}`);
    return out;
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function emptyStats(): FrameStats {
  return {
    cpuMs: 0,
    gpuMs: 0,
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    textureBytes: 0,
    renderTargetBytes: 0,
    passMs: {},
    systemMs: {},
  };
}

export function createProfiler(renderer: THREE.WebGLRenderer): EngineProfiler {
  return new EngineProfiler(renderer);
}
