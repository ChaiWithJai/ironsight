/**
 * A WORKING null implementation of every lane-owned entry in `Services`.
 * CORE owns this file. WRITTEN ONCE ON DAY 0 AND NEVER EDITED AGAIN.
 *
 * This is the single most important file for parallelism in the project. Any
 * lane can boot the entire engine with every other service nulled and one real
 * service of its own, and still take a screenshot. That is the difference
 * between sixteen parallel agents and sixteen serialised ones.
 *
 * WHAT "NULL" MEANS HERE
 * ----------------------
 * Not "throws". Not "returns undefined". A null service returns PLAUSIBLE FAKE
 * STATE: flat ground at y = 0, three hard-coded capture points, rays that always
 * miss, a silent mixer, a match with tickets on the clock. Downstream code takes
 * its normal branch, and the frame that comes out is boring rather than broken.
 *
 * WHAT IS NOT HERE, AND WHY
 * -------------------------
 *  - The null `MaterialFactory` lives in `src/render/material/factory.ts`,
 *    because `new THREE.Mesh*Material` is CI-forbidden outside that directory.
 *  - The null `RenderGraph`, `CameraRig` and `RenderService` live under
 *    `src/render/`, because `renderer.setRenderTarget` is CI-forbidden outside it.
 * Those are the only three exceptions; everything else in `Services` is below.
 */
import * as THREE from 'three';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import {
  AssetKind,
  BotBehaviour,
  Btn,
  CaptureState,
  DecalKind,
  FireMode,
  HitZone,
  MatchPhase,
  QualityTier,
  Stance,
  SurfaceId,
  Team,
  type AiService,
  type AssetKey,
  type AssetRegistry,
  type AudioService,
  type BakeProgress,
  type BakeRunContext,
  type BakeStats,
  type BakeStep,
  type BallisticsService,
  type BodyHandle,
  type BotProfile,
  type CameraRigPose,
  type CapturePointDef,
  type CapturePointRuntime,
  CollisionGroup,
  LAYER_SOLID,
  type CharacterConfig,
  type CharacterController,
  type CharacterMoveResult,
  type CoverSlot,
  type DamageInfo,
  type DecalHandle,
  type DecalRequest,
  type DestructibleDef,
  type DestructionResult,
  type DestructionService,
  type EntityId,
  type GameMode,
  type GpuBakeDesc,
  type GpuBakeDevice,
  type HudService,
  type IntentSource,
  type LevelService,
  type LightHandle,
  type LightingService,
  type LocalLight,
  type MacroTerrain,
  type MatchState,
  type MeshAsset,
  type NavService,
  type NoiseEvent,
  type NoiseLib,
  type PhysicsService,
  type PlayerIntent,
  type PlayerService,
  type PlayerState,
  type QualitySettings,
  type QueryFilter,
  type RayHit,
  type Rng,
  type SoundHandle,
  type SpawnPointDef,
  type SkyService,
  type SkyState,
  type SquadOrder,
  type StaticColliderDef,
  type TerrainService,
  type TickCtx,
  type Vec3,
  type VegetationService,
  type VfxHandle,
  type VfxService,
  type ViewmodelRig,
  type WaterService,
  type WeaponDef,
  type WeaponFeelState,
  type WeaponId,
  type WeaponService,
  type WeaponState,
  type WorkerPool,
} from '@/engine/types';
import { MACRO_ANCHORS, MACRO_TERRAIN, macroNormal } from '@/engine/macro';
import { clamp, DEG2RAD, hashInt, smoothstep } from '@/engine/math/curves';

const ZERO = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Identity set for `ServiceRegistry.isNull()`.
 *
 * A lane's stub file wraps its null in `trackNull(...)`; when the lane ships and
 * replaces the body of that file, the wrapper goes with it and `isNull` becomes
 * correct automatically. No list to maintain, nothing to go stale.
 */
const NULL_INSTANCES = new WeakSet<object>();

export function trackNull<T extends object>(value: T): T {
  NULL_INSTANCES.add(value);
  return value;
}

export function isNullInstance(value: unknown): boolean {
  return typeof value === 'object' && value !== null && NULL_INSTANCES.has(value as object);
}

/**
 * A phantom-typed key for an asset that will never be baked. The null services
 * hand these out so downstream code can hold a key without a special case; any
 * `assets.get()` on one throws, which is the correct, loud failure.
 */
export function placeholderKey<T>(id: string, kind: AssetKind): AssetKey<T> {
  return { id, kind } as AssetKey<T>;
}

/* ==========================================================================
 * BAKE — asset registry, GPU device, worker pool, noise
 * ======================================================================= */

/**
 * Null GPU bake device. Returns a 4×4 neutral checker for anything asked of it,
 * so a material sampling an unbaked texture reads as flat grey rather than as
 * undefined-sampler black. BAKE replaces this in Wave 1a.
 */
class NullGpuBakeDevice implements GpuBakeDevice {
  readonly bytesResident = 0;
  private cached: THREE.DataTexture | null = null;

  private fallback(): THREE.DataTexture {
    if (this.cached) return this.cached;
    const size = 4;
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const x = i % size;
      const y = (i / size) | 0;
      const v = (x + y) % 2 === 0 ? 128 : 116;
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, size, size);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.cached = tex;
    return tex;
  }

  render(_desc: GpuBakeDesc): THREE.Texture {
    return this.fallback();
  }

  renderMrt(desc: GpuBakeDesc): THREE.Texture[] {
    return new Array(desc.targets ?? 1).fill(this.fallback());
  }

  iterate(_desc: GpuBakeDesc, _iterations: number): THREE.Texture {
    return this.fallback();
  }

  renderToLayer(): void {}
  renderToVolume(): void {}

  renderImpostor(): { albedo: THREE.Texture; normalDepth: THREE.Texture; radius: number } {
    return { albedo: this.fallback(), normalDepth: this.fallback(), radius: 1 };
  }

  async readback(_texture: THREE.Texture, out?: Float32Array): Promise<Float32Array> {
    return out ?? new Float32Array(0);
  }

  buildMips(): void {}
}

/**
 * Null worker pool: size 0, everything runs inline. This is not a degradation —
 * the contract REQUIRES the inline fallback, so that no lane is ever blocked on
 * workers existing or on COOP/COEP headers the dev server does not send.
 */
class NullWorkerPool implements WorkerPool {
  readonly size = 0;
  async run<TIn, TOut>(job: string, _payload: TIn): Promise<TOut> {
    throw new Error(`WorkerPool: job "${job}" has no inline implementation (BAKE has not landed worker-pool.ts)`);
  }
  async map<TIn, TOut>(job: string, payloads: readonly TIn[]): Promise<TOut[]> {
    const out: TOut[] = [];
    for (const p of payloads) out.push(await this.run<TIn, TOut>(job, p));
    return out;
  }
}

/**
 * Null noise library. Real, deterministic, hash-based value noise so a lane
 * testing scatter or displacement day 0 gets a plausible field rather than a
 * plane. BAKE replaces it with the version whose GLSL is bit-matched to the CPU
 * path — until then, DO NOT rely on CPU/GPU parity from this.
 */
function vhash(x: number, y: number, z: number, seed: number): number {
  let h = hashInt(x | 0) ^ Math.imul(hashInt(y | 0), 0x27d4eb2d) ^ Math.imul(hashInt(z | 0), 0x165667b1);
  h = (h ^ seed) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

const GLSL_HASH = `
float ironHash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float ironHash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ironHash31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
`;

const GLSL_VALUE = `
float ironValue2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ironHash21(i), ironHash21(i + vec2(1,0)), u.x),
             mix(ironHash21(i + vec2(0,1)), ironHash21(i + vec2(1,1)), u.x), u.y);
}
float ironValue3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(ironHash31(i), ironHash31(i + vec3(1,0,0)), u.x), mix(ironHash31(i + vec3(0,1,0)), ironHash31(i + vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(ironHash31(i + vec3(0,0,1)), ironHash31(i + vec3(1,0,1)), u.x), mix(ironHash31(i + vec3(0,1,1)), ironHash31(i + vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z);
}
`;

const GLSL_FBM = `
float ironFbm2(vec2 p, int octaves, float lacunarity, float gain){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= octaves) break; sum += a * ironValue2(p); norm += a; p *= lacunarity; a *= gain; }
  return norm > 0.0 ? sum / norm : 0.0;
}
float ironRidged2(vec2 p, int octaves){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= octaves) break; float n = 1.0 - abs(ironValue2(p) * 2.0 - 1.0); sum += a * n * n; norm += a; p *= 2.03; a *= 0.5; }
  return norm > 0.0 ? sum / norm : 0.0;
}
`;

class NullNoiseLib implements NoiseLib {
  value2(x: number, y: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = fade(x - xi);
    const fy = fade(y - yi);
    const a = vhash(xi, yi, 0, seed);
    const b = vhash(xi + 1, yi, 0, seed);
    const c = vhash(xi, yi + 1, 0, seed);
    const d = vhash(xi + 1, yi + 1, 0, seed);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  simplex2(x: number, y: number, seed: number): number {
    // Signed, rotated value noise. Not a true simplex lattice — it has the same
    // range and continuity, which is all the null needs to be useful.
    const rx = x * 0.8660254 - y * 0.5;
    const ry = x * 0.5 + y * 0.8660254;
    return this.value2(rx, ry, seed) * 2 - 1;
  }

  simplex3(x: number, y: number, z: number, seed: number): number {
    const zi = Math.floor(z);
    const fz = fade(z - zi);
    const a = this.simplex2(x + zi * 31.7, y - zi * 17.3, seed);
    const b = this.simplex2(x + (zi + 1) * 31.7, y - (zi + 1) * 17.3, seed);
    return a + (b - a) * fz;
  }

  fbm2(x: number, y: number, octaves: number, lacunarity: number, gain: number, seed: number): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.value2(px, py, seed + i * 977);
      norm += amp;
      px *= lacunarity;
      py *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  ridged2(x: number, y: number, octaves: number, seed: number): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.value2(px, py, seed + i * 613) * 2 - 1);
      sum += amp * n * n;
      norm += amp;
      px *= 2.03;
      py *= 2.03;
      amp *= 0.5;
    }
    return norm > 0 ? sum / norm : 0;
  }

  worley2(x: number, y: number, seed: number): { f1: number; f2: number; cell: number } {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = Infinity;
    let f2 = Infinity;
    let cell = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = xi + ox;
        const cy = yi + oy;
        const px = cx + vhash(cx, cy, 1, seed);
        const py = cy + vhash(cx, cy, 2, seed);
        const d = Math.hypot(px - x, py - y);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          cell = (cx * 73856093) ^ (cy * 19349663);
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    return { f1, f2, cell: cell >>> 0 };
  }

  curl3(x: number, y: number, z: number, seed: number, out: Vec3): Vec3 {
    const e = 0.1;
    const n = (px: number, py: number, pz: number, s: number): number => this.simplex3(px, py, pz, s);
    const dydz = (n(x, y + e, z, seed) - n(x, y - e, z, seed)) / (2 * e);
    const dzdy = (n(x, y, z + e, seed + 1) - n(x, y, z - e, seed + 1)) / (2 * e);
    const dzdx = (n(x, y, z + e, seed + 2) - n(x, y, z - e, seed + 2)) / (2 * e);
    const dxdz = (n(x + e, y, z, seed + 3) - n(x - e, y, z, seed + 3)) / (2 * e);
    const dxdy = (n(x + e, y, z, seed + 4) - n(x - e, y, z, seed + 4)) / (2 * e);
    const dydx = (n(x, y + e, z, seed + 5) - n(x, y - e, z, seed + 5)) / (2 * e);
    return out.set(dydz - dzdy, dzdx - dxdz, dxdy - dydx);
  }

  readonly glsl = Object.freeze({
    hash: GLSL_HASH,
    value: GLSL_VALUE,
    simplex: GLSL_VALUE,
    worley: `float ironWorley2(vec2 p){ vec2 i = floor(p); float f1 = 8.0; for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++) { vec2 c = i + vec2(float(x), float(y)); vec2 o = vec2(ironHash21(c), ironHash21(c + 17.3)); f1 = min(f1, length(c + o - p)); } return f1; }`,
    fbm: GLSL_FBM,
    ridged: GLSL_FBM,
    curl: `vec3 ironCurl3(vec3 p){ float e = 0.1; float a = ironValue3(p + vec3(0.0, e, 0.0)) - ironValue3(p - vec3(0.0, e, 0.0)); float b = ironValue3(p + vec3(0.0, 0.0, e)) - ironValue3(p - vec3(0.0, 0.0, e)); float c = ironValue3(p + vec3(e, 0.0, 0.0)) - ironValue3(p - vec3(e, 0.0, 0.0)); return normalize(vec3(a - b, b - c, c - a) + 1e-5); }`,
    warp: `vec2 ironWarp2(vec2 p, float amount){ return p + amount * vec2(ironValue2(p + 11.7), ironValue2(p - 5.3)); }`,
    gabor: `float ironGabor(vec2 p, float freq, float angle){ vec2 d = vec2(cos(angle), sin(angle)); return exp(-dot(p, p) * 2.0) * cos(6.2831853 * freq * dot(p, d)); }`,
    triplanar: `vec3 ironTriplanarWeights(vec3 n, float sharpness){ vec3 w = pow(abs(n), vec3(sharpness)); return w / max(dot(w, vec3(1.0)), 1e-4); }`,
    stochastic: `vec2 ironStochasticUv(vec2 uv, out float w){ vec2 i = floor(uv); w = 1.0; return uv + vec2(ironHash21(i), ironHash21(i + 3.7)); }`,
    detail: `float ironDetailFade(float dist, float start, float end){ return 1.0 - smoothstep(start, end, dist); }`,
    wear: `float ironWear(float curvature, float ao, float bias){ return clamp(curvature * (1.0 - ao) + bias, 0.0, 1.0); }`,
    packing: `vec2 ironOctEncode(vec3 n){ n /= (abs(n.x) + abs(n.y) + abs(n.z)); vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * sign(n.xy); return e * 0.5 + 0.5; }
vec3 ironOctDecode(vec2 e){ e = e * 2.0 - 1.0; vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y)); float t = max(-n.z, 0.0); n.xy += n.xy.x >= 0.0 ? -t : t; return normalize(n); }`,
    colorspace: `vec3 ironSrgbToLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }`,
  });
}

interface RegisteredStep {
  id: string;
  kind: AssetKind;
  step: BakeStep<unknown>;
  value?: unknown;
  done: boolean;
}

/**
 * Null asset registry. It is deliberately FUNCTIONAL rather than inert: it
 * records declarations, resolves them in topological dependency order, reports
 * aggregate progress weighted by cost, and enforces the unit ceiling by
 * degrading `grantedTexelSize`. That is what drives the loading screen and
 * `markReady()` from day 0. What it does NOT have is a GPU device, a worker
 * pool, an IndexedDB cache or real noise — BAKE lands those in Wave 1a.
 */
export class NullAssetRegistry implements AssetRegistry {
  readonly gpu: GpuBakeDevice = new NullGpuBakeDevice();
  readonly workers: WorkerPool = new NullWorkerPool();
  readonly noise: NoiseLib = new NullNoiseLib();

  private readonly steps = new Map<string, RegisteredStep>();
  private readonly order: string[] = [];
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
    private readonly nowMs: () => number,
  ) {}

  define<T>(id: string, kind: AssetKind, step: Omit<BakeStep<T>, 'key'>): AssetKey<T> {
    if (this.steps.has(id)) throw new Error(`asset "${id}" defined twice`);
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
    return s.value as T;
  }

  tryGet<T>(key: AssetKey<T>): T | undefined {
    const s = this.steps.get(key.id);
    return s?.done ? (s.value as T) : undefined;
  }

  async bakeAll(onProgress: (p: BakeProgress) => void): Promise<void> {
    const start = this.nowMs();
    const sorted = this.topoSort();
    const totalCost = sorted.reduce((a, s) => a + Math.max(1, s.step.cost), 0);
    const ceiling = this.quality().bake.unitCeiling;
    // Over budget: halve the granted texel size on the most expensive steps
    // until we fit. A missing material is a defect; a 256² material is softer.
    const degradeFactor = totalCost > ceiling ? Math.max(0.25, ceiling / totalCost) : 1;
    const degraded: string[] = [];
    const perStepMs: Record<string, number> = {};

    let spent = 0;
    const tier = this.quality().tier;
    for (const entry of sorted) {
      const cost = Math.max(1, entry.step.cost);
      if (entry.step.minTier !== undefined && tier < entry.step.minTier) {
        entry.done = true;
        entry.value = undefined;
        spent += cost;
        continue;
      }
      const t0 = this.nowMs();
      const ctx = this.makeContext(entry, degradeFactor, degraded, (f) => {
        onProgress({
          fraction: clamp((spent + cost * clamp(f, 0, 1)) / totalCost, 0, 1),
          phase: entry.id,
          stepId: entry.id,
          elapsedMs: this.nowMs() - start,
        });
      });
      entry.value = await entry.step.run(ctx);
      entry.done = true;
      perStepMs[entry.id] = this.nowMs() - t0;
      spent += cost;
      onProgress({
        fraction: clamp(spent / totalCost, 0, 1),
        phase: entry.id,
        stepId: entry.id,
        elapsedMs: this.nowMs() - start,
      });
      // Yield unconditionally between steps: a bake that never returns to the
      // event loop looks identical to a hang from outside the tab, and the
      // capture tool's only signal is the harness status string.
      await nextFrame();
    }

    this.statsValue = {
      totalMs: this.nowMs() - start,
      perStepMs,
      textureBytes: 0,
      geometryBytes: 0,
      audioBytes: 0,
      cacheHits: 0,
      degraded,
    };
  }

  private makeContext(
    entry: RegisteredStep,
    degradeFactor: number,
    degraded: string[],
    progress: (f: number) => void,
  ): BakeRunContext {
    const quality = this.quality();
    const registry = this;
    return {
      quality,
      profile: quality.bake,
      rng: this.rng.fork(`bake:${entry.id}`),
      gpu: this.gpu,
      workers: this.workers,
      noise: this.noise,
      renderer: this.renderer,
      audioCtx: getOfflineAudioContext(),
      require<T>(key: AssetKey<T>): T {
        const declared = entry.step.dependsOn ?? [];
        if (!declared.some((d) => d.id === key.id)) {
          throw new Error(`bake "${entry.id}" required "${key.id}" without declaring it in dependsOn`);
        }
        return registry.get(key);
      },
      grantedTexelSize(requested: number): number {
        if (degradeFactor >= 1) return requested;
        // Halve in powers of two, never to an odd size: mip chains and
        // DataArrayTexture layers both assume power-of-two edges.
        let size = requested;
        while (size > 64 && size * size * degradeFactor < size * size * 0.75) {
          size >>= 1;
          if (size * size <= requested * requested * degradeFactor) break;
        }
        if (size !== requested && !degraded.includes(entry.id)) degraded.push(entry.id);
        return size;
      },
      progress(fraction01: number): void {
        progress(fraction01);
      },
      yieldFrame: nextFrame,
    };
  }

  /** Kahn's algorithm over `dependsOn`, tie-broken by declaration order. */
  private topoSort(): RegisteredStep[] {
    const out: RegisteredStep[] = [];
    const state = new Map<string, 0 | 1 | 2>();
    const visit = (id: string, chain: string[]): void => {
      const s = state.get(id) ?? 0;
      if (s === 2) return;
      if (s === 1) throw new Error(`bake dependency cycle: ${[...chain, id].join(' → ')}`);
      const entry = this.steps.get(id);
      if (!entry) throw new Error(`bake step "${id}" depends on an undefined asset`);
      state.set(id, 1);
      for (const dep of entry.step.dependsOn ?? []) visit(dep.id, [...chain, id]);
      state.set(id, 2);
      out.push(entry);
    };
    for (const id of this.order) visit(id, []);
    return out;
  }

  get stats(): Readonly<BakeStats> {
    return this.statsValue;
  }
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

let offlineCtx: OfflineAudioContext | null = null;
/**
 * `OfflineAudioContext` needs no user gesture, which is the whole reason audio
 * synthesis happens at bake time — the capture page never gets a gesture and a
 * live AudioContext would stay suspended forever.
 */
function getOfflineAudioContext(): OfflineAudioContext {
  if (!offlineCtx) offlineCtx = new OfflineAudioContext(2, 48_000, 48_000);
  return offlineCtx;
}

/* ==========================================================================
 * LIGHTING
 * ======================================================================= */

export function createNullLighting(): LightingService & { setSun(dir: Vec3, colour: THREE.Color, lux: number): void } {
  const sun = {
    direction: new THREE.Vector3(0.35, 0.18, -0.92).normalize(),
    color: new THREE.Color(1.0, 0.78, 0.52),
    // Golden hour: 12–25 klx on a surface normal to the sun. 18 klx sits in the
    // middle of the band and is what the exposure calibration assumes.
    illuminanceLux: 18_000,
    angularRadius: 0.00465,
    elevationDeg: 9,
    azimuthDeg: 285,
  };
  const ambientSH = new Float32Array(27);
  // L0 only: a flat sky-blue ambient. Enough that a lane's first render is not
  // a silhouette, honest about having no directional information.
  ambientSH[0] = 0.34;
  ambientSH[1] = 0.40;
  ambientSH[2] = 0.48;

  const environment = new THREE.DataTexture(new Uint8Array([120, 140, 165, 255]), 1, 1);
  environment.needsUpdate = true;

  let nextHandle = 1;
  const lights = new Map<number, LocalLight>();

  return {
    sun,
    ambientSH,
    skyIlluminanceLux: 4200,
    cascadeMatrices: new Float32Array(16 * 4),
    cascadeSplits: new Float32Array([12, 38, 110, 300]),
    environment,
    addLight(light: LocalLight): LightHandle {
      const h = nextHandle++;
      lights.set(h, light);
      return h as LightHandle;
    },
    updateLight(handle: LightHandle, patch: Partial<LocalLight>): void {
      const l = lights.get(handle as number);
      if (l) Object.assign(l, patch);
    },
    removeLight(handle: LightHandle): void {
      lights.delete(handle as number);
    },
    flash(): void {},
    get maxLocalLights(): number {
      return 64;
    },
    get activeLights(): number {
      return lights.size;
    },
    setSun(dir: Vec3, colour: THREE.Color, lux: number): void {
      sun.direction.copy(dir);
      sun.color.copy(colour);
      sun.illuminanceLux = lux;
      sun.elevationDeg = Math.asin(clamp(dir.y, -1, 1)) / DEG2RAD;
      sun.azimuthDeg = (Math.atan2(dir.x, dir.z) / DEG2RAD + 360) % 360;
    },
  };
}

/* ==========================================================================
 * SKY
 * ======================================================================= */

export interface NullSky extends SkyService {
  /** Exposed so the SKY stub can drive its placeholder background from state. */
  readonly mutableState: SkyState;
}

export function createNullSky(): NullSky {
  const state: SkyState = {
    // 17:24 — the golden-hour anchor the whole look spec is calibrated to.
    timeOfDayHours: 17.4,
    overcast: 0.06,
    turbidity: 3.4,
    windSpeed: 4.5,
    windDirectionRad: 2.15,
    rain: 0,
    fogDensity: 0.0032,
    dustDensity: 0.35,
    wetness: 0,
  };
  const mutable = state as { -readonly [K in keyof SkyState]: SkyState[K] };
  let dirty = true;

  const sunDir = (out: Vec3): Vec3 => {
    // A single-axis solar model: elevation peaks at noon and the azimuth swings
    // from east to west. Not astronomically correct — SKY replaces it — but it
    // makes `setTimeOfDay` behave the way a shot author expects.
    const h = mutable.timeOfDayHours;
    const dayFraction = clamp((h - 6) / 12, -0.2, 1.2);
    const elevation = Math.sin(dayFraction * Math.PI) * 62 * DEG2RAD;
    const azimuth = (90 + dayFraction * 180) * DEG2RAD;
    const cosE = Math.cos(elevation);
    return out.set(Math.sin(azimuth) * cosE, Math.sin(elevation), Math.cos(azimuth) * cosE).normalize();
  };

  const scratch = new THREE.Vector3();

  return {
    get state(): Readonly<SkyState> {
      return state;
    },
    get mutableState(): SkyState {
      return state;
    },
    setState(patch: Partial<SkyState>): void {
      Object.assign(mutable, patch);
      dirty = true;
    },
    setTimeOfDay(hours: number): void {
      mutable.timeOfDayHours = hours;
      dirty = true;
    },
    setWeather(overcast: number, options): void {
      mutable.overcast = clamp(overcast, 0, 1);
      if (options?.wind !== undefined) mutable.windSpeed = options.wind;
      if (options?.rain !== undefined) mutable.rain = clamp(options.rain, 0, 1);
      if (options?.fog !== undefined) mutable.fogDensity = options.fog;
      mutable.wetness = clamp(mutable.rain * 0.85, 0, 1);
      dirty = true;
    },
    sunDirection: sunDir,
    sunRadiance(out): THREE.Color {
      sunDir(scratch);
      // Low sun ⇒ long optical path ⇒ Rayleigh strips the blue first. This is a
      // crude ramp, not a scattering integral, but it gets the hue direction right.
      const elev = clamp(scratch.y, 0, 1);
      const warm = 1 - smoothstep(0.02, 0.5, elev);
      return out.setRGB(1.0, 0.94 - warm * 0.32, 0.86 - warm * 0.55);
    },
    radianceTowards(direction, out): THREE.Color {
      const t = clamp(direction.y * 0.5 + 0.5, 0, 1);
      const horizon = 1 - smoothstep(0.5, 0.8, t);
      return out.setRGB(
        0.24 + horizon * 0.62,
        0.38 + horizon * 0.34,
        0.62 + horizon * 0.02,
      );
    },
    get dirty(): boolean {
      const d = dirty;
      dirty = false;
      return d;
    },
  };
}

/* ==========================================================================
 * TERRAIN / WATER / VEGETATION / LEVEL
 * ======================================================================= */

function whiteTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

/**
 * Null terrain. Height comes from MACRO_TERRAIN rather than being flat at zero:
 * the macro silhouette exists precisely so that LEVEL, VEG, WATER and AI place
 * things correctly before TERRAIN's eroded heightfield lands, and a null that
 * disagreed with it would put every lane's day-0 props underground.
 */
export function createNullTerrain(macro: MacroTerrain = MACRO_TERRAIN): TerrainService {
  const bounds = new THREE.Box3(
    new THREE.Vector3(macro.bounds.minX, -40, macro.bounds.minZ),
    new THREE.Vector3(macro.bounds.maxX, 120, macro.bounds.maxZ),
  );
  const heightfield = {
    data: new Float32Array(0),
    size: 0,
    scale: new THREE.Vector3(1, 1, 1) as Vec3,
  };
  const tex = whiteTexture();
  const scratch = { x: 0, y: 1, z: 0 };

  return {
    ready: true,
    bounds,
    seaLevel: macro.seaLevel,
    heightAt: (x, z) => macro.height(x, z),
    normalAt(x, z, out): Vec3 {
      macroNormal(x, z, scratch);
      return out.set(scratch.x, scratch.y, scratch.z);
    },
    slopeAt(x, z): number {
      macroNormal(x, z, scratch);
      return Math.acos(clamp(scratch.y, -1, 1));
    },
    surfaceAt(x, z): SurfaceId {
      const shore = macro.shoreDistance(x, z);
      if (shore < 0) return SurfaceId.WetSand;
      if (shore < 14) return SurfaceId.Sand;
      macroNormal(x, z, scratch);
      return scratch.y < 0.72 ? SurfaceId.Rubble : SurfaceId.Dirt;
    },
    raycast(origin, direction, maxDistance, out): number {
      // Fixed-step march against the analytic field, refined by bisection once a
      // crossing is bracketed. Cheap, and good to a few centimetres.
      const step = Math.max(0.5, maxDistance / 256);
      let prevT = 0;
      let prevD = origin.y - macro.height(origin.x, origin.z);
      for (let t = step; t <= maxDistance; t += step) {
        const px = origin.x + direction.x * t;
        const py = origin.y + direction.y * t;
        const pz = origin.z + direction.z * t;
        const d = py - macro.height(px, pz);
        if (d <= 0 && prevD > 0) {
          let lo = prevT;
          let hi = t;
          for (let i = 0; i < 12; i++) {
            const mid = (lo + hi) * 0.5;
            const mx = origin.x + direction.x * mid;
            const my = origin.y + direction.y * mid;
            const mz = origin.z + direction.z * mid;
            if (my - macro.height(mx, mz) <= 0) hi = mid;
            else lo = mid;
          }
          out.set(origin.x + direction.x * hi, origin.y + direction.y * hi, origin.z + direction.z * hi);
          return hi;
        }
        prevT = t;
        prevD = d;
      }
      return -1;
    },
    collisionHeightfield: heightfield,
    heightMap: tex,
    splatMap: tex,
    shoreMask: tex,
    // The map rect IS the macro bounds, so a shader that samples the null
    // shoreMask and a CPU path that calls `MACRO_TERRAIN.shoreDistance` land on
    // the same shoreline. TERRAIN keeps this true when the real maps arrive:
    // if the rect and the macro bounds ever diverge, water's foam band and its
    // wave damping quietly stop agreeing and it reads as a water bug.
    mapRect: {
      minX: macro.bounds.minX,
      minZ: macro.bounds.minZ,
      sizeX: macro.bounds.maxX - macro.bounds.minX,
      sizeZ: macro.bounds.maxZ - macro.bounds.minZ,
    },
    // ±120 m of signed distance across an R8 texel is ~0.94 m per code —
    // coarse, but the foam band is metres wide, and the null mask is a flat
    // white texture anyway. Real TERRAIN narrows it.
    shoreRangeMetres: 120,
  };
}

export function createNullWater(macro: MacroTerrain = MACRO_TERRAIN): WaterService {
  return {
    seaLevel: macro.seaLevel,
    heightAt: () => macro.seaLevel,
    normalAt: (_x, _z, out) => out.copy(UP),
    isSubmerged: (point) => point.y < macro.seaLevel,
    splash(): void {},
    setUnderwater(): void {},
  };
}

export function createNullVegetation(): VegetationService {
  let nextHandle = 1;
  return {
    windAt(position, time, out): Vec3 {
      // One coherent gust field so flora, cloth, particles and audio agree on
      // phase even before VEG lands. 0.35 Hz is a Mediterranean onshore breeze.
      const phase = time * 0.35 + position.x * 0.011 + position.z * 0.008;
      const gust = 0.6 + 0.4 * Math.sin(time * 0.13 + position.x * 0.004);
      return out.set(Math.sin(phase) * 2.4 * gust, 0, Math.cos(phase * 0.83) * 1.6 * gust);
    },
    addExclusion() {
      return nextHandle++ as unknown as ReturnType<VegetationService['addExclusion']>;
    },
    removeExclusion(): void {},
    disturb(): void {},
    scorch(): void {},
    densityAt: () => 0,
    stats: { grass: 0, trees: 0, impostors: 0, drawCalls: 0 },
  };
}

/** The three capture points, derived from the frozen macro anchors. */
export function nullCapturePoints(): CapturePointDef[] {
  return [
    {
      id: 'ALPHA',
      label: 'MARKET SQUARE',
      centre: new THREE.Vector3(MACRO_ANCHORS.alpha.x, MACRO_ANCHORS.alpha.height, MACRO_ANCHORS.alpha.z),
      radius: 22,
      height: 12,
      initialOwner: Team.Neutral,
    },
    {
      id: 'BRAVO',
      label: 'HARBOUR CRANES',
      centre: new THREE.Vector3(MACRO_ANCHORS.bravo.x, MACRO_ANCHORS.bravo.height, MACRO_ANCHORS.bravo.z),
      radius: 26,
      height: 16,
      initialOwner: Team.Neutral,
    },
    {
      id: 'CHARLIE',
      label: 'OLD FORT',
      centre: new THREE.Vector3(MACRO_ANCHORS.charlie.x, MACRO_ANCHORS.charlie.height, MACRO_ANCHORS.charlie.z),
      radius: 20,
      height: 14,
      initialOwner: Team.Neutral,
    },
  ];
}

export function nullSpawnPoints(): SpawnPointDef[] {
  const at = (x: number, z: number, yaw: number, linked: CapturePointDef['id'] | null): SpawnPointDef => ({
    team: linked === 'CHARLIE' ? Team.Insurgent : Team.Coalition,
    position: new THREE.Vector3(x, MACRO_TERRAIN.height(x, z) + 0.1, z),
    yaw,
    linkedPoint: linked,
  });
  return [
    at(150, 210, Math.PI, null),
    at(120, 205, Math.PI, 'ALPHA'),
    at(-300, 40, 0.4, null),
    at(-260, 10, 0.6, 'CHARLIE'),
    at(20, 60, Math.PI * 0.9, 'BRAVO'),
  ];
}

export function createNullLevel(root: THREE.Object3D): LevelService {
  const capturePoints = nullCapturePoints();
  const spawnPoints = nullSpawnPoints();
  const poses = new Map<string, CameraRigPose>();
  const addPose = (name: string, p: [number, number, number], t: [number, number, number], fov: number): void => {
    poses.set(name, {
      name,
      position: new THREE.Vector3(...p),
      target: new THREE.Vector3(...t),
      fovDeg: fov,
    });
  };
  // Shared camera poses every lane's shots can reference by name. These frame
  // the macro silhouette, so they stay meaningful once real geometry lands.
  addPose('establish_harbour', [96, 34, 168], [-140, 8, -30], 42);
  addPose('alpha_square', [96, 15, 140], [78, 11, 96], 55);
  addPose('bravo_quay', [46, 12, 62], [-26, 4, 6], 60);
  addPose('charlie_fort', [-140, 42, 26], [-212, 30, -48], 48);
  addPose('breakwater_low', [10, 4, 6], [140, 2, -96], 65);

  return {
    name: 'harbour-reach (null)',
    ready: true,
    root,
    capturePoints,
    spawnPoints,
    coverSlots: [] as readonly CoverSlot[],
    playableBounds: new THREE.Box3(
      new THREE.Vector3(MACRO_TERRAIN.bounds.minX, -30, MACRO_TERRAIN.bounds.minZ),
      new THREE.Vector3(MACRO_TERRAIN.bounds.maxX, 140, MACRO_TERRAIN.bounds.maxZ),
    ),
    collectColliders: () => [] as readonly StaticColliderDef[],
    collectDestructibles: () => [] as readonly DestructibleDef[],
    findCover: () => null,
    cameraPose: (name) => poses.get(name),
    get cameraPoseNames(): readonly string[] {
      return [...poses.keys()];
    },
  };
}

/* ==========================================================================
 * PHYSICS + DESTRUCTION
 * ======================================================================= */

function missHit(out: RayHit): boolean {
  out.hit = false;
  out.distance = 0;
  out.point.set(0, 0, 0);
  out.normal.copy(UP);
  out.surface = SurfaceId.Sand;
  out.body = -1 as BodyHandle;
  out.entity = 0 as EntityId;
  out.zone = HitZone.None;
  out.backface = false;
  return false;
}

/**
 * Null physics. Rays ALWAYS MISS, which is the documented null behaviour: a
 * weapon lane can fire, a bot can shoot, and nothing errors. `world` and
 * `rapier` throw on access — nothing but PHYS itself has any business touching
 * the raw solver, and returning a fabricated object there would hide a real bug.
 */
export function createNullPhysics(): PhysicsService {
  let nextBody = 1;
  return {
    ready: false,
    get world(): RAPIER.World {
      throw new Error('PhysicsService.world: PHYS has not landed src/physics/system.ts');
    },
    get rapier(): typeof RAPIER {
      throw new Error('PhysicsService.rapier: PHYS has not landed src/physics/system.ts');
    },
    step(): void {},
    createBody(): BodyHandle {
      return nextBody++ as BodyHandle;
    },
    destroyBody(): void {},
    addStatic(): BodyHandle {
      return nextBody++ as BodyHandle;
    },
    setKinematicTarget(): void {},
    bodyTransform: () => false,
    applyImpulse(): void {},
    applyRadialImpulse(): void {},
    raycast: (_o, _d, _m, _f, out) => missHit(out),
    raycastAll: () => 0,
    sphereCast: (_o, _d, _r, _m, _f, out) => missHit(out),
    overlapSphere: () => 0,
    visibility: () => 1,
    createCharacter(config: CharacterConfig): CharacterController {
      return createNullCharacter(config);
    },
    entityOf: () => 0 as EntityId,
    stats: { bodies: 0, awake: 0, stepMs: 0 },
  };
}

/**
 * Null character controller: free movement with a hard floor at y = 0. It moves
 * where you ask it to, which lets GAME's locomotion be written and felt before
 * rapier exists — the collide-and-slide response is the only part that is fake.
 */
function createNullCharacter(config: CharacterConfig): CharacterController {
  const position = config.position.clone();
  const groundNormal = UP.clone();
  const result: CharacterMoveResult = {
    translation: new THREE.Vector3(),
    grounded: true,
    groundNormal,
    groundSurface: SurfaceId.Sand,
    groundEntity: 0 as EntityId,
    hitWall: false,
    wallNormal: new THREE.Vector3(),
    slideRatio: 1,
    steppedUp: 0,
    ceilingHit: false,
  };
  const mutable = result as { -readonly [K in keyof CharacterMoveResult]: CharacterMoveResult[K] };

  return {
    get position(): Vec3 {
      return position;
    },
    get grounded(): boolean {
      return position.y <= 0.01;
    },
    groundNormal,
    groundSurface: SurfaceId.Sand,
    move(desiredDelta): CharacterMoveResult {
      position.add(desiredDelta);
      let grounded = false;
      if (position.y < 0) {
        position.y = 0;
        grounded = true;
      } else if (position.y <= 0.01) {
        grounded = true;
      }
      mutable.translation.copy(desiredDelta);
      mutable.grounded = grounded;
      mutable.hitWall = false;
      mutable.slideRatio = 1;
      mutable.steppedUp = 0;
      mutable.ceilingHit = false;
      return result;
    },
    teleport(p): void {
      position.copy(p);
    },
    setHeight: () => true,
    config,
    dispose(): void {},
  };
}

export function createNullDestruction(): DestructionService {
  return {
    register(): void {},
    applyDamage(info: DamageInfo): DestructionResult {
      return {
        destroyed: false,
        chunksSpawned: 0,
        surface: info.surface,
        coverLost: false,
        position: info.point,
      };
    },
    chip(): void {},
    isIntact: () => true,
    healthFraction: () => 1,
    reset(): void {},
    stats: { chunksLive: 0, chunksSettled: 0, budgetUsed01: 0 },
  };
}

/* ==========================================================================
 * WEAPONS
 * ======================================================================= */

/**
 * One generic service rifle, returned for every `WeaponId`. The numbers are
 * plausible rather than authored — WEAPONS owns the real tables — but they are
 * internally consistent, so a HUD reading `magazine` and a viewmodel reading
 * `ads.time` day 0 both show something sane.
 */
function nullWeaponDef(id: WeaponId): WeaponDef {
  const v3 = (x: number, y: number, z: number): Vec3 => new THREE.Vector3(x, y, z);
  return {
    id,
    name: 'SERVICE RIFLE',
    class: 'ar',
    fireModes: [FireMode.Semi, FireMode.Auto],
    rpm: 720,
    burstCount: 3,
    magazine: 30,
    reserve: 150,
    pelletsPerShot: 1,
    reloadTactical: 2.1,
    reloadEmpty: 2.9,
    deployTime: 0.55,
    spread: {
      baseHip: 2.4,
      baseAds: 0.22,
      crouchMultiplier: 0.78,
      proneMultiplier: 0.6,
      perShot: 0.16,
      max: 5.5,
      decay: 4.0,
      movementFactor: 0.18,
      airborneMultiplier: 2.4,
    },
    recoil: {
      steps: [
        [0.42, 0.02], [0.46, -0.06], [0.5, 0.09], [0.52, -0.12],
        [0.55, 0.14], [0.55, -0.16], [0.56, 0.18], [0.56, -0.2],
      ],
      randomPitch: 0.05,
      randomYaw: 0.09,
      recovery: { stiffness: 180, damping: 0.75, mass: 1 },
      recoveryDelay: 0.09,
      recoveredFraction: 0.72,
      adsMultiplier: 0.82,
    },
    view: {
      cameraKick: { stiffness: 420, damping: 0.62, mass: 1 },
      cameraKickImpulse: v3(-0.028, 0.006, 0.012),
      weaponKick: { stiffness: 340, damping: 0.58, mass: 1 },
      weaponKickPos: v3(0, 0.004, 0.028),
      weaponKickRot: v3(-0.05, 0.012, 0.02),
      sway: {
        gain: v3(0.045, 0.045, 0.02),
        spring: { stiffness: 90, damping: 0.9, mass: 1 },
        maxOffset: 0.05,
        adsScale: 0.28,
      },
      bob: {
        walk: v3(0.012, 0.016, 0.004),
        sprint: v3(0.028, 0.03, 0.012),
        cyclesPerMetre: 0.55,
        landImpulse: 0.05,
        adsScale: 0.25,
      },
      lean: { maxDeg: 18, offset: 0.3, speed: 7 },
      breathe: { amplitude: 0.0035, frequencyHz: 0.28, holdScale: 0.15 },
      sprintPose: { position: v3(0.03, -0.04, 0.06), rotation: v3(0.2, -0.5, 0.35), blendTime: 0.22 },
    },
    ads: {
      time: 0.22,
      curve: 'outCubic',
      fovMultiplier: 0.72,
      sensitivityMultiplier: 0.68,
      hipOffset: v3(0.12, -0.09, -0.24),
      adsOffset: v3(0, -0.038, -0.14),
      adsRotation: v3(0, 0, 0),
      magnification: 1,
    },
    ballistics: {
      muzzleVelocity: 880,
      massKg: 0.004,
      dragCoefficient: 0.0009,
      gravityScale: 1,
      maxRange: 900,
      damage: [
        { distance: 0, damage: 26 },
        { distance: 40, damage: 24 },
        { distance: 90, damage: 18 },
        { distance: 200, damage: 14 },
      ],
      zoneMultipliers: {
        [HitZone.None]: 1,
        [HitZone.Head]: 2.1,
        [HitZone.Torso]: 1,
        [HitZone.Stomach]: 0.95,
        [HitZone.Arm]: 0.85,
        [HitZone.Leg]: 0.8,
      },
      penetrationEnergy: 1400,
      maxPenetrations: 2,
      tracerEvery: 4,
    },
    mesh: placeholderKey<MeshAsset>(`weapon.${id}`, AssetKind.Mesh),
    sounds: {
      fire: 'w.rifle.fire',
      fireDistant: 'w.distant',
      tail: 'w.tail',
      dryFire: 'w.dry',
      magOut: 'w.magout',
      magIn: 'w.magin',
      bolt: 'w.bolt',
      ads: 'w.ads',
    },
    muzzle: {
      offset: v3(0, 0.02, -0.42),
      // ~6e5 cd for ~35 ms is a real rifle flash; it genuinely lights a room.
      flashIntensityCd: 6e5,
      flashRadius: 9,
      flashDuration: 0.035,
      smokeRate: 3,
    },
    ejection: { offset: v3(0.06, 0.01, -0.05), velocity: v3(2.2, 1.4, -0.4) },
  };
}

export function createNullWeapons(): WeaponService {
  const cache = new Map<WeaponId, WeaponDef>();
  const def = (id: WeaponId): WeaponDef => {
    let d = cache.get(id);
    if (!d) {
      d = nullWeaponDef(id);
      cache.set(id, d);
    }
    return d;
  };
  const ids: WeaponId[] = ['ar_service', 'carbine', 'dmr_marksman', 'smg_compact', 'lmg_support', 'shotgun', 'sidearm'];

  const state: WeaponState = {
    def: 'ar_service',
    ammo: 30,
    reserve: 150,
    fireMode: FireMode.Auto,
    nextFireTick: 0,
    reloadEndTick: 0,
    lastFireTick: -1,
    shotIndex: 0,
    burstRemaining: 0,
    recoilStep: 0,
    reloading: false,
    firing: false,
    adsSim: 0,
    adsWanted: false,
    aimPunch: new THREE.Vector3(),
    aimPunchVelocity: new THREE.Vector3(),
    currentSpreadDeg: 2.4,
    heat: 0,
  };

  return {
    def,
    get all(): readonly Readonly<WeaponDef>[] {
      return ids.map(def);
    },
    stateOf: () => state,
    equip(): void {},
    setTrigger(): void {},
    setAds(): void {},
    requestReload(): void {},
    cycleFireMode(): void {},
    aimBasis(_entity, outOrigin, outDirection): void {
      outOrigin.set(0, 1.62, 0);
      outDirection.set(0, 0, -1);
    },
    spreadDegrees: () => state.currentSpreadDeg,
  };
}

export function createNullBallistics(): BallisticsService {
  return {
    fire: () => 0,
    predictImpact: () => false,
    solveLead: () => false,
    nearestWhizby: () => -1,
    liveProjectiles: 0,
    clear(): void {},
  };
}

export function createNullViewmodel(): ViewmodelRig {
  const root = new THREE.Group();
  root.name = 'viewmodel(null)';
  const state: WeaponFeelState = {
    adsBlend: 0,
    sprintBlend: 0,
    bobPhase: 0,
    positionOffset: new THREE.Vector3(),
    rotationOffset: new THREE.Vector3(),
    cameraKick: new THREE.Vector3(),
    fovMultiplier: 1,
    muzzleWorld: new THREE.Vector3(),
    muzzleDirection: new THREE.Vector3(0, 0, -1),
    secondsSinceFire: 99,
  };
  return {
    root,
    state,
    update: () => state,
    muzzleWorld: (out) => out.copy(state.muzzleWorld),
    setVisible(visible: boolean): void {
      root.visible = visible;
    },
    forcePose(): void {},
  };
}

/* ==========================================================================
 * VFX / AUDIO / HUD
 * ======================================================================= */

export function createNullVfx(): VfxService {
  let next = 1;
  return {
    spawn: () => next++ as VfxHandle,
    stop(): void {},
    addDecal: (_r: DecalRequest) => next++ as DecalHandle,
    removeDecal(): void {},
    tracer: () => next++ as VfxHandle,
    clearTransient(): void {},
    stats: { particles: 0, decals: 0, ribbons: 0, drawCalls: 0 },
  };
}

/**
 * Silent audio service. Every method is a safe no-op and `unlock()` resolves
 * immediately: an AudioContext cannot start without a user gesture, the capture
 * page never gets one, and a throw or an unresolved await here means
 * `markReady()` never fires and EVERY shot in the repo goes red at once.
 */
export function createNullAudio(): AudioService {
  let next = 1;
  return {
    unlocked: false,
    async unlock(): Promise<void> {},
    play: () => next++ as SoundHandle,
    stop(): void {},
    setListener(): void {},
    setEnvironment(): void {},
    setBusGainDb(): void {},
    duck(): void {},
    stats: { voices: 0, bufferBytes: 0 },
  };
}

export function createNullHud(): HudService {
  let visible = true;
  return {
    get visible(): boolean {
      return visible;
    },
    setVisible(v: boolean): void {
      visible = v;
    },
    font: placeholderKey('hud.font', AssetKind.Font),
    showHitmarker(): void {},
    pushKillFeed(): void {},
    pushNotice(): void {},
    setDamageDirection(): void {},
    forceState(): void {},
  };
}

/* ==========================================================================
 * NAV / AI
 * ======================================================================= */

/**
 * Null navmesh: the whole macro terrain is walkable and every path is a straight
 * line. AI can be written and tuned against this from t0; what it cannot do is
 * find a route around a building, which is exactly what LEVEL's bake provides.
 */
export function createNullNav(macro: MacroTerrain = MACRO_TERRAIN): NavService {
  return {
    ready: false,
    sample(position, _radius, out): boolean {
      out.set(position.x, macro.height(position.x, position.z), position.z);
      return true;
    },
    findPath(from, to, out): number {
      if (out.length < 2) return 0;
      out[0].copy(from);
      out[1].copy(to);
      return 2;
    },
    raycastWalkable(_from, to, out): boolean {
      out.copy(to);
      return true;
    },
    randomPointNear(position, radius, rng, out): boolean {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * radius;
      const x = position.x + Math.cos(a) * r;
      const z = position.z + Math.sin(a) * r;
      out.set(x, macro.height(x, z), z);
      return true;
    },
    invalidate(): void {},
  };
}

export function createNullAi(): AiService {
  const intent: PlayerIntent = {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    pressed: 0,
    released: 0,
    weaponSlot: -1,
    aimAt: null,
  };
  const intentSource: IntentSource = {
    kind: 'bot',
    sample(_entity, _ctx, out): void {
      Object.assign(out, intent);
    },
  };
  /**
   * One plausible profile so `AiService.profiles` is never empty. GAME's
   * director balances bot counts by picking from this table — it cannot import
   * `src/ai/profiles.ts`, so an empty table would leave `spawnBot` uncallable
   * by the only lane the architecture asks to call it.
   */
  const profiles: readonly Readonly<BotProfile>[] = [
    {
      id: 'regular',
      reactionTime: 0.32,
      aimErrorDeg: 1.6,
      aimSpring: { stiffness: 140, damping: 0.85, mass: 1 },
      burstDiscipline: 0.6,
      aggression: 0.5,
      coverPreference: 0.6,
      hearingRange: 45,
      visionRange: 120,
      visionConeDeg: 100,
      preferredWeapons: ['ar_service'],
    },
  ];
  return {
    intentSource,
    bots: [],
    count: 0,
    spawnBot: (_team: Team, _profile: Readonly<BotProfile>, _spawn: Readonly<SpawnPointDef>) => 0 as EntityId,
    profiles,
    profile: (id) => profiles.find((p) => p.id === id),
    despawn(): void {},
    despawnAll(): void {},
    setDifficulty(): void {},
    notifyNoise(_e: NoiseEvent): void {},
    orderFor: (): SquadOrder | null => null,
    forceState(): void {},
  };
}

/* ==========================================================================
 * PLAYER + GAME MODE
 * ======================================================================= */

/** Local player entity id. Fixed, because the null has no entity allocator. */
const NULL_LOCAL_ENTITY = 0 as EntityId;

/**
 * THE CAPSULE, and the single source of truth for the soldier's dimensions.
 *
 * Exposed through `PlayerService.configOf`, which is how AI sizes the soldier
 * mesh, the per-zone hitbox stack and the muzzle/eye offsets. Both sides
 * hard-coding their own numbers is how bots end up floating with hitboxes off
 * the mesh, and the symptom reads as a physics bug in a third lane.
 */
const NULL_CAPSULE = {
  radius: 0.32,
  standHeight: 1.8,
  crouchHeight: 1.28,
  proneHeight: 0.63,
  skinWidth: 0.02,
  maxSlopeDeg: 50,
  stepHeight: 0.35,
  snapToGroundDistance: 0.4,
} as const;

/**
 * Eye offset below the top of the capsule — roughly the distance from the crown
 * of a helmet to the eyes. DERIVED, not authored: an eye height that drifts from
 * the capsule puts the camera inside geometry the collider says it cleared.
 */
const EYE_DROP = 0.18;

/** Eye height by stance, metres. */
const EYE_HEIGHT: Readonly<Record<Stance, number>> = {
  [Stance.Stand]: NULL_CAPSULE.standHeight - EYE_DROP,
  [Stance.Crouch]: NULL_CAPSULE.crouchHeight - EYE_DROP,
  [Stance.Prone]: NULL_CAPSULE.proneHeight - EYE_DROP,
};

/** Ground speed by stance, m/s. Sprint multiplies the standing figure. */
const STANCE_SPEED: Readonly<Record<Stance, number>> = {
  [Stance.Stand]: 4.2,
  [Stance.Crouch]: 2.1,
  [Stance.Prone]: 0.9,
};

const SPRINT_MULTIPLIER = 1.55;

/**
 * Pitch clamp. Not ±90°: at exactly vertical the yaw basis is degenerate and the
 * camera rolls, which reads as a bug in whatever lane happens to be looking.
 */
const MAX_PITCH = 85 * DEG2RAD;

/**
 * `PlayerService` plus the two dispatch entry points GAME's stub registers as
 * TickSystems. They are NOT on the contract interface: nothing outside
 * `src/game/` may drive locomotion, and the interface is what everything else
 * sees.
 */
export interface NullPlayerService extends PlayerService {
  /** `TickPhase.Intent`: one `sample()` per controlled entity, in attach order. */
  sampleIntents(ctx: TickCtx): void;
  /** `TickPhase.Movement`: intent → look → planar velocity → position. */
  stepLocomotion(ctx: TickCtx): void;
  /**
   * Harness reset: drop every attached bot and put the local player back on its
   * spawn pose. Without this a live session's wandering leaks into the next
   * capture and shots stop being byte-comparable.
   */
  resetTransient(): void;
}

interface NullController {
  readonly state: { -readonly [K in keyof PlayerState]: PlayerState[K] };
  readonly intent: PlayerIntent;
  source: IntentSource;
}

function zeroIntent(): PlayerIntent {
  return {
    moveX: 0,
    moveZ: 0,
    lookYaw: 0,
    lookPitch: 0,
    buttons: 0,
    pressed: 0,
    released: 0,
    weaponSlot: -1,
    aimAt: null,
  };
}

/**
 * Null locomotion. Stands the local player on the quay at BRAVO looking down the
 * breakwater — a viewpoint that frames the map, so a lane whose shot forgets to
 * pose the camera still gets a legible frame instead of the inside of the ground.
 *
 * It is a REAL controller registry, not a frozen struct, because that is the
 * seam AI is blocked on: `attachController` + the two dispatch hooks are what
 * make `AiService.intentSource.sample()` actually get called, for 24 bots, with
 * no physics and no GAME lane in the repo yet. Movement here is kinematic over
 * the analytic macro terrain — GAME replaces it with accel/friction/air control
 * through `CharacterController.move()`, and the seam does not change.
 */
export function createNullPlayer(humanSource: IntentSource): NullPlayerService {
  const controllers = new Map<EntityId, NullController>();
  /** Attach order. Iterating a Map keyed by object identity is banned; this is an array of ints. */
  const order: EntityId[] = [];
  let forced: string | null = null;

  /** The quay at BRAVO, looking down the breakwater. */
  const SPAWN_X = 18;
  const SPAWN_Z = 44;
  const SPAWN_YAW = -2.35;
  const SPAWN_PITCH = -0.06;

  const spawn = (entity: EntityId, team: Team, x: number, z: number, yaw: number, pitch: number): NullController => {
    const controller: NullController = {
      state: {
        entity,
        team,
        position: new THREE.Vector3(x, MACRO_TERRAIN.height(x, z), z),
        velocity: new THREE.Vector3(),
        eyeHeight: EYE_HEIGHT[Stance.Stand],
        yaw,
        pitch,
        health: 100,
        stance: Stance.Stand,
        grounded: true,
        sprinting: false,
        alive: true,
        stamina: 1,
        suppression: 0,
        groundSpeed: 0,
        lean: 0,
      },
      intent: zeroIntent(),
      source: humanSource,
    };
    controllers.set(entity, controller);
    order.push(entity);
    return controller;
  };

  const local = spawn(NULL_LOCAL_ENTITY, Team.Coalition, SPAWN_X, SPAWN_Z, SPAWN_YAW, SPAWN_PITCH);

  const service: NullPlayerService = {
    localEntity: NULL_LOCAL_ENTITY,
    get state(): Readonly<PlayerState> {
      return local.state;
    },
    get controlled(): readonly EntityId[] {
      return order;
    },
    stateOf: (entity) => controllers.get(entity)?.state ?? null,
    intentOf: (entity) => controllers.get(entity)?.intent ?? null,

    /**
     * The capsule this entity is moving with. AI reads it to size the rig and
     * the hitboxes; nothing else should ever invent these numbers.
     */
    configOf(entity): Readonly<CharacterConfig> | null {
      const controller = controllers.get(entity);
      if (!controller) return null;
      return {
        entity,
        ...NULL_CAPSULE,
        position: controller.state.position,
        group: CollisionGroup.Character,
        collidesWith: LAYER_SOLID,
      };
    },

    attachController(entity, team, source): void {
      const existing = controllers.get(entity);
      if (existing) {
        existing.source = source;
        return;
      }
      // Bots with no spawn point of their own start on the local player's tile;
      // AI teleports them the moment it has a real `SpawnPointDef`.
      spawn(entity, team, local.state.position.x, local.state.position.z, local.state.yaw, 0).source = source;
    },

    releaseController(entity): void {
      if (entity === NULL_LOCAL_ENTITY) return; // the human is never detached
      if (!controllers.delete(entity)) return;
      const i = order.indexOf(entity);
      if (i >= 0) order.splice(i, 1);
    },

    teleport(entity, position, yaw, pitch): void {
      const c = controllers.get(entity);
      if (!c) return;
      c.state.position.copy(position);
      c.state.velocity.set(0, 0, 0);
      c.state.yaw = yaw;
      c.state.pitch = pitch;
      c.state.groundSpeed = 0;
    },

    applyAimPunch(entity, pitchDeg, yawDeg): void {
      const c = controllers.get(entity);
      if (!c) return;
      c.state.pitch = clamp(c.state.pitch + pitchDeg * DEG2RAD, -MAX_PITCH, MAX_PITCH);
      c.state.yaw += yawDeg * DEG2RAD;
    },

    setForcedState(state): void {
      forced = state;
      const s = local.state;
      s.sprinting = state === 'sprint';
      s.stance = state === 'crouch' ? Stance.Crouch : state === 'prone' ? Stance.Prone : Stance.Stand;
      s.alive = state !== 'dead';
      s.eyeHeight = EYE_HEIGHT[s.stance];
    },

    resetTransient(): void {
      for (const entity of [...order]) service.releaseController(entity);
      forced = null;
      const s = local.state;
      s.position.set(SPAWN_X, MACRO_TERRAIN.height(SPAWN_X, SPAWN_Z), SPAWN_Z);
      s.velocity.set(0, 0, 0);
      s.yaw = SPAWN_YAW;
      s.pitch = SPAWN_PITCH;
      s.stance = Stance.Stand;
      s.eyeHeight = EYE_HEIGHT[Stance.Stand];
      s.sprinting = false;
      s.alive = true;
      s.health = 100;
      s.stamina = 1;
      s.suppression = 0;
      s.groundSpeed = 0;
      s.lean = 0;
      Object.assign(local.intent, zeroIntent());
      local.source = humanSource;
    },

    sampleIntents(ctx): void {
      for (const entity of order) {
        const c = controllers.get(entity);
        if (!c) continue;
        c.source.sample(entity, ctx, c.intent);
      }
    },

    stepLocomotion(ctx): void {
      for (const entity of order) {
        const c = controllers.get(entity);
        if (!c) continue;
        const s = c.state;
        const i = c.intent;
        const locked = entity === NULL_LOCAL_ENTITY && forced !== null;

        if (i.aimAt) {
          // Bots aim at a world point rather than accumulating deltas, so their
          // look is frame-rate-free by construction.
          const dx = i.aimAt.x - s.position.x;
          const dy = i.aimAt.y - (s.position.y + s.eyeHeight);
          const dz = i.aimAt.z - s.position.z;
          const flat = Math.hypot(dx, dz);
          s.yaw = Math.atan2(-dx, -dz);
          s.pitch = clamp(Math.atan2(dy, Math.max(1e-4, flat)), -MAX_PITCH, MAX_PITCH);
        } else {
          // `lookYaw`/`lookPitch` are already SIGNED radians for this tick with
          // sensitivity and invert applied, so they are added, never subtracted.
          s.yaw += i.lookYaw;
          s.pitch = clamp(s.pitch + i.lookPitch, -MAX_PITCH, MAX_PITCH);
        }

        if (!locked) {
          s.stance =
            (i.buttons & Btn.Prone) !== 0
              ? Stance.Prone
              : (i.buttons & Btn.Crouch) !== 0
                ? Stance.Crouch
                : Stance.Stand;
          // Sprint is forward-only: `moveZ` is +1 for W, so the test is > 0.
          s.sprinting = (i.buttons & Btn.Sprint) !== 0 && s.stance === Stance.Stand && i.moveZ > 0.1;
          s.eyeHeight = EYE_HEIGHT[s.stance];
        }

        const speed = STANCE_SPEED[s.stance] * (s.sprinting ? SPRINT_MULTIPLIER : 1);
        // Producer-normalised to a unit disc, so no diagonal speed bonus here.
        const sin = Math.sin(s.yaw);
        const cos = Math.cos(s.yaw);
        const vx = (i.moveX * cos - i.moveZ * sin) * speed;
        const vz = (-i.moveX * sin - i.moveZ * cos) * speed;
        s.velocity.set(vx, 0, vz);
        s.groundSpeed = Math.hypot(vx, vz);
        s.position.x += vx * ctx.dt;
        s.position.z += vz * ctx.dt;
        // No physics in the null: sit exactly on the analytic macro silhouette,
        // which is the same function TERRAIN, LEVEL, VEG and AI all evaluate.
        s.position.y = MACRO_TERRAIN.height(s.position.x, s.position.z);
        s.grounded = true;

        s.stamina = clamp(s.stamina + (s.sprinting ? -0.14 : 0.22) * ctx.dt, 0, 1);
        s.lean = ((i.buttons & Btn.LeanRight) !== 0 ? 1 : 0) - ((i.buttons & Btn.LeanLeft) !== 0 ? 1 : 0);
      }
    },
  };
  return service;
}

/**
 * Null conquest mode with plausible live state: tickets on the clock, ALPHA
 * captured, BRAVO contested, CHARLIE hostile. HUD can be built and reviewed
 * against this before GAME lands a single line.
 */
export function createNullGameMode(): GameMode {
  const points = nullCapturePoints();
  /** Team-keyed counts. Neutral is always 0 — nobody holds tickets for nobody. */
  const byTeam = (coalition: number, insurgent: number): Readonly<Record<Team, number>> => ({
    [Team.Coalition]: coalition,
    [Team.Insurgent]: insurgent,
    [Team.Neutral]: 0,
  });
  const runtime: readonly Readonly<CapturePointRuntime>[] = [
    { id: 'ALPHA', state: CaptureState.OwnedCoalition, owner: Team.Coalition, progress: 1, contested: false, occupants: byTeam(2, 0) },
    { id: 'BRAVO', state: CaptureState.Contested, owner: Team.Neutral, progress: 0.35, contested: true, occupants: byTeam(2, 3) },
    { id: 'CHARLIE', state: CaptureState.OwnedInsurgent, owner: Team.Insurgent, progress: -1, contested: false, occupants: byTeam(0, 1) },
  ];
  /** Both the seed and the ticket bar's denominator, so they cannot disagree. */
  const TICKETS_MAX = 450;
  const state: MatchState = {
    phase: MatchPhase.Live,
    timeRemaining: 742,
    tickets: byTeam(418, 371),
    ticketsMax: TICKETS_MAX,
    points: runtime,
    winner: null,
    localTeam: Team.Coalition,
    localScore: { kills: 7, deaths: 4, assists: 3, captures: 1, score: 2140 },
    scores: new Map(),
  };
  const mutable = state as { -readonly [K in keyof MatchState]: MatchState[K] };
  return {
    id: 'conquest(null)',
    state,
    requestSpawn(_entity, choice): Readonly<SpawnPointDef> | null {
      const spawns = nullSpawnPoints();
      if (choice.kind === 'point') {
        return spawns.find((s) => s.linkedPoint === choice.point) ?? spawns[0];
      }
      return spawns[0];
    },
    teamOf: () => Team.Coalition,
    nameOf: (e) => `BOT-${((e as number) % 97).toString().padStart(2, '0')}`,
    forceState(forced): void {
      if (forced === 'preround') mutable.phase = MatchPhase.Warmup;
      else if (forced === 'endgame') mutable.phase = MatchPhase.Ended;
      else mutable.phase = MatchPhase.Live;
    },
    reset(): void {
      mutable.phase = MatchPhase.Live;
      mutable.tickets = byTeam(418, 371);
      mutable.timeRemaining = 742;
    },
  };
}

/** Referenced by the AI stub so the enum import is not tree-shaken away. */
export const NULL_BOT_BEHAVIOUR = BotBehaviour.Idle;
/** Referenced by the VFX stub for the decal kind it would emit day 0. */
export const NULL_DECAL_KIND = DecalKind.None;
/** Referenced by the quality-tier fallback path in the debug overlay. */
export const NULL_TIER = QualityTier.High;
export { ZERO as NULL_VEC3 };
