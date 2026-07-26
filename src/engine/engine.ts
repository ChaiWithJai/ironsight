/**
 * Engine construction and the topological boot over `dependsOn`.
 * CORE owns this file.
 *
 * The engine knows the boot ORDER and nothing else's guts. It builds the nine
 * CORE services directly, then resolves every `SubsystemDescriptor` in
 * dependency order, then owns the frame loop that dispatches into them.
 *
 * Everything a lane can hook is a registration point:
 *   `BootContext.addTick`   → a `TickSystem` at one of the `TickPhase` slots
 *   `BootContext.addRender` → a `RenderSystem` at one of the `RenderStage` slots
 *   `RenderGraph.addPass`   → a `RenderPass` at one of the `PassOrder` slots
 * A lane never calls the loop, never calls the renderer, and never edits a
 * shared file to be scheduled.
 */
import * as THREE from 'three';
import {
  Sim,
  TickPhase,
  type BootContext,
  type Engine,
  type FrameCtx,
  type FxEmitter,
  type QualitySettings,
  type RenderSystem,
  type ServiceKey,
  type Services,
  type SimBus,
  type SubsystemDescriptor,
  type TickCtx,
  type TickSystem,
} from '@/engine/types';
import { EngineClock, nowMs } from '@/engine/clock';
import { createRng, type Pcg32 } from '@/engine/rng';
import { createFxBus, createSimBus, fxEmitterOf } from '@/engine/events';
import { createEntityStore, type EngineEntityStore } from '@/engine/entities';
import { createQualityService, type EngineQualityService } from '@/engine/quality';
import { createProfiler, type EngineProfiler } from '@/engine/profiler';
import { createInputService, type EngineInputService } from '@/engine/input';
import { createSceneGraph, type EngineSceneGraph } from '@/engine/scenegraph';
import { CullingSystem } from '@/engine/culling';
import { createDebugService, type EngineDebugService } from '@/engine/debug';
import { createServiceRegistry, type EngineServiceRegistry } from '@/engine/services';
import { FrameLoop } from '@/engine/loop';
import { probeGpu } from '@/engine/caps';
import { HarnessDriverImpl } from '@/engine/driver';
import { SUBSYSTEMS } from '@/bootstrap/subsystems';

/** The seed every capture resets to. Matches the value the locked harness sends. */
export const BOOT_SEED = 0x1205;

export interface EngineOptions {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** Progress text surfaced through the harness `setStatus`. */
  report: (status: string) => void;
}

export class IronEngine implements Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly registry: EngineServiceRegistry;
  readonly clock = new EngineClock();
  readonly rng: Pcg32;
  readonly quality: EngineQualityService;
  readonly profiler: EngineProfiler;
  readonly input: EngineInputService;
  readonly scene: EngineSceneGraph;
  readonly entities: EngineEntityStore;
  readonly debug: EngineDebugService;
  readonly loop: FrameLoop;
  readonly driver: HarnessDriverImpl;

  private readonly sim: SimBus;
  private readonly fx: ReturnType<typeof createFxBus>;
  private readonly fxEmitter: FxEmitter;
  private readonly descriptors: SubsystemDescriptor[] = [];
  private readonly afterBootHooks: ((services: Services) => void)[] = [];
  private readonly report: (status: string) => void;

  private suspended = false;
  private rafHandle = 0;
  private booted = false;

  /**
   * Set by the harness driver between captures. The rAF loop keeps turning but
   * neither simulates nor renders, so the framebuffer still holds the exact
   * final frame of the last shot when `tools/capture.mjs` grabs it — see the
   * long note on `HarnessDriverImpl.setLoopSuspended`. Cleared the moment a real
   * device event arrives.
   */
  harnessHold = false;

  constructor(options: EngineOptions) {
    this.renderer = options.renderer;
    this.canvas = options.canvas;
    this.report = options.report;

    const caps = probeGpu(options.renderer);
    this.registry = createServiceRegistry();
    this.rng = createRng(BOOT_SEED, 'root');
    this.quality = createQualityService(caps);
    this.profiler = createProfiler(options.renderer);
    this.profiler.setBudgets(this.quality.settings);
    this.quality.onChange((s) => this.profiler.setBudgets(s));
    this.input = createInputService(options.canvas);
    this.scene = createSceneGraph();
    this.entities = createEntityStore();
    this.sim = createSimBus();
    this.fx = createFxBus();
    this.fxEmitter = fxEmitterOf(this.fx);
    this.loop = new FrameLoop(this.profiler);
    this.debug = createDebugService(this.scene, this.quality, this.registry, this.loop);

    // CORE services are available before any descriptor runs, so a lane factory
    // can always reach the clock, the RNG, quality settings and the scene graph.
    this.registry.provide('clock', this.clock);
    this.registry.provide('rng', this.rng);
    this.registry.provide('quality', this.quality);
    this.registry.provide('profiler', this.profiler);
    this.registry.provide('input', this.input);
    this.registry.provide('events', this.sim);
    this.registry.provide('fx', this.fx);
    this.registry.provide('entities', this.entities);
    this.registry.provide('scene', this.scene);
    this.registry.provide('debug', this.debug);

    this.registerCoreSystems();
    this.driver = new HarnessDriverImpl(this);
  }

  get services(): Services {
    return this.registry.all;
  }

  get shotContext() {
    return this.driver.context;
  }

  get caps() {
    return this.quality.caps;
  }

  /* ----------------------------------------------------------------- systems */

  /**
   * CORE's own systems occupy the first and last slots of the tick, and the
   * culling slot of the frame. Nothing else may live at `TickPhase.Input` or
   * `TickPhase.Cleanup`.
   */
  private registerCoreSystems(): void {
    const input: TickSystem = {
      name: 'core.input',
      phase: TickPhase.Input,
      order: 0,
      tick: (): void => {
        // ADS scales look sensitivity so the same wrist movement covers the same
        // arc of the SCREEN, not the same arc of the world, when zoomed.
        const feel = this.registry.tryGet('viewmodel')?.state;
        const weapon = this.registry.tryGet('weapons');
        const adsScale = feel && weapon ? lerpSensitivity(feel.adsBlend, weapon.def('ar_service').ads.sensitivityMultiplier) : 1;
        this.input.tickInput(adsScale);
      },
    };
    const cleanup: TickSystem = {
      name: 'core.cleanup',
      phase: TickPhase.Cleanup,
      order: 1000,
      tick: (): void => {
        this.entities.flushDestroyed();
        // The sim bus drains at the END of the tick that queued into it, so a
        // handler can cascade within the same tick but never across a frame.
        this.sim.flush();
      },
    };
    this.loop.addTick(input);
    this.loop.addTick(cleanup);

    const fxDrain: RenderSystem = {
      name: 'core.fxDrain',
      stage: 0, // RenderStage.Sample
      order: 0,
      update: (): void => {
        // ONE drain, three consumers (VFX, AUDIO, HUD), zero coupling between
        // them. A bullet impact becomes a decal, a burst, a sound and a
        // hitmarker from four modules that have never heard of each other.
        this.fx.flush();
      },
    };
    this.loop.addRender(fxDrain);
    this.loop.addRender(new CullingSystem(this.scene));
    this.loop.addRender(this.debug);
  }

  addTick = (system: TickSystem): (() => void) => this.loop.addTick(system);
  addRender = (system: RenderSystem): (() => void) => this.loop.addRender(system);

  /**
   * `BootContext.afterBoot`. Queued during construction, drained by
   * `runAfterBoot()` once every descriptor exists and before
   * `RenderGraph.validate()`.
   *
   * This is the fix for a whole class of silent failure: a lane's frozen
   * `dependsOn` cannot name every service its render passes touch, so a factory
   * that calls `graph.addPass` directly may be handed the NULL graph and lose
   * its passes with no error. Deferring instead to the lane's first `update()`
   * is equally wrong — `validate()` has been and gone, so a pass reading an
   * unwritten resource is no longer caught.
   */
  afterBoot = (fn: (services: Services) => void): void => {
    if (this.booted) {
      // Past the drain: run it now rather than silently never. The pass still
      // misses validate(), so say so loudly instead of leaving it to a shot.
      console.warn('[engine] afterBoot() called after boot completed — running inline, past graph.validate()');
      fn(this.registry.all);
      return;
    }
    this.afterBootHooks.push(fn);
  };

  /* -------------------------------------------------------------------- boot */

  /**
   * Construct one subsystem by key. Used by `bootAssets()` (which needs the
   * registry before any bake is declared) and by `bootRemaining()`.
   */
  private async construct(descriptor: SubsystemDescriptor): Promise<void> {
    if (this.registry.has(descriptor.key)) return;
    this.report(`building ${descriptor.key}`);
    const ctx = this.bootContext();
    const value = await descriptor.create(ctx);
    this.registry.provide(descriptor.key, value as Services[ServiceKey]);
    this.descriptors.push(descriptor);
  }

  private bootContext(): BootContext {
    return {
      renderer: this.renderer,
      canvas: this.canvas,
      registry: this.registry,
      services: this.registry.all,
      quality: this.quality,
      assets: this.registry.get('assets'),
      rng: this.rng,
      addTick: this.addTick,
      addRender: this.addRender,
      afterBoot: this.afterBoot,
      report: this.report,
    };
  }

  /**
   * `assets` is constructed on its own, before everything else, because bake
   * steps must be DECLARED before any baking begins and the declaration call
   * takes the registry.
   */
  async bootAssets(): Promise<void> {
    const assets = SUBSYSTEMS.find((d) => d.key === 'assets');
    if (!assets) throw new Error('subsystems.ts has no "assets" descriptor');
    // `assets` is created without a BootContext that can resolve itself, so it
    // must not read `ctx.assets`. Nothing else in the table has this exception.
    const ctx: BootContext = {
      renderer: this.renderer,
      canvas: this.canvas,
      registry: this.registry,
      services: this.registry.all,
      quality: this.quality,
      assets: undefined as unknown as BootContext['assets'],
      rng: this.rng,
      addTick: this.addTick,
      addRender: this.addRender,
      afterBoot: this.afterBoot,
      report: this.report,
    };
    const value = await assets.create(ctx);
    this.registry.provide('assets', value as Services['assets']);
    this.descriptors.push(assets);
  }

  /** Declare every lane's bake steps. Runs after `bootAssets`, before `bakeAll`. */
  registerBakes(): void {
    const assets = this.registry.get('assets');
    const quality: Readonly<QualitySettings> = this.quality.settings;
    for (const d of SUBSYSTEMS) d.registerBakes?.(assets, quality);
  }

  /** Topological construction of everything except `assets`. Cycles throw. */
  async bootRemaining(): Promise<void> {
    const byKey = new Map<ServiceKey, SubsystemDescriptor>();
    for (const d of SUBSYSTEMS) byKey.set(d.key, d);

    const state = new Map<ServiceKey, 0 | 1 | 2>();
    const ordered: SubsystemDescriptor[] = [];
    const visit = (key: ServiceKey, chain: ServiceKey[]): void => {
      if (this.registry.has(key)) return; // already provided (CORE service or assets)
      const d = byKey.get(key);
      if (!d) {
        throw new Error(
          `subsystem "${chain[chain.length - 1] ?? '?'}" depends on "${key}", which has no descriptor ` +
            `and is not a CORE service`,
        );
      }
      const s = state.get(key) ?? 0;
      if (s === 2) return;
      if (s === 1) throw new Error(`subsystem dependency cycle: ${[...chain, key].join(' → ')}`);
      state.set(key, 1);
      for (const dep of d.dependsOn) visit(dep, [...chain, key]);
      state.set(key, 2);
      ordered.push(d);
    };
    for (const d of SUBSYSTEMS) visit(d.key, []);

    for (const d of ordered) await this.construct(d);
    this.runAfterBoot();
    this.booted = true;
  }

  /**
   * Drain the `afterBoot` queue: every service exists, nothing has rendered, and
   * `main.ts` calls `graph.validate()` immediately after this returns. That
   * window is the only correct place to register a render pass.
   *
   * Hooks run in registration order, which is construction order, which is the
   * topological boot order — so it is deterministic and reportable.
   */
  private runAfterBoot(): void {
    const services = this.registry.all;
    for (const fn of this.afterBootHooks) fn(services);
    this.afterBootHooks.length = 0;
  }

  /** Every constructed descriptor, in boot order. The reset chain walks this. */
  get bootOrder(): readonly SubsystemDescriptor[] {
    return this.descriptors;
  }

  /* ------------------------------------------------------------------- frame */

  private tickCtx(): TickCtx {
    return {
      tick: this.clock.tick,
      dt: Sim.TICK_DT,
      time: this.clock.simTime,
      entities: this.entities,
      sim: this.sim,
      fx: this.fxEmitter,
      rng: this.rng,
      services: this.registry.all,
      quality: this.quality.settings,
      deterministic: this.clock.deterministic,
    };
  }

  private frameCtx(alpha: number, dt: number): FrameCtx {
    return {
      frame: this.clock.frame,
      dt,
      alpha,
      time: this.clock.simTime,
      entities: this.entities,
      fx: this.fx,
      rng: this.rng,
      quality: this.quality.settings,
      camera: this.registry.get('camera').state,
      services: this.registry.all,
      profiler: this.profiler,
      deterministic: this.clock.deterministic,
    };
  }

  private runTick = (): void => {
    this.clock.advanceTick();
    this.loop.runTick(this.tickCtx());
  };

  /**
   * ONE frame: accumulate → zero or more fixed ticks → one interpolated render.
   * This is the only place either half is driven from, live or under capture.
   */
  private runFrame(dt: number): void {
    this.profiler.beginFrame();
    const { alpha } = this.loop.advance(dt, this.runTick);
    const ctx = this.frameCtx(alpha, dt);
    this.loop.runFrame(ctx);
    this.clock.endFrame(alpha);
    this.profiler.endFrame();
    if (!this.clock.deterministic) {
      this.quality.governFrame(this.profiler.frame.cpuMs);
    }
  }

  /** Harness entry point: exactly one tick at `dt` plus one full render frame. */
  stepFrame(dt: number): void {
    this.clock.beginFixedFrame(dt);
    this.runFrame(dt);
  }

  setLoopSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (!suspended) {
      // Re-anchor the wall clock or the first live frame after a capture sees a
      // forty-second dt and the accumulator burns its whole catch-up budget.
      this.clock.resetTiming();
      this.loop.resetAccumulator();
    }
  }

  get loopSuspended(): boolean {
    return this.suspended;
  }

  /** Start the live rAF loop. The harness parks it via `setLoopSuspended`. */
  start(): void {
    if (!this.booted) throw new Error('engine.start() before bootRemaining()');
    const frame = (t: number): void => {
      this.rafHandle = requestAnimationFrame(frame);
      if (this.suspended || this.harnessHold) {
        // Keep the wall-clock anchor fresh so the frame after a hold is not
        // handed a multi-second dt that burns the whole catch-up budget.
        this.clock.resetTiming();
        return;
      }
      const dt = this.clock.beginFrame(t);
      this.runFrame(dt);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /** Wall-clock helper for boot logging. Never read by simulation code. */
  static now(): number {
    return nowMs();
  }
}

/**
 * ADS sensitivity scaling. Blending linearly between 1 and the multiplier keeps
 * the transition monotonic, which matters because players re-acquire aim DURING
 * the ADS blend, not after it.
 */
function lerpSensitivity(adsBlend: number, multiplier: number): number {
  return 1 + (multiplier - 1) * Math.max(0, Math.min(1, adsBlend));
}

export function createEngine(options: EngineOptions): IronEngine {
  return new IronEngine(options);
}
