/**
 * AssetRegistry — every byte of art in this game comes out of here. OWNER: BAKE.
 *
 * The day-0 null already did the SCHEDULING half for real (declare, topo-sort,
 * cost-weighted progress, frame yields). What this adds is the half a null
 * cannot fake: a GPU device, a worker pool with an inline fallback, an IndexedDB
 * cache, CPU/GPU-matched noise, real degradation planning, and BAKE's own
 * products — the material library, the HUD font and the shared LUTs.
 *
 * THE CONSTRAINT THAT SIZES THIS WHOLE LANE: `tools/capture.mjs` hard-fails at
 * 300 s waiting for `ready`. Playwright uses a fresh profile per run, so
 * IndexedDB NEVER hits and captures ALWAYS cold-bake — under SwiftShader, where
 * a fragment shader that does forty noise evaluations per texel runs 20–60×
 * slower than on a discrete part. Two things hold the line:
 *
 *  1. `BakeProfile.unitCeiling`, enforced up front by `planDegradation` over the
 *     WHOLE declared set, so resolution drops before the first draw rather than
 *     being discovered half way through (architecture decision #11).
 *  2. `BakeProfile.allowReadback === false` is the reliable software-rasteriser
 *     tell — `quality.ts` sets it from `caps.isSoftware` — and BAKE's own steps
 *     use it to pick a cheaper working resolution. Not a hack: it is the one bit
 *     of "am I inside the capture harness" that reaches a bake step, and the
 *     architecture's answer to blowing the budget is a softer bake, never a
 *     missing one.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeAssets,
  BakeKind,
  QualityTier,
  SurfaceId,
  type AssetKey,
  type AssetRegistry,
  type AudioAsset,
  type BakedFont,
  type BakeProgress,
  type BakeRunContext,
  type BakeStats,
  type BakeStep,
  type BootContext,
  type MaterialLibrary,
  type MeshAsset,
  type QualitySettings,
  type Rng,
  type TextureSet,
} from '@/engine/types';
// `src/engine/clock.ts` is the project's ONE wall-clock source; boundary CI
// forbids `performance.now()` everywhere else, and bake duration reporting is
// not simulation, so importing it here is correct rather than a loophole.
import { nowMs } from '@/engine/clock';
import { IronGpuBakeDevice } from '@/bake/gpu-device';
import { IronWorkerPool } from '@/bake/worker-pool';
import { IronNoise } from '@/bake/noise';
import { BakeCache, hashKey } from '@/bake/cache';
import { grantTexelSize, planDegradation, type CostedStep } from '@/bake/units';
import { harbourMaterials, produceTextureSet, SURFACE_ALIASES, SURFACE_IDS } from '@/bake/textures';
import { bakeFont } from '@/bake/font';
import { bakeBlueNoise, bakeBrdfLut } from '@/bake/luts';
import { buildMaterialChart, disposeMaterialChart } from '@/bake/chart';

interface RegisteredStep {
  readonly id: string;
  readonly kind: AssetKind;
  readonly step: BakeStep<unknown>;
  done: boolean;
  value?: unknown;
}

/** Yield to the browser so the loading screen repaints and the page stays alive. */
function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Bytes held by a baked value the GPU device does not account for. */
function geometryBytesOf(value: unknown): number {
  const asMesh = value as Partial<MeshAsset> | null;
  if (!asMesh || !Array.isArray(asMesh.lods)) return 0;
  let bytes = 0;
  for (const geometry of asMesh.lods as readonly THREE.BufferGeometry[]) {
    for (const attribute of Object.values(geometry.attributes)) {
      const array = (attribute as THREE.BufferAttribute).array as ArrayLike<number> & { BYTES_PER_ELEMENT?: number };
      bytes += array.length * (array.BYTES_PER_ELEMENT ?? 4);
    }
    const index = geometry.getIndex();
    if (index) bytes += index.count * ((index.array as Uint32Array).BYTES_PER_ELEMENT ?? 4);
  }
  return bytes;
}

function audioBytesOf(value: unknown): number {
  const asAudio = value as Partial<AudioAsset> | null;
  if (!asAudio || !Array.isArray(asAudio.channels)) return 0;
  let bytes = 0;
  for (const channel of asAudio.channels as readonly Float32Array[]) bytes += channel.length * 4;
  return bytes;
}

/**
 * `OfflineAudioContext` is the bake-time audio device: it works headless, needs
 * no user gesture, and runs faster than real time. One instance is shared —
 * constructing one per step is a real allocation on Safari and the steps only
 * ever use it to build buffers.
 */
let sharedAudioContext: OfflineAudioContext | null = null;
function offlineAudioContext(): OfflineAudioContext {
  if (sharedAudioContext) return sharedAudioContext;
  const Ctor =
    (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) {
    // Headless without WebAudio: hand back a shape-compatible stub rather than
    // throwing, because an audio bake failing must not take the whole capture
    // with it. AUDIO's steps already treat a zero-length buffer as silence.
    sharedAudioContext = {
      sampleRate: 48000,
      length: 0,
    } as unknown as OfflineAudioContext;
    return sharedAudioContext;
  }
  sharedAudioContext = new Ctor(2, 48000, 48000);
  return sharedAudioContext;
}

/* -------------------------------------------------------------- the registry */

export class IronAssetRegistry implements AssetRegistry {
  readonly gpu: IronGpuBakeDevice;
  readonly workers: IronWorkerPool;
  readonly noise = new IronNoise();

  private readonly steps = new Map<string, RegisteredStep>();
  private readonly order: string[] = [];
  private readonly cache: BakeCache;
  private baked = false;
  private statsValue: BakeStats = {
    totalMs: 0,
    perStepMs: {},
    textureBytes: 0,
    geometryBytes: 0,
    audioBytes: 0,
    cacheHits: 0,
    degraded: [],
  };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly quality: () => Readonly<QualitySettings>,
    private readonly rng: Rng,
  ) {
    const settings = quality();
    this.gpu = new IronGpuBakeDevice(renderer, settings.bake.allowReadback, settings.maxAnisotropy);
    this.workers = new IronWorkerPool(settings.bake.workerCount);
    // The cache is off inside the capture harness on purpose. Playwright's fresh
    // profile means it would never hit anyway, and an IndexedDB open that blocks
    // is 300 s of the budget spent on nothing.
    this.cache = new BakeCache(settings.bake.allowReadback);
  }

  define<T>(id: string, kind: AssetKind, step: Omit<BakeStep<T>, 'key'>): AssetKey<T> {
    if (this.steps.has(id)) throw new Error(`asset "${id}" defined twice`);
    if (this.baked) {
      throw new Error(
        `asset "${id}" was defined after bakeAll() ran. Every step must be declared in ` +
          `register…Bakes(), which is the only point where the scheduler can see the whole cost total.`,
      );
    }
    const key: AssetKey<T> = { id, kind };
    this.steps.set(id, { id, kind, step: { ...step, key } as BakeStep<unknown>, done: false });
    this.order.push(id);
    return key;
  }

  has<T>(key: AssetKey<T>): boolean {
    return this.steps.get(key.id)?.done === true;
  }

  get<T>(key: AssetKey<T>): T {
    const s = this.steps.get(key.id);
    if (!s) throw new Error(`asset "${key.id}" was never defined`);
    if (!s.done) throw new Error(`asset "${key.id}" has not been baked yet`);
    if (s.value === undefined) {
      throw new Error(
        `asset "${key.id}" was skipped at this quality tier (minTier). Read it with tryGet() ` +
          `and fall back, or lower the step's minTier.`,
      );
    }
    return s.value as T;
  }

  tryGet<T>(key: AssetKey<T>): T | undefined {
    const s = this.steps.get(key.id);
    return s?.done ? (s.value as T | undefined) : undefined;
  }

  get stats(): Readonly<BakeStats> {
    return this.statsValue;
  }

  /**
   * Resolve every declared step in topological order.
   *
   * Degradation is planned ONCE, over the whole declared set, before the first
   * draw — the scheduler cannot halve a texture it has already rendered, and
   * discovering the overrun half way through is how a bake blows a hard timeout.
   */
  async bakeAll(onProgress: (p: BakeProgress) => void): Promise<void> {
    if (this.baked) return;
    this.baked = true;
    const start = nowMs();
    const sorted = this.topoSort();
    const settings = this.quality();
    const costed: CostedStep[] = sorted.map((s) => ({ id: s.id, cost: Math.max(1, s.step.cost) }));
    const plan = planDegradation(costed, settings.bake.unitCeiling);
    const totalCost = costed.reduce((a, s) => a + s.cost, 0);
    const perStepMs: Record<string, number> = {};
    const degraded = new Set(plan.degraded);

    let geometryBytes = 0;
    let audioBytes = 0;
    let spent = 0;

    for (const entry of sorted) {
      const cost = Math.max(1, entry.step.cost);
      const phase = phaseOf(entry.id);
      if (entry.step.minTier !== undefined && settings.tier < entry.step.minTier) {
        // Skipped, not failed. `get` throws with the reason and `tryGet` returns
        // undefined, which is the contract a tier-gated asset's consumer reads.
        entry.done = true;
        entry.value = undefined;
        spent += cost;
        continue;
      }
      const t0 = nowMs();
      const ctx = this.makeContext(entry, plan.scale.get(entry.id) ?? 1, degraded, (f) =>
        onProgress({
          fraction: clamp01((spent + cost * clamp01(f)) / totalCost),
          phase,
          stepId: entry.id,
          elapsedMs: nowMs() - start,
        }),
      );
      entry.value = await entry.step.run(ctx);
      entry.done = true;
      perStepMs[entry.id] = nowMs() - t0;
      geometryBytes += geometryBytesOf(entry.value);
      audioBytes += audioBytesOf(entry.value);
      spent += cost;
      onProgress({
        fraction: clamp01(spent / totalCost),
        phase,
        stepId: entry.id,
        elapsedMs: nowMs() - start,
      });
      // Unconditional yield between steps. A bake that never returns to the
      // event loop is indistinguishable from a hang from outside the tab, and
      // the capture tool's only signal is the harness status string.
      await nextFrame();
    }

    this.statsValue = {
      totalMs: nowMs() - start,
      perStepMs,
      textureBytes: this.gpu.bytesResident,
      geometryBytes,
      audioBytes,
      cacheHits: this.cache.hits,
      degraded: [...degraded].sort(),
    };
  }

  private makeContext(
    entry: RegisteredStep,
    scale: number,
    degraded: Set<string>,
    progress: (f: number) => void,
  ): BakeRunContext {
    const settings = this.quality();
    const registry = this;
    return {
      quality: settings,
      profile: settings.bake,
      // A per-step stream, forked by id: two steps must not be able to change
      // each other's random sequence by being reordered, and the topo sort is
      // free to reorder them the moment somebody adds a dependency.
      rng: this.rng.fork(`bake:${entry.id}`),
      gpu: this.gpu,
      workers: this.workers,
      noise: this.noise,
      renderer: this.renderer,
      audioCtx: offlineAudioContext(),
      require<T>(key: AssetKey<T>): T {
        const declared = entry.step.dependsOn ?? [];
        if (!declared.some((d) => d.id === key.id)) {
          throw new Error(
            `bake "${entry.id}" required "${key.id}" without declaring it in dependsOn — ` +
              `the topological sort cannot order a dependency it was not told about.`,
          );
        }
        return registry.get(key);
      },
      grantedTexelSize(requested: number): number {
        const granted = grantTexelSize(requested, scale);
        if (granted !== requested) degraded.add(entry.id);
        return granted;
      },
      progress(fraction01: number): void {
        progress(fraction01);
      },
      yieldFrame: nextFrame,
    };
  }

  /**
   * Kahn's algorithm over `dependsOn`, tie-broken by DECLARATION order so the
   * bake sequence — and therefore every forked RNG stream in it — is identical
   * on every machine.
   */
  private topoSort(): RegisteredStep[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of this.order) {
      indegree.set(id, 0);
      dependents.set(id, []);
    }
    for (const id of this.order) {
      const entry = this.steps.get(id);
      if (!entry) continue;
      for (const dep of entry.step.dependsOn ?? []) {
        if (!this.steps.has(dep.id)) {
          throw new Error(`bake "${id}" depends on "${dep.id}", which was never defined`);
        }
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
        dependents.get(dep.id)?.push(id);
      }
    }
    const ready = this.order.filter((id) => (indegree.get(id) ?? 0) === 0);
    const out: RegisteredStep[] = [];
    while (ready.length > 0) {
      const id = ready.shift() as string;
      const entry = this.steps.get(id);
      if (entry) out.push(entry);
      for (const next of dependents.get(id) ?? []) {
        const remaining = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, remaining);
        if (remaining === 0) ready.push(next);
      }
    }
    if (out.length !== this.order.length) {
      const stuck = this.order.filter((id) => (indegree.get(id) ?? 0) > 0);
      throw new Error(`bake dependency cycle among: ${stuck.join(', ')}`);
    }
    return out;
  }

  /**
   * A cached worker job. The KEY is `hash(job, payload, profile)` exactly as the
   * architecture specifies, so a payload or profile change invalidates without
   * anyone remembering to bump a version.
   */
  async cachedJob<TIn, TOut>(job: string, payload: TIn): Promise<TOut> {
    const key = hashKey([job, payload, this.quality().bake.name]);
    const hit = await this.cache.get<TOut>(key);
    if (hit !== undefined) return hit;
    const value = await this.workers.run<TIn, TOut>(job, payload);
    await this.cache.put(key, value);
    return value;
  }

  dispose(): void {
    this.workers.dispose();
    this.gpu.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** `bake.lut.brdf` → `lut brdf`: what the loading bar shows the player. */
function phaseOf(id: string): string {
  return id.replace(/^[a-z]+\./, '').replace(/\./g, ' ');
}

/**
 * Route a worker job through the IndexedDB cache when one is available.
 *
 * `BakeRunContext` deliberately exposes the raw pool rather than a caching
 * wrapper — most bakes produce GPU objects that cannot be serialised at all, and
 * a context method that silently did nothing for them would be worse than no
 * method. BAKE's own steps reach the registry directly for the cases that can.
 */
function cachedJob<TIn, TOut>(ctx: BakeRunContext, job: string, payload: TIn): Promise<TOut> {
  return instance ? instance.cachedJob<TIn, TOut>(job, payload) : ctx.workers.run<TIn, TOut>(job, payload);
}

/* ------------------------------------------------------------- lane exports */

let instance: IronAssetRegistry | null = null;

export function createAssetRegistry(ctx: BootContext): AssetRegistry {
  const registry = new IronAssetRegistry(ctx.renderer, () => ctx.quality.settings, ctx.rng.fork('bake'));
  instance = registry;
  // The material chart is BAKE's own review surface: geometry that exists only
  // so the `bake` shot can judge tiling, detail scale and normal strength
  // without depending on LEVEL having placed a wall or LIGHT having lit it. It
  // is parked far below the world so it can never intrude on another lane's
  // shot, and it is built in afterBoot because that is the only point at which
  // every service exists and nothing has rendered yet.
  ctx.afterBoot((services) => {
    const library = registry.tryGet(BakeAssets.materials);
    if (!library) return;
    buildMaterialChart(
      services,
      library,
      registry.tryGet(BakeAssets.font),
      registry.tryGet(BakeAssets.brdfLut),
    );
  });
  return registry;
}

/**
 * BAKE's own steps. Everything §6.1 of the architecture lists with no owning
 * lane, plus the material library and the HUD font every other lane consumes.
 *
 * Declaration ONLY — `bakeAll` runs these later, which is what lets the
 * scheduler see the whole cost total before the first texel is rendered.
 */
export function registerAssetsBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  // `allowReadback` is false exactly when `caps.isSoftware` is true, i.e. inside
  // the capture harness. A SwiftShader fragment doing forty noise evaluations per
  // texel is ~40× a real GPU, so the working resolution — not the step list —
  // is what has to give.
  const software = !quality.bake.allowReadback;
  // Ask for the honest resolution on BOTH paths and let `planDegradation` be the
  // thing that decides — that is the mechanism's entire job (decision #11), and
  // second-guessing it here would mean the ceiling never gets exercised and a
  // real overrun on somebody else's machine finds an untested code path.
  const bulk = Math.min(quality.bake.bulkTexelSize, 512);

  assets.define<MaterialLibrary>(BakeAssets.materials.id, AssetKind.Material, {
    kind: BakeKind.GpuTexture,
    version: 3,
    // Six two-pass PBR sets. The dominant term is pass B's 8×4 horizon search,
    // which is 32 dependent taps per texel — expensive, and the reason mortar
    // courses and plank gaps are dark because they are OCCLUDED rather than
    // because somebody painted a line there.
    cost: 260,
    cacheable: false,
    run: async (ctx) => {
      const size = ctx.grantedTexelSize(bulk);
      const recipes = harbourMaterials(SURFACE_IDS);
      const sets = new Map<SurfaceId, TextureSet>();
      const device = ctx.gpu as IronGpuBakeDevice;
      for (let i = 0; i < recipes.length; i++) {
        const recipe = recipes[i];
        ctx.progress(i / recipes.length, recipe.id);
        const set = produceTextureSet(device, recipe, {
          size,
          anisotropy: ctx.quality.maxAnisotropy,
          // A per-material seed off the step's own stream: two materials sharing
          // a seed share their macro blotch pattern, which reads as one material
          // painted two colours the moment they are adjacent on a building.
          seed: ((ctx.rng.int(0x7ffffff) + 1) ^ (i * 0x9e3779b1)) >>> 0,
        });
        sets.set(recipe.surface, set);
        // One material is seconds of synchronous GPU work under SwiftShader.
        // Yielding between them is what keeps the loading screen repainting and
        // the harness status string moving — the capture tool's only evidence
        // that the page is alive rather than hung, and the difference between a
        // slow bake and one indistinguishable from a crash.
        await ctx.yieldFrame();
      }
      ctx.progress(1, 'materials');
      // Aliases are resolved into the map rather than at lookup time, so
      // `surfaces` reports what a consumer can actually ask for and a lane that
      // enumerates the library sees the same answer as one that queries it.
      for (const [alias, target] of SURFACE_ALIASES) {
        const set = sets.get(target);
        if (set && !sets.has(alias)) sets.set(alias, set);
      }
      const surfaces = [...sets.keys()].sort((a, b) => a - b);
      const library: MaterialLibrary = {
        surfaces,
        get: (id) => sets.get(id),
        texelSize: size,
      };
      return library;
    },
  });

  assets.define<BakedFont>(BakeAssets.font.id, AssetKind.Font, {
    kind: BakeKind.MainThread,
    version: 2,
    // CPU-bound but small: one exact distance evaluation per texel per stroke,
    // over 63 cells. It is a MainThread step rather than a worker one because
    // the result is a THREE.DataTexture, which a worker cannot construct.
    cost: 26,
    cacheable: false,
    run: () =>
      bakeFont({
        // 64 texels of cell gives a 42-texel cap height, which still resolves
        // the 0.15-cap stem to six texels — enough for the SDF to stay a
        // distance field rather than a two-level mask.
        cell: software ? 48 : 64,
        distanceRange: software ? 4 : 5,
      }),
  });

  assets.define<THREE.Texture>(BakeAssets.brdfLut.id, AssetKind.Lut, {
    kind: BakeKind.GpuTexture,
    version: 1,
    cost: software ? 18 : 40,
    cacheable: false,
    run: (ctx) =>
      bakeBrdfLut(ctx.gpu as IronGpuBakeDevice, {
        size: ctx.grantedTexelSize(software ? 128 : 256),
        // 128 samples is where the table stops changing visibly; SwiftShader
        // gets 48, which costs a faint ripple in the rough/grazing corner that
        // no material in this game samples hard.
        samples: software ? 48 : 128,
      }),
  });

  assets.define<THREE.Data3DTexture>(BakeAssets.blueNoise.id, AssetKind.Texture3D, {
    kind: BakeKind.WorkerData,
    version: 1,
    // Void-and-cluster is O(n²) in the texel count and serial by construction,
    // so the tile edge is the only knob. 64² is the practical ceiling for a
    // synchronous bake and 32² is what fits inside the software budget.
    cost: software ? 14 : 34,
    minTier: QualityTier.Low,
    cacheable: true,
    run: (ctx) =>
      bakeBlueNoise((job, payload) => cachedJob(ctx, job, payload), {
        size: software ? 32 : 64,
        slices: software ? 16 : 32,
        seed: (ctx.rng.int(0x7ffffff) + 1),
      }),
  });
}

/**
 * Harness reset chain. Baked assets are IMMUTABLE and must not be rebuilt here —
 * a rebake inside a capture blows the 300 s budget on its own. Only per-capture
 * scratch is dropped, and the bake device holds none between steps because
 * `produceTextureSet` releases its float intermediates as it goes.
 */
export function resetAssets(_seed: number): void {
  // Genuinely nothing to do, and that is the correct implementation rather than
  // an omission: the material library, the font atlas and the LUTs are immutable
  // GPU objects, `produceTextureSet` already released its float intermediates as
  // it went, and the chart holds no per-capture state. Rebaking anything here
  // would spend the 300 s capture budget on work whose result cannot differ.
}

/** Tear-down for a hot reload. Not part of the reset chain. */
export function disposeAssets(): void {
  disposeMaterialChart();
  instance?.dispose();
  instance = null;
}
