/**
 * IRONSIGHT — THE CONTRACT LAYER.
 * =============================================================================
 *
 * This is the seam between every subsystem in the project. Sixteen lanes are
 * built in parallel against this file and against nothing else that they do not
 * own. If you find yourself importing another lane's implementation module, the
 * contract is wrong: fix the contract, say so in your report, and keep going.
 *
 * RULES
 *  1. Types, interfaces, enums and frozen data tables only. No behaviour. A
 *     merge conflict here can never produce a runtime bug — only a textual one.
 *  2. Each section has ONE named amender (see the banner). Only that lane may
 *     append to it, only additively, and they must say so in their report.
 *  3. Never widen or repurpose another lane's interface. Add a new member.
 *  4. Everything is SI and photometric: metres, seconds, kilograms, joules,
 *     lux, candela, radians (degrees only where a field name says `Deg`).
 *
 * Verified: compiles clean under the project tsconfig (strict, isolatedModules,
 * noImplicitOverride) against three@0.185 and @dimforge/rapier3d-compat@0.19.
 *
 * See docs/ARCHITECTURE.md for the design this expresses and docs/OWNERSHIP.md
 * for who owns which files.
 */

import type * as THREE from 'three';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { HarnessDriver, ShotContext } from '@/engine/harness';

/* =============================================================================
 * SECTION 0 — PRIMITIVES                                      amender: CORE
 * ========================================================================== */

/**
 * Canonical vector/matrix aliases. We deliberately use the three.js classes
 * rather than plain `{x,y,z}` records: every lane already imports three, the
 * classes carry the maths we would otherwise reimplement, and rapier's `Vector`
 * accepts a THREE.Vector3 structurally. One vector type, no conversion layer.
 */
export type Vec2 = THREE.Vector2;
export type Vec3 = THREE.Vector3;
export type Quat = THREE.Quaternion;
export type Mat4 = THREE.Matrix4;
export type Box3 = THREE.Box3;
export type Color = THREE.Color;

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/**
 * Generational entity handle: index in the low 20 bits, generation in the high
 * 12. A stale id therefore fails `EntityStore.alive()` rather than silently
 * aliasing a recycled slot.
 */
export type EntityId = Brand<number, 'EntityId'>;

/** Opaque handles. Always integers, always allocated by the owning service. */
export type BodyHandle = Brand<number, 'BodyHandle'>;
export type LightHandle = Brand<number, 'LightHandle'>;
export type DecalHandle = Brand<number, 'DecalHandle'>;
export type VfxHandle = Brand<number, 'VfxHandle'>;
export type SoundHandle = Brand<number, 'SoundHandle'>;
export type StaticHandle = Brand<number, 'StaticHandle'>;
/** A per-frame-moving object registered with `SceneGraph.addDynamic`. */
export type DynamicHandle = Brand<number, 'DynamicHandle'>;
export type ExclusionHandle = Brand<number, 'ExclusionHandle'>;

/**
 * Phantom-typed asset key. `assets.get(MAT_SANDSTONE)` infers its payload with
 * no cast. Construct one with `AssetRegistry.define()`, never by hand.
 */
export interface AssetKey<T> {
  readonly id: string;
  readonly kind: AssetKind;
  /** Phantom only — never present at runtime. */
  readonly __payload?: (t: T) => void;
}

/**
 * An asset key with its payload type erased, for positions that only need the
 * key's IDENTITY — dependency lists, cache invalidation, debug tables.
 *
 * The phantom above is a function *parameter*, which makes `AssetKey<T>`
 * contravariant in `T`: `AssetKey<WeaponModel>` is therefore NOT assignable to
 * `AssetKey<unknown>`, and a `dependsOn: readonly AssetKey<unknown>[]` rejects
 * every concrete key anyone actually has. `never` is the bottom type, so it is
 * assignable *from* every payload and is the correct erasure here.
 */
export type AnyAssetKey = AssetKey<never>;

/** Simulation constants. Shared by every lane; changing these is a CORE call. */
export const Sim = {
  /**
   * 60 Hz. Chosen so a harness shot using the default dt of 1/60 produces
   * exactly one tick per `stepFrame()` and `alpha` lands on 0 — which is what
   * makes captures bit-comparable across machines.
   */
  TICK_HZ: 60,
  TICK_DT: 1 / 60,
  /** Catch-up ceiling after a stall. Beyond this we drop time rather than spiral. */
  MAX_CATCHUP_TICKS: 5,
  /** Any real frame longer than this is clamped before it reaches the accumulator. */
  MAX_FRAME_DT: 0.25,
  /** Gravity, m/s². Physics, ballistics and debris all read this one number. */
  GRAVITY: 9.81,
  /** Speed of sound at 25 °C, m/s. Drives supersonic crack timing and audio delay. */
  SPEED_OF_SOUND: 346,
} as const;

/** Named easing curves. Implemented once in CORE's math module. */
export type EaseId =
  | 'linear'
  | 'inQuad'
  | 'outQuad'
  | 'inOutQuad'
  | 'outCubic'
  | 'inOutCubic'
  | 'outExpo'
  | 'outBack'
  | 'outElastic';

/**
 * ONE live uniform cell. Structurally three's `IUniform`, and the single shape
 * used by `MaterialSpec.uniforms`, `GpuBakeDesc.uniforms` and
 * `RenderGraph.fullscreen` — a lane learns it once.
 *
 * The DECLARER owns the cell and mutates `.value` (or goes through
 * `MaterialFactory.setUniform`, which also reaches the depth/shadow/velocity
 * variants). A consumer never swaps the object out: the shader holds the
 * reference it was given at compile time.
 */
export interface GpuUniform<T = unknown> {
  value: T;
}

/** Critically-damped-ish spring. `damping` < 1 overshoots, and that IS the feel. */
export interface SpringParams {
  /** rad/s² (or m/s²) per unit of displacement. */
  readonly stiffness: number;
  /** 1.0 = critical. Weapon kick lives around 0.55–0.8. */
  readonly damping: number;
  readonly mass: number;
}

/* =============================================================================
 * SECTION 1 — DETERMINISM: RNG + CLOCK                        amender: CORE
 * ========================================================================== */

/**
 * The ONLY source of randomness in the repo (PCG32). `Math.random()` is a
 * review defect and CI greps for it. `fork(label)` derives an independent
 * stream by hashing the label into the seed, so a lane that adds or removes a
 * draw can never shift another lane's sequence — which is the difference
 * between reproducible screenshots and chasing ghosts.
 *
 * Implemented by CORE (`src/engine/rng.ts`).
 */
export interface Rng {
  readonly label: string;
  readonly seed: number;
  /** Uniform [0, 1). */
  next(): number;
  int(maxExclusive: number): number;
  range(min: number, max: number): number;
  bool(probability: number): boolean;
  sign(): number;
  pick<T>(items: readonly T[]): T;
  /** Mean 0, stddev 1. */
  gaussian(): number;
  unitVec3(out: Vec3): Vec3;
  /** Uniform direction inside a cone of half-angle `halfAngleRad` about `axis`. */
  cone(axis: Vec3, halfAngleRad: number, out: Vec3): Vec3;
  /**
   * Deterministic child stream. The same label always yields the same sequence.
   *
   * FORKS ARE MEMOISED BY LABEL AND `reseed()` PROPAGATES INTO THEM. Forking in
   * a constructor is therefore safe: when the harness reset chain calls
   * `rng.reseed(n)` on the root, every fork is deterministically re-derived from
   * the new seed and rewound. You do not need to re-fork in `reset<Key>`, and
   * you must not cache the numbers you drew from it across a capture.
   */
  fork(label: string): Rng;
  /** Rewinds this stream AND every stream forked from it, recursively. */
  reseed(seed: number): void;
  /** So the harness can rewind one stream between shots without touching others. */
  saveState(): Uint32Array;
  loadState(state: Uint32Array): void;
}

/**
 * Time. `simTime` is derived from the tick count, never from the wall clock —
 * a shot that renders 32 fixed-dt frames must produce the same world state on
 * a workstation and under SwiftShader.
 *
 * Implemented by CORE (`src/engine/clock.ts`).
 */
export interface Clock {
  /** Fixed simulation steps executed since boot. */
  readonly tick: number;
  /** Rendered frames since boot. Also the TAA/blue-noise sequence index. */
  readonly frame: number;
  /** `tick * Sim.TICK_DT`. The only time gameplay may read. */
  readonly simTime: number;
  /** 0..1 between the previous and current tick, for render interpolation. */
  readonly alpha: number;
  /** Real seconds since the last rendered frame, clamped to Sim.MAX_FRAME_DT. */
  readonly frameDt: number;
  readonly fpsEma: number;
  readonly frameMsEma: number;
  /** True while the harness owns the frame: fixed dt, no dynamic resolution. */
  readonly deterministic: boolean;
}

/* =============================================================================
 * SECTION 2 — QUALITY TIERS + GPU CAPABILITIES                amender: CORE
 * ========================================================================== */

export enum QualityTier {
  Low = 0,
  Medium = 1,
  High = 2,
  Ultra = 3,
}

export enum AntiAliasMode {
  None = 'none',
  Fxaa = 'fxaa',
  Taa = 'taa',
}

/** A value that varies per tier. Read this, never `tier` itself, in hot paths. */
export type TierScaled<T> = Readonly<Record<QualityTier, T>>;

export interface ShadowSettings {
  readonly cascadeCount: 2 | 3 | 4;
  /** Square atlas edge in texels. Cascades tile into it. */
  readonly atlasSize: number;
  /** Per-cascade tile edge, coarsest last. Must tile inside `atlasSize`. */
  readonly tileSizes: readonly number[];
  /** Cascade far distances in metres, e.g. [12, 38, 110, 300]. */
  readonly splits: readonly number[];
  readonly maxDistance: number;
  /** Sun angular size in shadow-UV units; drives PCSS penumbra growth. */
  readonly lightSizeUv: number;
  readonly pcssBlockerSamples: number;
  readonly pcssFilterSamples: number;
  /** Frames between refresh, per cascade. [1,1,2,4] amortises the distant ones. */
  readonly updateCadence: readonly number[];
  readonly contactShadowSteps: number;
}

/**
 * Hard per-frame ceilings. `Profiler.checkBudgets()` reports violations and CI
 * treats them as build-breaking — twelve agents each raising their own budget
 * is exactly how you get a 40 ms frame with no single culprit.
 */
export interface BudgetLimits {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly shadowTriangles: number;
  readonly textureBytes: number;
  readonly renderTargetBytes: number;
  readonly shaderPrograms: number;
  readonly gpuMs: number;
  readonly cpuMs: number;
  readonly physicsMs: number;
  readonly aiMs: number;
}

/**
 * What the bake pipeline is allowed to spend. The capture harness runs under a
 * software rasteriser, so `GpuCaps.isSoftware` forces the profile down while
 * KEEPING the render tier high — shots stay beautiful, they just bake coarser.
 */
export interface BakeProfile {
  readonly name: 'compact' | 'standard' | 'full';
  /** Edge length for hero materials (weapons, landmark surfaces). */
  readonly heroTexelSize: number;
  /** Edge length for bulk material array layers. */
  readonly bulkTexelSize: number;
  readonly terrainHeightRes: number;
  readonly erosionIterations: number;
  readonly impostorViews: number;
  readonly impostorAtlasSize: number;
  /** Sum of BakeStep.cost the scheduler may spend before it degrades resolution. */
  readonly unitCeiling: number;
  /** 0 disables workers entirely; jobs then run inline on the main thread. */
  readonly workerCount: number;
  /** GPU→CPU readback is expensive under SwiftShader; some bakes must skip it. */
  readonly allowReadback: boolean;
}

export interface QualitySettings {
  readonly tier: QualityTier;
  readonly baseWidth: number;
  readonly baseHeight: number;
  /** Internal render resolution as a fraction of the canvas. UI is always 1.0. */
  readonly renderScale: number;
  readonly renderScaleRange: readonly [number, number];
  /** Frame-time driven renderScale adjustment. FORCED OFF while capturing. */
  readonly dynamicResolution: boolean;
  readonly aa: AntiAliasMode;
  readonly taaSamples: 4 | 8 | 16;
  /** HDR colour format. Low drops to R11G11B10F to halve bandwidth. */
  readonly hdrFormat: RTFormat.RGBA16F | RTFormat.R11G11B10F;
  readonly shadows: ShadowSettings;
  readonly gtao: {
    readonly enabled: boolean;
    readonly scale: number;
    readonly slices: number;
    readonly stepsPerSlice: number;
    readonly bentNormals: boolean;
  };
  readonly ssr: {
    readonly enabled: boolean;
    readonly scale: number;
    readonly maxSteps: number;
    readonly maxRoughness: number;
    readonly thickness: number;
  };
  readonly volumetrics: {
    readonly enabled: boolean;
    readonly froxels: readonly [number, number, number];
    readonly maxDistance: number;
    readonly marchSteps: number;
  };
  readonly clouds: { readonly enabled: boolean; readonly scale: number; readonly steps: number };
  readonly bloom: { readonly levels: number };
  readonly motionBlur: { readonly enabled: boolean; readonly samples: number; readonly shutterAngleDeg: number };
  readonly dof: { readonly enabled: boolean; readonly adsOnly: boolean };
  readonly terrain: {
    readonly clipmapLevels: number;
    readonly clipmapVerts: number;
    readonly splatSize: number;
  };
  readonly vegetation: {
    readonly densityScale: number;
    readonly grassRadius: number;
    readonly grassInstances: number;
    readonly drawDistance: number;
    readonly shadowDistance: number;
    readonly lodBias: number;
    readonly windDetail: 0 | 1 | 2;
  };
  readonly particles: {
    readonly maxLive: number;
    readonly soft: boolean;
    readonly lit: boolean;
    readonly shadowReceive: boolean;
  };
  readonly decals: { readonly maxLive: number };
  readonly destruction: { readonly maxChunks: number; readonly settleSeconds: number };
  readonly physics: { readonly substeps: number; readonly maxDynamicBodies: number };
  readonly ai: { readonly maxBots: number; readonly perceptionHz: number; readonly pathsPerTick: number };
  readonly audio: { readonly maxVoices: number; readonly reverbQuality: 0 | 1 | 2 };
  readonly maxAnisotropy: number;
  readonly budgets: BudgetLimits;
  readonly bake: BakeProfile;
}

/** Probed once at boot, before anything is allocated. */
export interface GpuCaps {
  readonly vendor: string;
  readonly renderer: string;
  /** SwiftShader / llvmpipe — i.e. we are inside the capture harness. */
  readonly isSoftware: boolean;
  readonly maxTextureSize: number;
  readonly maxArrayLayers: number;
  readonly maxDrawBuffers: number;
  /** EXT_color_buffer_float. Required for EVERY HDR target; see the warning below. */
  readonly colorBufferFloat: boolean;
  readonly floatBlend: boolean;
  readonly timerQuery: boolean;
  readonly maxAnisotropy: number;
  readonly deviceMemoryGb: number;
  readonly estimatedTier: QualityTier;
}

/** Implemented by CORE (`src/engine/quality.ts`). Nobody else writes settings. */
export interface QualityService {
  readonly tier: QualityTier;
  readonly settings: Readonly<QualitySettings>;
  readonly caps: Readonly<GpuCaps>;
  /** Live scale after the dynamic-resolution governor. Pinned to 1 while capturing. */
  readonly renderScale: number;
  setTier(tier: QualityTier): void;
  setDynamicResolution(enabled: boolean): void;
  onChange(fn: (settings: Readonly<QualitySettings>) => void): () => void;
}

/* =============================================================================
 * SECTION 3 — INPUT + INTENT                                  amender: CORE
 * ========================================================================== */

export enum Btn {
  Fire = 1 << 0,
  Ads = 1 << 1,
  Reload = 1 << 2,
  Jump = 1 << 3,
  Crouch = 1 << 4,
  Prone = 1 << 5,
  Sprint = 1 << 6,
  Use = 1 << 7,
  Melee = 1 << 8,
  Grenade = 1 << 9,
  SwapWeapon = 1 << 10,
  LeanLeft = 1 << 11,
  LeanRight = 1 << 12,
  FireMode = 1 << 13,
  Spot = 1 << 14,
  Scoreboard = 1 << 15,
  SpawnMenu = 1 << 16,
}

/**
 * The ONE struct the simulation sees. Humans produce it from devices; bots
 * produce the identical struct from `AiService.intentSource`. Movement, stance,
 * fire control and ballistics therefore have a single code path for both, and
 * a movement bug cannot manifest differently for players and AI.
 *
 * Serialisable by construction, which makes replay determinism tests possible.
 */
export interface PlayerIntent {
  /**
   * YAW-LOCAL ground plane, normalised to a unit disc by the producer:
   * `+moveZ` is forward, `+moveX` is right. Resolved against the entity's yaw
   * AFTER this tick's look input (`lookYaw`, or `aimAt`) has been applied, so a
   * bot that turns and walks in the same tick goes where it is looking.
   * No diagonal speed bonus, ever.
   */
  moveX: number;
  moveZ: number;
  /**
   * Radians accumulated over THIS tick, sensitivity and ADS scale already
   * applied. IGNORED when `aimAt` is non-null.
   */
  lookYaw: number;
  lookPitch: number;
  /** Bitmask of Btn, held state. */
  buttons: number;
  /** Edge flags for this tick only. */
  pressed: number;
  released: number;
  /** -1 = no change. */
  weaponSlot: number;
  /**
   * Bots: absolute world point the brain wants to look at. Null for humans.
   *
   * AUTHORITATIVE. GAME snaps yaw/pitch to it and applies NO rate limit and no
   * smoothing of its own; the PRODUCER owns every bit of aim dynamics, which is
   * where `BotProfile.aimSpring`, reaction latency and the error cone live. Two
   * smoothers in series is a reaction time nobody can find.
   *
   * Valid only for the tick it was sampled in — the producer reuses the vector,
   * so a consumer that needs it later must copy it.
   */
  aimAt: Vec3 | null;
}

export interface IntentSource {
  readonly kind: 'human' | 'bot';
  /** Fill `out` in place. Called exactly once per tick per controlled entity. */
  sample(entity: EntityId, ctx: TickCtx, out: PlayerIntent): void;
}

/** Implemented by CORE (`src/engine/input.ts`). */
export interface InputService {
  readonly source: IntentSource;
  readonly pointerLocked: boolean;
  requestPointerLock(): void;
  sensitivity: number;
  invertY: boolean;
  /** Harness hook: force a synthetic intent for a shot. Null clears the override. */
  setScripted(intent: Partial<PlayerIntent> | null): void;
}

/* =============================================================================
 * SECTION 4 — EVENTS                                          amender: CORE
 * ========================================================================== */

export enum HitZone {
  None = -1,
  Head = 0,
  Torso = 1,
  Stomach = 2,
  Arm = 3,
  Leg = 4,
}

export enum DamageKind {
  Bullet = 0,
  Explosion = 1,
  Melee = 2,
  Fall = 3,
  Fire = 4,
  Crush = 5,
}

export enum Team {
  Coalition = 0,
  Insurgent = 1,
  Neutral = 2,
}

export interface DamageInfo {
  readonly target: EntityId;
  readonly attacker: EntityId;
  readonly amount: number;
  readonly kind: DamageKind;
  readonly zone: HitZone;
  readonly point: Vec3;
  readonly normal: Vec3;
  /** Unit vector attacker → target. Drives the directional damage indicator. */
  readonly direction: Vec3;
  readonly surface: SurfaceId;
  readonly weapon: WeaponId | null;
  /** Residual kinetic energy, joules. Destruction and ragdoll impulse read it. */
  readonly energyJ: number;
  readonly penetrated: boolean;
}

/**
 * SIMULATION events. Emitted and drained INSIDE the tick, insertion-ordered.
 * Handlers may mutate simulation state. Presentation code MUST NOT subscribe —
 * that one-way rule is what keeps captures deterministic.
 */
export interface SimEventMap {
  'entity.spawned': { entity: EntityId; archetype: string; team: Team; position: Vec3 };
  'entity.destroyed': { entity: EntityId };
  'damage.applied': DamageInfo;
  'entity.killed': { victim: EntityId; killer: EntityId; weapon: WeaponId | null; headshot: boolean };
  'weapon.fired': { shooter: EntityId; weapon: WeaponId; shotIndex: number; ammoLeft: number };
  'weapon.reloadStart': { shooter: EntityId; weapon: WeaponId; empty: boolean };
  'weapon.reloadEnd': { shooter: EntityId; weapon: WeaponId };
  'weapon.dryFire': { shooter: EntityId; weapon: WeaponId };
  'projectile.impact': ImpactEvent;
  'prop.damaged': { entity: EntityId; healthFraction: number; info: DamageInfo };
  'prop.destroyed': { entity: EntityId; result: DestructionResult };
  'noise.emitted': NoiseEvent;
  'objective.progress': { point: CapturePointId; team: Team; progress: number; contested: boolean };
  'objective.captured': { point: CapturePointId; team: Team };
  'objective.neutralised': { point: CapturePointId; from: Team };
  'match.phase': { phase: MatchPhase };
  'match.end': { winner: Team | null; tickets: Readonly<Record<Team, number>> };
  'nav.dirty': { min: Vec3; max: Vec3 };
}

/**
 * PRESENTATION events. Emitted during the tick through a write-only
 * `FxEmitter`, drained once per RENDER frame. VFX, audio and HUD subscribe
 * here and nowhere else, so a bullet impact produces a decal, a particle burst,
 * a sound and a hitmarker from four modules that have never heard of each other.
 */
export interface FxEventMap {
  impact: ImpactEvent;
  decal: DecalRequest;
  tracer: { from: Vec3; to: Vec3; weapon: WeaponId; travelTime: number; visible: boolean };
  whizby: { point: Vec3; missDistance: number; supersonic: boolean };
  muzzleFlash: { entity: EntityId; weapon: WeaponId; muzzle: Vec3; direction: Vec3; intensity: number };
  shellEject: { position: Vec3; velocity: Vec3; weapon: WeaponId };
  explosion: { point: Vec3; radius: number; energyJ: number; source: EntityId };
  debrisBurst: { point: Vec3; normal: Vec3; surface: SurfaceId; count: number };
  footstep: { entity: EntityId; position: Vec3; surface: SurfaceId; running: boolean };
  waterSplash: { point: Vec3; energyJ: number };
  cameraShake: { trauma: number; frequencyHz: number };
  hitmarker: { lethal: boolean; headshot: boolean; armour: boolean };
  damageTaken: { direction: Vec3; amount: number };
  killfeed: KillFeedEntry;
  banner: { text: string; sub: string; tone: 'friendly' | 'hostile' | 'neutral' };
  ammoState: { weapon: WeaponId; ammo: number; reserve: number; mode: FireMode };
  sound: { cue: SoundId; position: Vec3 | null; desc?: SoundEmitDesc };
}

/**
 * Deferred, insertion-ordered bus. `emit` queues, `flush` dispatches in emit
 * order. Re-entrant emits are appended and drained in the same flush, so global
 * ordering is preserved and a handler can safely cascade.
 *
 * Implemented by CORE (`src/engine/events.ts`).
 */
export interface EventBus<M> {
  emit<K extends keyof M>(type: K, payload: M[K]): void;
  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void;
  once<K extends keyof M>(type: K, fn: (payload: M[K]) => void): () => void;
  flush(): void;
  clear(): void;
  readonly pending: number;
}

/** Write-only view of the presentation bus handed to simulation code. */
export interface FxEmitter {
  emit<K extends keyof FxEventMap>(type: K, payload: FxEventMap[K]): void;
}

export type SimBus = EventBus<SimEventMap>;
export type FxBus = EventBus<FxEventMap>;

/** Anything that makes a noise the AI can hear. Loudness is dB SPL at 1 m. */
export interface NoiseEvent {
  readonly position: Vec3;
  readonly loudnessDb: number;
  readonly team: Team;
  readonly source: EntityId;
  readonly kind: 'gunshot' | 'footstep' | 'explosion' | 'reload' | 'impact' | 'collapse';
}

/* =============================================================================
 * SECTION 5 — ENTITIES + COMPONENTS                           amender: CORE
 * ========================================================================== */

export const NULL_ENTITY = 0 as EntityId;

/** A component type. Declare shared ones in CORE's `components.ts`. */
export interface ComponentDef<T> {
  readonly name: string;
  readonly create: () => T;
}

/**
 * Dense component storage with STABLE CREATION ORDER iteration. Deterministic
 * by construction: never iterate a Map or Set keyed by object identity anywhere
 * in gameplay code, or two runs of the same shot will diverge.
 */
export interface ComponentStore<T> {
  readonly def: ComponentDef<T>;
  readonly size: number;
  has(e: EntityId): boolean;
  get(e: EntityId): T | undefined;
  /** Throws when absent. Use where the archetype guarantees presence. */
  req(e: EntityId): T;
  add(e: EntityId, init?: Partial<T>): T;
  remove(e: EntityId): void;
  /** Safe to mutate components during iteration; unsafe to create/destroy entities. */
  each(fn: (value: T, e: EntityId) => void): void;
  readonly dense: readonly T[];
  readonly entities: readonly EntityId[];
}

/**
 * The entity world. Deliberately minimal: gameplay lanes (GAME, AI, WEAPONS,
 * PHYS) use it; rendering and bake lanes never touch it. Implemented by CORE
 * (`src/engine/entities.ts`).
 */
export interface EntityStore {
  create(archetype?: string): EntityId;
  /** Deferred — the entity survives until TickPhase.Cleanup of the current tick. */
  destroy(e: EntityId): void;
  alive(e: EntityId): boolean;
  store<T>(def: ComponentDef<T>): ComponentStore<T>;
  /** Entities holding every listed component, in creation order. */
  query(defs: readonly ComponentDef<unknown>[], fn: (e: EntityId) => void): void;
  readonly count: number;
  /** The local player, or NULL_ENTITY before deploy. */
  localPlayer: EntityId;
}

/**
 * Interpolated transform. Simulation writes ONLY `curr`; the render side lerps
 * `prev`→`curr` by `FrameCtx.alpha`. `prevRender` is last FRAME's world matrix
 * and is what the velocity buffer is computed from — see the motion-vector
 * contract on `MaterialFactory.registerDeform`.
 */
export interface TransformComponent {
  prev: Vec3;
  curr: Vec3;
  prevRot: Quat;
  currRot: Quat;
  scale: number;
}

/* =============================================================================
 * SECTION 6 — FRAME LIFECYCLE: CONTEXTS, PHASES, SYSTEMS      amender: CORE
 * ========================================================================== */

/**
 * Fixed-tick ordering. Numerically gapped so a lane can slot a phase in without
 * renumbering. Two systems in the same phase MUST be order-independent of each
 * other — that is the rule that lets sixteen agents write updaters without
 * negotiating.
 */
export enum TickPhase {
  Input = 0,
  /** Human + bot intent production. Nothing else may write PlayerIntent. */
  Intent = 100,
  /** Bot brains: perception, utility scoring, path selection. Reads last tick. */
  Ai = 200,
  /** Locomotion: intent → desired velocity → CharacterController.move(). */
  Movement = 300,
  PrePhysics = 400,
  /** EXACTLY ONE rapier `world.step()` lives here. Calling it elsewhere is a defect. */
  Physics = 500,
  /** Dynamic-body transform readback, contact drain. */
  PostPhysics = 600,
  /** Weapon state machines, trigger, reload, aimPunch integration. */
  Weapons = 700,
  /** Projectile integration + CCD sweeps. Runs after weapons so a shot flies same-tick. */
  Ballistics = 750,
  Damage = 800,
  Destruction = 850,
  /** Capture progress, ticket bleed, spawn logic, scoring. */
  Mode = 900,
  /** Deferred entity destruction, pool recycling. */
  Cleanup = 1000,
}

/**
 * Variable-rate render ordering. Runs once per rendered frame, after zero or
 * more ticks. Nothing here may mutate simulation state.
 */
export enum RenderStage {
  /** Drain the FxEventMap queue. */
  Sample = 0,
  /** CameraRig composes THE camera transform. It is the only writer. */
  Camera = 100,
  /** Viewmodel rig, ragdoll blend, wind phase, skinning — anything that moves a vertex. */
  Animation = 200,
  /** Particle sim, decal aging, tracer advance, HUD layout. */
  Presentation = 300,
  /** Terrain LOD, instancing, culling, prevMatrixWorld capture. */
  Scene = 400,
  /** RenderGraph.execute(). */
  Submit = 500,
}

/**
 * Handed to every TickSystem. `dt` is ALWAYS `Sim.TICK_DT` — a tick that reads
 * frame rate is a bug. There is no camera here, and `fx` is write-only.
 */
export interface TickCtx {
  readonly tick: number;
  readonly dt: number;
  /** `tick * Sim.TICK_DT`. Never wall-clock. */
  readonly time: number;
  readonly entities: EntityStore;
  readonly sim: SimBus;
  readonly fx: FxEmitter;
  readonly rng: Rng;
  readonly services: Services;
  readonly quality: Readonly<QualitySettings>;
  readonly deterministic: boolean;
}

/**
 * Handed to every RenderSystem and RenderPass. Has NO simulation bus, by
 * design: presentation can never talk back into the simulation.
 */
export interface FrameCtx {
  readonly frame: number;
  /** Real elapsed seconds for this frame, clamped. Cosmetic springs use this. */
  readonly dt: number;
  /** 0..1 between the previous and current tick, for transform interpolation. */
  readonly alpha: number;
  /** Simulation time of the CURRENT tick. Shader time uniforms derive from this. */
  readonly time: number;
  readonly entities: EntityStore;
  readonly fx: FxBus;
  readonly rng: Rng;
  readonly quality: Readonly<QualitySettings>;
  readonly camera: Readonly<CameraState>;
  readonly services: Services;
  readonly profiler: Profiler;
  /** True while the harness is driving: no dynamic res, exposure frozen. */
  readonly deterministic: boolean;
}

/** Fixed-rate simulation system. Registered by its lane's factory. */
export interface TickSystem {
  readonly name: string;
  readonly phase: TickPhase;
  readonly order?: number;
  tick(ctx: TickCtx): void;
}

/** Variable-rate presentation system. */
export interface RenderSystem {
  readonly name: string;
  readonly stage: RenderStage;
  readonly order?: number;
  update(ctx: FrameCtx): void;
}

/* =============================================================================
 * SECTION 7 — SERVICES, BOOT, SUBSYSTEM DESCRIPTORS           amender: CORE
 * ========================================================================== */

/**
 * The service registry. Typed fields rather than string lookups, so a missing
 * dependency is a compile error and not a runtime `undefined`.
 *
 * CORE constructs every entry in dependency order. Any service not yet provided
 * resolves to its NULL implementation in `src/bootstrap/nulls.ts`, so a lane can
 * boot the whole engine with 21 nulls and one real service and still take a
 * screenshot. That is what makes sixteen parallel lanes possible.
 */
export interface Services {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly quality: QualityService;
  readonly profiler: Profiler;
  readonly input: InputService;
  readonly events: SimBus;
  readonly fx: FxBus;
  readonly entities: EntityStore;
  readonly scene: SceneGraph;

  readonly assets: AssetRegistry;
  readonly materials: MaterialFactory;

  readonly renderer: RenderService;
  readonly graph: RenderGraph;
  readonly camera: CameraRig;
  readonly lighting: LightingService;

  readonly sky: SkyService;
  readonly terrain: TerrainService;
  readonly water: WaterService;
  readonly vegetation: VegetationService;
  readonly level: LevelService;

  readonly physics: PhysicsService;
  readonly destruction: DestructionService;

  readonly weapons: WeaponService;
  readonly ballistics: BallisticsService;
  readonly viewmodel: ViewmodelRig;

  readonly vfx: VfxService;
  readonly audio: AudioService;
  readonly hud: HudService;

  readonly nav: NavService;
  readonly ai: AiService;
  readonly player: PlayerService;
  readonly mode: GameMode;
  readonly debug: DebugService;
}

export type ServiceKey = keyof Services;

export interface ServiceRegistry {
  get<K extends ServiceKey>(key: K): Services[K];
  /** Null-object aware: returns undefined only if the key was never registered. */
  tryGet<K extends ServiceKey>(key: K): Services[K] | undefined;
  provide<K extends ServiceKey>(key: K, impl: Services[K]): void;
  /** True when `key` still resolves to its null implementation. */
  isNull(key: ServiceKey): boolean;
  readonly all: Services;
}

/** Everything a subsystem factory is given at construction time. */
export interface BootContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly registry: ServiceRegistry;
  readonly services: Services;
  readonly quality: QualityService;
  readonly assets: AssetRegistry;
  readonly rng: Rng;
  /** Register a fixed-rate system. Returns an unregister function. */
  addTick(system: TickSystem): () => void;
  /** Register a variable-rate system. Returns an unregister function. */
  addRender(system: RenderSystem): () => void;
  /**
   * Run `fn` after EVERY subsystem is constructed and BEFORE
   * `RenderGraph.validate()`. Callbacks fire in descriptor construction order.
   *
   * THIS IS WHERE YOU CALL `services.graph.addPass(...)`, and it is the answer
   * to a whole class of silent failure. `SubsystemDescriptor.dependsOn` declares
   * only what your factory reads WHILE IT RUNS, `src/bootstrap/subsystems.ts` is
   * frozen so you cannot add an edge, and a lane that registers a pass against
   * an unconstructed `graph` gets the NULL graph: `addPass` returns normally,
   * the pass never runs, nothing throws, and the shot is black.
   *
   * Registering after boot instead is equally wrong — `validate()` has already
   * run, so a pass that reads an unwritten resource is no longer caught.
   *
   *     ctx.afterBoot((s) => { s.graph.addPass(new MyPass()); });
   */
  afterBoot(fn: (services: Services) => void): void;
  /** Progress text surfaced through the harness `setStatus`. */
  report(status: string): void;
}

/**
 * A lane's ENTIRE plug-in surface. `src/bootstrap/subsystems.ts` holds exactly
 * one descriptor per lane, is written by CORE on day 0, and is NEVER EDITED
 * AGAIN. A lane changes only the body of the file its `create` points at.
 *
 * THE THREE NAMED EXPORTS
 * -----------------------
 * A frozen table cannot grow a hook later, so every descriptor is wired to
 * THREE named exports of its lane's entry file on day 0, all of them present as
 * no-ops from the start:
 *
 *     export function create<Key>Service(ctx: BootContext): <Key>Service
 *     export function register<Key>Bakes(assets, quality): void
 *     export function reset<Key>(seed: number): void
 *
 * `register…Bakes` and `reset…` are free functions, not methods, because
 * `registerBakes` runs BEFORE `create` (bake steps must be declared before
 * `bakeAll` begins) and `reset` must work whether or not `create` ever ran. A
 * lane that needs its instance in either hook keeps it in a module-scoped
 * variable that `create` assigns — the standard pattern, and the reason the
 * entry file is one module per lane.
 */
export interface SubsystemDescriptor<K extends ServiceKey = ServiceKey> {
  readonly key: K;
  /** Boot order is a topological sort over this. Cycles throw at boot. */
  readonly dependsOn: readonly ServiceKey[];
  /**
   * Declare bake steps BEFORE any baking begins. Never bake in here, and never
   * touch a service: this runs after `assets` and before EVERY other subsystem
   * is constructed, which is the only point at which the scheduler can see the
   * whole cost total and apply `BakeProfile.unitCeiling` by degrading
   * resolution instead of discovering it is over budget half way through.
   */
  registerBakes?(assets: AssetRegistry, quality: Readonly<QualitySettings>): void;
  create(ctx: BootContext): Services[K] | Promise<Services[K]>;
  /**
   * Called by the HarnessDriver at the top of EVERY capture, after the RNG is
   * reseeded and before `ShotSpec.setup`. Drop all transient state: decals,
   * debris, projectiles, particles, temporal histories, bot positions. A lane
   * that skips this makes screenshots depend on capture ORDER.
   */
  reset?(seed: number): void;
}

/**
 * The engine object CORE hands to the locked harness via `attachDriver`.
 * Implemented by CORE (`src/engine/driver.ts`).
 */
export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly services: Services;
  readonly registry: ServiceRegistry;
  readonly driver: HarnessDriver;
  readonly shotContext: ShotContext;
  stepFrame(dt: number): void;
  setLoopSuspended(suspended: boolean): void;
}

/* =============================================================================
 * SECTION 8 — PROFILING + DEBUG                               amender: CORE
 * ========================================================================== */

export interface FrameStats {
  readonly cpuMs: number;
  readonly gpuMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programs: number;
  readonly textureBytes: number;
  readonly renderTargetBytes: number;
  readonly passMs: Readonly<Record<string, number>>;
  readonly systemMs: Readonly<Record<string, number>>;
}

export interface Profiler {
  begin(label: string): void;
  end(label: string): void;
  scope<T>(label: string, fn: () => T): T;
  gpuBegin(label: string): void;
  gpuEnd(label: string): void;
  readonly frame: Readonly<FrameStats>;
  /** One string per violated BudgetLimits entry. Empty array = within budget. */
  checkBudgets(): readonly string[];
}

/** Stripped from the production build. Never rely on it for gameplay. */
export interface DebugService {
  readonly enabled: boolean;
  line(from: Vec3, to: Vec3, colour: number, ttlSeconds?: number): void;
  sphere(centre: Vec3, radius: number, colour: number, ttlSeconds?: number): void;
  box(min: Vec3, max: Vec3, colour: number, ttlSeconds?: number): void;
  text(key: string, value: string | number): void;
}

/* =============================================================================
 * SECTION 9 — PROCEDURAL BAKE + ASSET REGISTRY                amender: BAKE
 * ========================================================================== */

export enum AssetKind {
  Texture = 'texture',
  TextureArray = 'texture-array',
  Texture3D = 'texture-3d',
  Cubemap = 'cubemap',
  Material = 'material',
  Mesh = 'mesh',
  Audio = 'audio',
  Lut = 'lut',
  Font = 'font',
  Nav = 'nav',
  Data = 'data',
}

export enum BakeKind {
  /** Fullscreen fragment shader into a render target. The fast path. */
  GpuTexture = 'gpu-texture',
  /** Typed-array producer, dispatched to the worker pool when one exists. */
  WorkerMesh = 'worker-mesh',
  WorkerData = 'worker-data',
  WorkerAudio = 'worker-audio',
  /** Must run on the main thread (needs the GL context or three objects). */
  MainThread = 'main-thread',
}

/**
 * State of the IndexedDB bake cache after the most recent open/read/write
 * attempt. `ok` and `recovered-corrupt` are the only states a warm hit can
 * come from; every other state means this bake ran (or degraded to) cold.
 */
export type BakeCacheStatus =
  | 'disabled'
  | 'ok'
  | 'unavailable'
  | 'private-mode'
  | 'quota-exceeded'
  | 'recovered-corrupt';

/** How mips are generated. The wrong mode is a visible defect at distance. */
export enum MipMode {
  /** Plain box filter in the texture's own colour space. */
  Color = 'color',
  /** Renormalises after each level so distant normals do not shorten. */
  Normal = 'normal',
  /**
   * Folds normal-map variance into roughness (Toksvig). WITHOUT THIS, distant
   * metal, glass and micro-detailed stucco sparkle and no amount of TAA fixes it.
   */
  RoughnessToksvig = 'roughness-toksvig',
  Mask = 'mask',
  None = 'none',
}

export interface GpuBakeDesc {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** >1 makes it a Data3DTexture bake. */
  readonly depth?: number;
  readonly format?: RTFormat;
  readonly colorSpace?: 'srgb' | 'linear';
  /**
   * GLSL3 fragment BODY — the contents of `main()`, not a whole shader.
   * `precision highp float` is set; `in vec2 vUv`, `uniform vec2 uResolution`,
   * `uniform int uPass` and `uniform float uSeed` are in scope; every chunk from
   * `NoiseLib.glsl` is already prepended. Write `outColor` (or `outColor0..N-1`
   * when `targets` > 1).
   *
   * A body cannot declare anything at global scope, so helper functions,
   * structs and the uniforms you pass in `uniforms` go in `prelude`.
   *
   * `RenderGraph.fullscreen` compiles against the IDENTICAL protocol, minus the
   * NoiseLib chunks. One protocol, two devices, no guessing.
   */
  readonly fragment: string;
  /**
   * Global-scope GLSL inserted after the NoiseLib chunks and before
   * `void main()`: helper functions (GLSL ES 3.0 forbids nested definitions),
   * structs, `#define`s, and THE UNIFORM DECLARATIONS FOR `uniforms`.
   */
  readonly prelude?: string;
  /**
   * Uniform values. The DEVICE DOES NOT DECLARE THESE FOR YOU — it never
   * inspects a runtime value to guess a GLSL type, because `{ value: 0 }` is
   * ambiguous between `int` and `float` and the wrong guess is a link error at
   * bake time. Declare each one in `prelude`.
   */
  readonly uniforms?: Record<string, GpuUniform>;
  readonly defines?: Record<string, string | number>;
  /** MRT attachment count. */
  readonly targets?: number;
  readonly wrap?: 'repeat' | 'clamp';
  readonly filter?: 'nearest' | 'linear';
  readonly mips?: MipMode;
  readonly anisotropy?: number;
}

/** GPU texture synthesis. Implemented by BAKE (`src/bake/gpu-device.ts`). */
export interface GpuBakeDevice {
  render(desc: GpuBakeDesc): THREE.Texture;
  /** MRT variant; returns one texture per attachment. */
  renderMrt(desc: GpuBakeDesc): THREE.Texture[];
  /** Ping-pong a shader over its own output: erosion, flow, blur, jump-flood. */
  iterate(desc: GpuBakeDesc, iterations: number, prevUniform?: string): THREE.Texture;
  renderToLayer(target: THREE.DataArrayTexture, layer: number, desc: GpuBakeDesc): void;
  renderToVolume(target: THREE.Data3DTexture, desc: GpuBakeDesc): void;
  /** N octahedral views of `source` into an impostor atlas pair. */
  renderImpostor(
    source: THREE.Object3D,
    views: number,
    atlasSize: number,
  ): { albedo: THREE.Texture; normalDepth: THREE.Texture; radius: number };
  /** Budgeted and slow. Rejected (resolves empty) when `allowReadback` is false. */
  readback(texture: THREE.Texture, out?: Float32Array): Promise<Float32Array>;
  buildMips(texture: THREE.Texture, mode: MipMode): void;
  /** Bytes held by bake-owned GPU textures. Checked against BudgetLimits. */
  readonly bytesResident: number;
}

/**
 * Off-main-thread CPU work. `run` MUST fall back to inline execution when
 * `BakeProfile.workerCount` is 0 or worker construction fails, so no lane is
 * ever blocked on workers being available.
 */
export interface WorkerPool {
  readonly size: number;
  run<TIn, TOut>(job: string, payload: TIn, transfer?: Transferable[]): Promise<TOut>;
  map<TIn, TOut>(job: string, payloads: readonly TIn[]): Promise<TOut[]>;
}

/**
 * CPU noise plus THE MATCHING GLSL. Terrain height sampled on the CPU (physics,
 * nav, scatter) and displaced on the GPU must agree exactly, so both come from
 * here and share a permutation table. Forking these is a correctness defect —
 * the symptom is players floating over bumps and sinking into dips.
 */
export interface NoiseLib {
  value2(x: number, y: number, seed: number): number;
  simplex2(x: number, y: number, seed: number): number;
  simplex3(x: number, y: number, z: number, seed: number): number;
  fbm2(x: number, y: number, octaves: number, lacunarity: number, gain: number, seed: number): number;
  ridged2(x: number, y: number, octaves: number, seed: number): number;
  worley2(x: number, y: number, seed: number): { f1: number; f2: number; cell: number };
  curl3(x: number, y: number, z: number, seed: number, out: Vec3): Vec3;
  /** Registered `#include` chunks, identical maths to the CPU functions above. */
  readonly glsl: Readonly<
    Record<
      | 'hash'
      | 'value'
      | 'simplex'
      | 'worley'
      | 'fbm'
      | 'ridged'
      | 'curl'
      | 'warp'
      | 'gabor'
      | 'triplanar'
      | 'stochastic'
      | 'detail'
      | 'wear'
      | 'packing'
      | 'colorspace',
      string
    >
  >;
}

export interface BakeRunContext {
  readonly quality: Readonly<QualitySettings>;
  readonly profile: Readonly<BakeProfile>;
  readonly rng: Rng;
  readonly gpu: GpuBakeDevice;
  readonly workers: WorkerPool;
  readonly noise: NoiseLib;
  readonly renderer: THREE.WebGLRenderer;
  /** Offline context, so audio synthesis works headless with no user gesture. */
  readonly audioCtx: OfflineAudioContext;
  /** Result of a DECLARED dependency. Throws if `key` is not in `dependsOn`. */
  require<T>(key: AssetKey<T>): T;
  /** The resolution the scheduler granted after applying the unit ceiling. */
  grantedTexelSize(requested: number): number;
  progress(fraction01: number, label?: string): void;
  /**
   * MUST be awaited between expensive steps. Yields to the browser so the page
   * stays alive and so we finish inside the harness' 300 s ready timeout, which
   * under SwiftShader is the binding constraint on the entire project.
   */
  yieldFrame(): Promise<void>;
}

export interface BakeStep<T = unknown> {
  readonly key: AssetKey<T>;
  readonly kind: BakeKind;
  /** Bump to invalidate the IndexedDB cache entry. */
  readonly version: number;
  readonly dependsOn?: readonly AnyAssetKey[];
  /**
   * Relative cost in bake units. When Σcost exceeds `BakeProfile.unitCeiling`
   * the scheduler DEGRADES RESOLUTION on the lowest-priority steps rather than
   * dropping them — a missing material is a defect, a 256² material is softer.
   */
  readonly cost: number;
  /** Lowest tier at which this asset is baked at all. */
  readonly minTier?: QualityTier;
  readonly cacheable?: boolean;
  run(ctx: BakeRunContext): T | Promise<T>;
  dispose?(value: T): void;
}

export interface BakeProgress {
  readonly fraction: number;
  readonly phase: string;
  readonly stepId: string;
  readonly elapsedMs: number;
}

export interface BakeStats {
  readonly totalMs: number;
  readonly perStepMs: Readonly<Record<string, number>>;
  readonly textureBytes: number;
  readonly geometryBytes: number;
  readonly audioBytes: number;
  readonly cacheHits: number;
  /** Steps whose resolution was reduced to fit the unit ceiling. */
  readonly degraded: readonly string[];
  /** IndexedDB open/read/write health as of this bake. See `BakeCacheStatus`. */
  readonly cacheStatus: BakeCacheStatus;
  /** Cacheable jobs that ran (or reran) because no usable entry was found. */
  readonly cacheMisses: number;
  /** Total ms spent in IndexedDB `get()` lookups that resolved as hits. */
  readonly cacheHitMs: number;
  /** Total ms spent in IndexedDB `get()` lookups that resolved as misses. */
  readonly cacheMissMs: number;
  /**
   * Total ms actually spent recomputing + persisting cacheable jobs on a
   * miss — the honest "what a cold bake costs" number. A warm bake's
   * equivalent cost is `cacheHitMs`, which is orders of magnitude smaller.
   */
  readonly cacheRecomputeMs: number;
  /** Writes that aborted (typically `QuotaExceededError`). Never fatal. */
  readonly cachePutFailures: number;
}

/**
 * Every byte of art in this game comes out of here. Implemented by BAKE
 * (`src/bake/registry.ts`). Steps are resolved in topological dependency order.
 */
export interface AssetRegistry {
  /** Declare an asset. Returns the phantom-typed key to hand around. */
  define<T>(id: string, kind: AssetKind, step: Omit<BakeStep<T>, 'key'>): AssetKey<T>;
  has<T>(key: AssetKey<T>): boolean;
  /** Throws if the asset was never defined or its bake has not run. */
  get<T>(key: AssetKey<T>): T;
  tryGet<T>(key: AssetKey<T>): T | undefined;
  bakeAll(onProgress: (p: BakeProgress) => void): Promise<void>;
  readonly stats: Readonly<BakeStats>;
  readonly gpu: GpuBakeDevice;
  readonly workers: WorkerPool;
  readonly noise: NoiseLib;
}

/**
 * The canonical baked PBR texture set. Two samplers per material, channel
 * packed — a third sampler per material is the difference between 90 and 60 fps.
 *
 *   albedoHeight  RGBA8 sRGB    rgb = base colour, a = height (POM / blend)
 *   normalRoughAo RGBA8 linear  rg  = tangent normal xy, b = roughness, a = AO/cavity
 *
 * PARTICIPATING MEDIA (smoke, dust, spray) and cut-out cards have no height, so
 * they carry OPACITY in `albedoHeight.a` instead and declare
 * `MaterialFeature.AlphaFromHeight`. That is a public convention with a feature
 * bit, not a private one: without the bit, `ParallaxOcclusion` would read the
 * same channel as displacement. There is deliberately no third sampler — a
 * third sampler per material is the difference between 90 and 60 fps.
 */
export interface TextureSet {
  readonly albedoHeight: THREE.Texture;
  readonly normalRoughAo: THREE.Texture;
  /** Curvature/AO/height-driven wear, grime and edge chipping. Drives layer blends. */
  readonly wear?: THREE.Texture;
  readonly emissive?: THREE.Texture;
  /** World metres covered by one UV repeat. */
  readonly tiling: number;
  readonly metalness: number;
}

/** A baked mesh. LOD 0 first; every LOD shares the UV layout and material slots. */
export interface MeshAsset {
  readonly lods: readonly THREE.BufferGeometry[];
  /** Projected radius in pixels below which each LOD is selected, coarsest last. */
  readonly screenErrors: readonly number[];
  /** Convex hulls or primitives for rapier. NEVER the render geometry. */
  readonly collision: readonly ColliderShape[];
  readonly bounds: Box3;
  readonly surface: SurfaceId;
}

export interface AudioAsset {
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
  /** Peak-normalised reference so cue authors work in dB, not guesswork. */
  readonly peak: number;
}

export interface BakedFont {
  readonly atlas: THREE.Texture;
  readonly glyphs: ReadonlyMap<
    number,
    Readonly<{
      u0: number;
      v0: number;
      u1: number;
      v1: number;
      advance: number;
      bearingX: number;
      bearingY: number;
      width: number;
      height: number;
    }>
  >;
  readonly lineHeight: number;
  readonly ascender: number;
  readonly descender: number;
  /** SDF spread in texels; the text shader needs it for the screen-space derivative. */
  readonly distanceRange: number;
}

/**
 * The baked PBR material library, keyed by `SurfaceId`.
 *
 * A `TextureSet` is a live `WebGLTexture` pair and therefore cannot travel
 * through a string lookup or an event; the consumer needs the object. RCORE's
 * `MaterialFactory.textures()` is the read path for world surfaces, and this is
 * where the sets it hands out come from.
 *
 * `get` returns undefined for a surface BAKE has no recipe for — that is the
 * normal case for the long tail of `SurfaceId` (rope, flesh, glass), and the
 * caller falls back to its analytic profile rather than showing a black square.
 */
export interface MaterialLibrary {
  /** Surfaces a set was baked for, ascending. */
  readonly surfaces: readonly SurfaceId[];
  get(id: SurfaceId): TextureSet | undefined;
  /** The texel edge actually granted after the unit ceiling degraded the bake. */
  readonly texelSize: number;
}

/**
 * WELL-KNOWN ASSETS, defined by BAKE on every boot.
 *
 * `AssetRegistry.define` returns the key, which is fine for a lane that both
 * declares and consumes an asset — but BAKE's own products (the material
 * library, the HUD font, the BRDF LUT) are consumed by lanes that cannot import
 * `src/bake/**` and cannot define them a second time. An `AssetKey` is inert
 * data (`{ id, kind }`), so publishing the identities here is the whole seam:
 * BAKE defines them, anyone reads them with `assets.get(BakeAssets.font)`, and
 * no cross-lane import exists in either direction.
 *
 * `AssetRegistry.tryGet` is the safe read — every one of these is skipped on the
 * lowest tier or when the bake degraded past it.
 */
export const BakeAssets = Object.freeze({
  /** Every baked `TextureSet`, keyed by `SurfaceId`. */
  materials: { id: 'bake.materials', kind: AssetKind.Material } as AssetKey<MaterialLibrary>,
  /**
   * The HUD typeface: an SDF atlas baked from code-defined glyph outlines.
   * Single channel (`RedFormat`), signed distance, 0.5 on the glyph edge.
   */
  font: { id: 'bake.font', kind: AssetKind.Font } as AssetKey<BakedFont>,
  /** Split-sum GGX environment BRDF. rg = (scale, bias) on F0. */
  brdfLut: { id: 'bake.lut.brdf', kind: AssetKind.Lut } as AssetKey<THREE.Texture>,
  /** Spatiotemporal void-and-cluster blue noise, R8, one slice per z. */
  blueNoise: { id: 'bake.noise.blue', kind: AssetKind.Texture3D } as AssetKey<THREE.Texture>,
});

/* =============================================================================
 * SECTION 10 — SURFACES + MATERIALS                           amender: RCORE
 * ========================================================================== */

/**
 * The shared surface vocabulary. One enum read by ballistics (penetration),
 * VFX (impact burst + decal), audio (impact + footstep cue), AI (noise) and
 * physics (friction). Adding one means adding a row to the SurfaceProfile table.
 */
export enum SurfaceId {
  Sandstone = 0,
  Stucco = 1,
  Concrete = 2,
  Rubble = 3,
  Plaster = 4,
  Tile = 5,
  Sand = 6,
  WetSand = 7,
  Dirt = 8,
  Gravel = 9,
  Cobble = 10,
  Wood = 11,
  PaintedWood = 12,
  PaintedMetal = 13,
  RustedMetal = 14,
  BareMetal = 15,
  Grating = 16,
  Glass = 17,
  Fabric = 18,
  Tarp = 19,
  Sandbag = 20,
  Rope = 21,
  Rubber = 22,
  Water = 23,
  Foliage = 24,
  Bark = 25,
  Flesh = 26,
  Kevlar = 27,
}

/**
 * Everything the rest of the game needs to know about a surface WITHOUT asking
 * the renderer for a shader. Frozen table owned by RCORE
 * (`src/render/material/surfaces.ts`).
 */
export interface SurfaceProfile {
  readonly id: SurfaceId;
  readonly name: string;
  /** kg/m³. With thickness this gives areal density for penetration. */
  readonly density: number;
  /** Joules absorbed per centimetre of penetration. */
  readonly penetrationResistance: number;
  /** 0..1 Mohs-ish. Drives spark generation and impact brightness. */
  readonly hardness: number;
  /** Fraction of incoming energy retained on a shallow ricochet. */
  readonly ricochetRestitution: number;
  /** Impacts shallower than this (degrees from the surface) may ricochet. */
  readonly ricochetAngleDeg: number;
  readonly friction: number;
  readonly restitution: number;
  readonly impactCue: SoundId;
  readonly footstepCue: SoundId;
  readonly impactVfx: VfxId;
  readonly decalKind: DecalKind;
  /** dB SPL at 1 m for a rifle impact. AI hearing thresholds use the same unit. */
  readonly impactLoudnessDb: number;
  /** 0 = reflective stone, 1 = dead cloth. Feeds the audio reverb blend. */
  readonly acousticAbsorption: number;
}

/** Shader feature bits. The factory HARD-CAPS the resulting permutation count. */
export enum MaterialFeature {
  None = 0,
  DetailNormal = 1 << 0,
  Triplanar = 1 << 1,
  StochasticTiling = 1 << 2,
  WearMask = 1 << 3,
  ParallaxOcclusion = 1 << 4,
  VertexDeform = 1 << 5,
  AlphaClip = 1 << 6,
  DitherFade = 1 << 7,
  Emissive = 1 << 8,
  Translucency = 1 << 9,
  Wetness = 1 << 10,
  Anisotropic = 1 << 11,
  /**
   * Fragment-stage depth fade against `RTId.SceneDepth`: alpha falls off over
   * `MaterialSpec.softFadeDistance` metres of depth difference, so a smoke card
   * meets the ground as a soft gradient instead of a straight intersection line.
   *
   * Honours `QualitySettings.particles.soft` — a NO-OP (hard-edged, no depth
   * fetch, no cost) when that is false, and a no-op against a graph where
   * `has(RTId.SceneDepth)` is false. Declaring it is therefore always safe.
   */
  SoftParticle = 1 << 12,
  /**
   * `albedoHeight.a` carries OPACITY rather than height — the packing for
   * participating media and cut-out cards. MUTUALLY EXCLUSIVE with
   * `ParallaxOcclusion`, which reads the same channel as displacement;
   * `create()` throws if both bits are set rather than shipping a smoke puff
   * that parallax-shifts.
   */
  AlphaFromHeight = 1 << 13,
}

/**
 * Blend state. `'opaque'` writes colour with blending off; `'alpha'` is the
 * usual `SRC_ALPHA / ONE_MINUS_SRC_ALPHA`; `'premultiplied'` is `ONE /
 * ONE_MINUS_SRC_ALPHA`; `'additive'` is `ONE / ONE` and must be reserved for
 * things that genuinely EMIT — additive smoke is the classic hobby-stack tell.
 */
export type BlendMode = 'opaque' | 'alpha' | 'premultiplied' | 'additive';

/**
 * A vertex-deform chunk, split into three named slots so the injector never has
 * to parse GLSL and four lanes cannot each guess a different calling convention.
 *
 * THE IDENTICAL STRUCT IS INJECTED INTO THE FORWARD, DEPTH-PREPASS, SHADOW AND
 * VELOCITY MATERIALS. That is the whole motion-vector contract (architecture
 * decision #14): shadows, early-Z and motion vectors cannot disagree with the
 * lit pass, because there is only one source of the displacement.
 *
 * Scope available to all three slots: everything three's `<begin_vertex>` has —
 * `position`, `normal`, `uv`, `uv1`, `objectNormal`, `transformed`,
 * `modelMatrix`, `instanceMatrix` where instanced — plus `uTime` (seconds,
 * `FrameCtx.time`), `uPrevTime`, and any uniform declared by the `MaterialSpec`
 * that names this chunk.
 */
export interface DeformChunk {
  /**
   * Uniform declarations, helper functions and structs. Emitted ONCE at global
   * scope, above `main()`. Prefix every symbol with your lane id.
   */
  readonly common: string;
  /**
   * STATEMENTS, injected after `<begin_vertex>`. Must write `transformed`
   * (object space) and should write `objectNormal` — a displaced surface with an
   * undisplaced normal lights as if it never moved.
   */
  readonly displace: string;
  /**
   * A vec3 EXPRESSION (not statements) giving this vertex's object-space
   * position under LAST FRAME's uniforms. Returning `position` here means "this
   * vertex did not move", which writes zero velocity and tells TAA and motion
   * blur to treat it as static. Getting this wrong is invisible in the lit pass
   * and shows up as smearing three lanes away.
   */
  readonly prevPosition: string;
}

/**
 * The fragment counterpart of `DeformChunk` — a lane-authored SURFACE chunk.
 *
 * It runs after the uber material has resolved albedo / normal / roughness and
 * BEFORE lighting, so it inherits CSM sampling, clustered lights, GTAO and
 * in-shader aerial perspective unchanged. That is the difference between water
 * that is lit like everything else in the frame and water that is the one
 * surface lit differently.
 */
export interface SurfaceChunk {
  /** Declarations and helpers, emitted once at global scope. */
  readonly common: string;
  /**
   * STATEMENTS. May write `diffuseColor` (vec4), `material.roughness`,
   * `material.metalness`, `normal` (world space, must stay unit length) and
   * `IRON_EXTRA_RADIANCE` — a vec3 ADDED after shading, which is where
   * refraction composites, SSR composites and emissive rims go.
   *
   * In scope: `vWorldPosition`, `vViewPosition`, `vUv`, `gl_FragCoord`, the
   * spec's uniforms, and `uResolution`. It must not discard — use
   * `MaterialSpec.alphaTest` so the depth prepass agrees with the forward pass.
   */
  readonly shade: string;
}

/**
 * THE canonical vertex layout. `THREE.BatchedMesh` cannot merge geometries with
 * differing layouts, so every lane that emits world geometry emits exactly this:
 *
 *   position vec3 | normal vec3 | tangent vec4 | uv vec2 | uv1 vec2
 *   color vec4 unorm8  (r = wear, g = dirt, b = baked AO, a = variant index)
 */
export interface GeometrySpec {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly tangent: Float32Array;
  readonly uv: Float32Array;
  readonly uv1: Float32Array;
  readonly color: Uint8Array;
  readonly index: Uint32Array;
  /** Per-LOD index ranges into `index`, coarsest last. */
  readonly lods: readonly {
    readonly start: number;
    readonly count: number;
    readonly screenError: number;
  }[];
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
}

export interface MaterialSpec {
  /** Stable id. Materials with the same id + feature mask are deduped. */
  readonly id: string;
  readonly surface: SurfaceId;
  /** Slot in the shared albedo/surface DataArrayTextures, from `allocateLayer`. */
  readonly layer: number;
  readonly features: number;
  readonly baseColor?: THREE.ColorRepresentation;
  /** Per-instance hue/value jitter seed. Breaks up repeated kit pieces. */
  readonly tintSeed?: number;
  readonly roughness?: number;
  readonly metalness?: number;
  /** Dielectric F0, remapped to 0..0.08. */
  readonly specular?: number;
  readonly ior?: number;
  readonly detailScale?: number;
  readonly detailLayer?: number;
  readonly wearBias?: number;
  readonly tilingScale?: number;
  readonly emissive?: THREE.ColorRepresentation;
  readonly emissiveIntensity?: number;
  readonly alphaTest?: number;
  readonly doubleSided?: boolean;
  readonly transparent?: boolean;
  readonly instanced?: boolean;
  /**
   * Defaults to `!transparent`. WATER is the reason this exists: it is blended
   * AND must write depth, or `volume.composite` (pass 15) fogs straight through
   * the sea and every sorted transparent draws in front of it. Typechecks fine
   * either way; shows up as "the fog is broken" three lanes away.
   */
  readonly depthWrite?: boolean;
  /** Defaults to true. */
  readonly depthTest?: boolean;
  /** Defaults to `'alpha'` when `transparent`, `'opaque'` otherwise. */
  readonly blending?: BlendMode;
  /** Metres of depth difference over which a `SoftParticle` fades to zero. Default 0.5. */
  readonly softFadeDistance?: number;
  /** Name of a chunk registered via `registerDeform` — wind, recoil, skinning. */
  readonly deform?: string;
  /** Name of a chunk registered via `registerSurface` — water, decals, holograms. */
  readonly surfaceShader?: string;
  /**
   * LANE-OWNED UNIFORMS, injected into EVERY variant of this material (forward,
   * depth-prepass, shadow, velocity) and into the deform/surface chunks it
   * names. This is how a GPU-driven lane feeds its shader: the particle state
   * texture, the Gerstner wave table, the viewmodel recoil basis, the shore-mask
   * rect.
   *
   * Names MUST be prefixed with the lane's id (`uVfxState`, `uWaterPhase`) —
   * the factory throws on a collision with another spec's name rather than
   * letting two lanes fight over one uniform block slot.
   *
   * The cells are LIVE: mutate `.value` yourself, or call
   * `MaterialFactory.setUniform`, which reaches the variants too and validates
   * the name. Declaring a uniform never creates a shader permutation.
   */
  readonly uniforms?: Readonly<Record<string, GpuUniform>>;
}

/**
 * The escape hatch for UNLIT, non-scene materials the uber material cannot
 * express: HUD text and quads, debug gizmos, the sky dome, raw overlays.
 *
 * NEVER for a world surface — those go through `create()` or they will not
 * receive shadows, clustered lights, GTAO or aerial perspective, and will be the
 * one object in the frame that is lit differently. See §4.2 of the architecture.
 */
export interface UnlitSpec {
  /** Stable id. Materials with the same id are deduped, like `MaterialSpec.id`. */
  readonly id: string;
  /** Whole GLSL3 vertex shader, not a chunk. */
  readonly vertexShader: string;
  /** Whole GLSL3 fragment shader, not a chunk. Writes a declared `out vec4`. */
  readonly fragmentShader: string;
  readonly uniforms: Readonly<Record<string, GpuUniform>>;
  readonly defines?: Readonly<Record<string, string | number>>;
  readonly transparent?: boolean;
  readonly blending?: BlendMode;
  readonly depthTest?: boolean;
  readonly depthWrite?: boolean;
  readonly side?: 'front' | 'back' | 'double';
  /**
   * Apply the tonemap + output-colourspace transform. TRUE for anything drawn
   * into an HDR scene target (the sky dome); FALSE for anything drawn after
   * `post.tonemap` into `LdrColor` (the HUD, debug gizmos) — tonemapping the
   * HUD is the giveaway that a frame came out of a hobby post stack.
   */
  readonly toneMapped?: boolean;
}

/**
 * THE SINGLE PLACE ANY THREE.Material IS CREATED. No lane calls
 * `new THREE.Mesh*Material` — CI greps for it. This is what caps shader
 * permutations, keeps sixteen authors on one lighting model, and guarantees
 * that CSM sampling, GTAO application, clustered lights, aerial perspective and
 * wind animation are injected identically everywhere.
 *
 * Implemented by RCORE (`src/render/material/factory.ts`).
 */
export interface MaterialFactory {
  create(spec: MaterialSpec): THREE.Material;
  /**
   * UNLIT, non-scene material — HUD text, debug gizmos, the sky dome. The only
   * sanctioned way to author a raw shader outside `src/render/`; CI fails the
   * build on `new THREE.ShaderMaterial` in a lane, because the alternative is
   * twelve lanes each deciding for themselves and finding out at integration.
   * Counts against `permutationCap` exactly like `create()`.
   */
  createUnlit(spec: UnlitSpec): THREE.Material;
  /**
   * Set one uniform declared in `MaterialSpec.uniforms` or `UnlitSpec.uniforms`,
   * on `material` AND on its depth / shadow / velocity variants at once.
   * THROWS when the name was not declared, so a typo is a boot-time error and
   * not a silently black frame.
   *
   * Values are latched and re-pushed from `updateGlobals`, so calling this from
   * a `RenderSystem` at `RenderStage.Animation` or `.Presentation` is correct
   * and ordering-safe with respect to submit.
   */
  setUniform(material: THREE.Material, name: string, value: unknown): void;
  /** Read back what was latched. Throws on an undeclared name, like `setUniform`. */
  uniform(material: THREE.Material, name: string): unknown;
  profile(id: SurfaceId): Readonly<SurfaceProfile>;
  /** Cached per surface. Safe to call per prop inside a build loop. */
  textures(id: SurfaceId): TextureSet;
  /** Claim a slot in the shared arrays. Returns the layer index for MaterialSpec. */
  allocateLayer(id: string, albedoHeight: THREE.Texture, normalRoughAo: THREE.Texture): number;
  /**
   * MOTION-VECTOR CONTRACT. Register a vertex-deform chunk; name it from
   * `MaterialSpec.deform`. The identical chunk is injected into the FORWARD,
   * DEPTH-PREPASS, SHADOW and VELOCITY materials, so motion vectors and shadows
   * can never disagree with the lit pass.
   *
   * Any lane that animates a vertex in a shader MUST go through this. Displacing
   * vertices in your own `onBeforeCompile` produces geometry that ghosts and
   * smears, and it will be blamed on TAA rather than on you.
   *
   * The three slots of `DeformChunk` exist so the calling convention is stated
   * rather than guessed — four lanes register deforms (WATER Gerstner, VEG wind,
   * WEAPONS recoil, AI skinning) and a wrong guess is a shader-compile error at
   * boot, which fails the capture for all sixteen lanes at once.
   *
   * Idempotent per name; throws if the same name is registered with a different
   * chunk.
   */
  registerDeform(name: string, chunk: DeformChunk): void;
  /**
   * The FRAGMENT counterpart of `registerDeform`; name it from
   * `MaterialSpec.surfaceShader`. Runs after albedo/normal/roughness are
   * resolved and before lighting, so the surface still receives CSM, clustered
   * lights, GTAO and in-shader aerial perspective.
   *
   * This is what makes water, holograms and stylised decals expressible without
   * `new THREE.ShaderMaterial` — which would compile, pass the boundary grep,
   * and lose every one of those. Counts against `permutationCap` exactly like a
   * feature bit.
   */
  registerSurface(name: string, chunk: SurfaceChunk): void;
  /** Depth-prepass / shadow / velocity variants of a forward material. */
  depthVariant(material: THREE.Material): THREE.Material;
  shadowVariant(material: THREE.Material): THREE.Material;
  velocityVariant(material: THREE.Material): THREE.Material;
  readonly albedoArray: THREE.DataArrayTexture;
  readonly surfaceArray: THREE.DataArrayTexture;
  /**
   * Pushes sun, cascades, LUTs, clusters, wind and exposure into every
   * material, and re-pushes every value latched through `setUniform`. Runs once
   * per frame, before submit.
   */
  updateGlobals(ctx: FrameCtx): void;
  /** Hard-capped. `create()` throws past the cap so nobody smuggles a variant in. */
  readonly permutationCount: number;
  readonly permutationCap: number;
  /** Compiles every permutation against a probe scene before markReady(). */
  prewarm(): Promise<void>;
}

/* =============================================================================
 * SECTION 11 — SCENE GRAPH, CULLING, BATCHING                 amender: CORE
 * ========================================================================== */

export enum SceneGroup {
  Sky = 'sky',
  Terrain = 'terrain',
  Water = 'water',
  Vegetation = 'vegetation',
  Level = 'level',
  Props = 'props',
  Debris = 'debris',
  Characters = 'characters',
  Vfx = 'vfx',
  Decals = 'decals',
  Viewmodel = 'viewmodel',
  Debug = 'debug',
}

/**
 * Draw buckets. The graph submits layers EXPLICITLY, one `render()` call each,
 * and that inter-layer order is the graph's alone. Order WITHIN a layer is
 * three's sort (see note 5 in `engine/renderer.ts`): opaque front-to-back,
 * transparent back-to-front, `renderOrder` overriding both. A lane that needs a
 * blended draw to land over another blended draw in the same layer says so with
 * `Object3D.renderOrder` and nothing else.
 */
export enum RenderLayer {
  /** Opaque world. Prepass + forward. */
  WorldOpaque = 0,
  /** Hashed alpha test — TAA-stable foliage edges. */
  WorldAlphaTest = 1,
  Vegetation = 2,
  Water = 3,
  /** Own near camera; can never clip a wall. */
  Viewmodel = 4,
  /** Sorted forward, before TAA. Smoke, dust, heat haze. */
  TransparentPreTaa = 5,
  /** Forward, AFTER the TAA resolve, before bloom. Tracers, sparks, flash cards. */
  TransparentPostTaa = 6,
  Decals = 7,
  Impostor = 8,
  ShadowOnly = 9,
  /**
   * Screen-space UI. NOT part of the world visible set and never returned by
   * `drawLayer` — the HUD is orthographic and `drawLayer` submits the culled
   * world set through `FrameCtx.camera`, which is perspective. HUD owns a
   * private `THREE.Scene` and an ortho camera and draws them with
   * `RenderGraph.drawScene`; this member exists so its objects carry a layer
   * mask that world passes provably never select.
   */
  Hud = 10,
  /** Same deal as `Hud`: drawn by DebugService through `drawScene`. */
  Debug = 11,
}

export interface StaticRegistration {
  readonly bounds: Box3;
  readonly layer: RenderLayer;
  readonly castsShadow: boolean;
  /** Included in the software occlusion rasteriser's occluder set (max 48). */
  readonly occluder?: boolean;
  readonly lodGroup?: number;
  readonly fadeDistance?: number;
}

/**
 * Scene organisation + deterministic culling. Implemented by CORE
 * (`src/engine/scenegraph.ts`, `culling.ts`, `batching.ts`).
 *
 * Culling is a 32 m sector grid → frustum → a 256×144 software occlusion
 * raster. GPU Hi-Z occlusion readback is REJECTED: it is a frame late and its
 * result varies with GPU timing, which would make shots non-reproducible.
 */
export interface SceneGraph {
  readonly root: THREE.Scene;
  group(name: SceneGroup): THREE.Group;
  addStatic(object: THREE.Object3D, opts: StaticRegistration): StaticHandle;
  removeStatic(handle: StaticHandle): void;
  /**
   * Register an object whose transform or vertices change EVERY FRAME, and put
   * it in `layer`'s visible set so `RenderGraph.drawLayer` draws it. Particle
   * meshes, tracer ribbons, debris, ragdolls, the viewmodel.
   *
   * `addStatic` is the wrong call for these and the failure is quiet: dynamics
   * are skipped by the 32 m sector grid and by the software occlusion raster
   * (both assume a fixed AABB), and they are re-tested against the frustum from
   * `bounds` every frame — or never culled at all when `bounds` is omitted,
   * which is the right answer for anything camera-attached or world-spanning.
   *
   * `bounds` is read once per frame, so a caller with a moving object updates
   * the same Box3 in place rather than re-registering.
   *
   * Parent the object into a `SceneGroup` first — registration decides whether
   * it is CULLED, not whether it is in the scene. The layer mask of the whole
   * subtree is set here, so you do not set it yourself.
   */
  addDynamic(object: THREE.Object3D, layer: RenderLayer, bounds?: Box3): DynamicHandle;
  removeDynamic(handle: DynamicHandle): void;
  /** Merge a set of GeometrySpecs into BatchedMeshes by material cluster. */
  batch(specs: readonly { geometry: GeometrySpec; matrix: Mat4; material: THREE.Material }[]): THREE.Object3D;
  /** Remove one instance from a batch without rebuilding it (destruction). */
  hideBatchInstance(object: THREE.Object3D, instanceId: number): void;
  /** 32 m sector index. VFX and AI use it to partition per-sector budgets. */
  sectorAt(x: number, z: number): number;
  readonly stats: Readonly<{
    sectors: number;
    visible: number;
    culledFrustum: number;
    culledOcclusion: number;
    culledDistance: number;
  }>;
}

/* =============================================================================
 * SECTION 12 — RENDER GRAPH + CAMERA                          amender: RCORE
 * ========================================================================== */

/** Render-target formats. RCORE maps these to GL internal formats. */
export enum RTFormat {
  R8 = 'r8',
  RG8 = 'rg8',
  RGBA8 = 'rgba8',
  RGBA8_SRGB = 'rgba8_srgb',
  RGB10A2 = 'rgb10a2',
  R16F = 'r16f',
  RG16F = 'rg16f',
  RGBA16F = 'rgba16f',
  R11G11B10F = 'r11g11b10f',
  R32F = 'r32f',
  RGBA32F = 'rgba32f',
  Depth24Stencil8 = 'depth24stencil8',
  Depth32F = 'depth32f',
}

/**
 * Well-known graph resources. A lane that needs scene depth looks it up BY NAME
 * and never imports the module that created it. This is the main cross-lane
 * decoupler on the render side.
 */
export enum RTId {
  ShadowAtlas = 'shadow.atlas',
  ShadowFoliage = 'shadow.foliage',
  SpotShadowAtlas = 'shadow.spot',
  SceneDepth = 'scene.depth',
  GNormalRough = 'g.normalRough',
  GVelocity = 'g.velocity',
  HiZ = 'depth.hiz',
  Gtao = 'gtao.result',
  GtaoBentNormal = 'gtao.bentNormal',
  ClusterIndex = 'light.clusterIndex',
  ClusterData = 'light.clusterData',
  SkyTransmittance = 'sky.transmittance',
  SkyMultiScatter = 'sky.multiScatter',
  SkyView = 'sky.view',
  AerialPerspective = 'sky.aerial',
  CloudLayer = 'sky.clouds',
  CloudShadow = 'sky.cloudShadow',
  VolumeScatter = 'volume.scatter',
  VolumeInscatter = 'volume.inscatter',
  SceneColor = 'scene.color',
  SceneColorCopy = 'scene.colorCopy',
  SsrColor = 'ssr.color',
  TaaHistory = 'taa.history',
  ResolvedColor = 'post.resolved',
  VelocityTiles = 'motion.tiles',
  BloomPyramid = 'post.bloom',
  DofResult = 'post.dof',
  Exposure = 'post.exposure',
  LdrColor = 'post.ldr',
}

/**
 * Coarse pass ordering. Passes execute in ascending order; within a slot,
 * `subOrder` then declared read/write dependency. THE CORRECTNESS ORDERING OF
 * THE POST CHAIN IS ENCODED HERE AND IS NOT NEGOTIABLE:
 *   TaaResolve < MotionBlur < Bloom < Tonemap < Hud.
 * Sixteen lanes registering passes in parallel physically cannot get it wrong.
 */
export enum PassOrder {
  SkyLuts = 100,
  ShadowCascades = 150,
  DepthPrepass = 200,
  HiZBuild = 250,
  Gtao = 300,
  LightClusters = 350,
  Volumetrics = 400,
  /**
   * LANE-OWNED GPU SIMULATION: particle state advance, ribbon integration,
   * anything that ping-pongs its own state textures. After `DepthPrepass` so it
   * can read `SceneDepth` (smoke that collides with walls), before
   * `ForwardOpaque` so this frame draws the result it just computed.
   *
   * It exists so a simulating lane does not have to squat in LIGHT's
   * `Volumetrics` slot, which is a collision by construction and defeats the
   * point of the enum.
   */
  Simulate = 420,
  ForwardOpaque = 450,
  Decals = 500,
  /** Sky is drawn at far depth BEFORE SSR so screen-space rays can hit it. */
  SkyRender = 520,
  Ssr = 550,
  ForwardWater = 600,
  VolumetricComposite = 620,
  ForwardTransparent = 650,
  Viewmodel = 680,
  VelocityDilate = 690,
  /** Everything after this point operates on a fully resolved image. */
  TaaResolve = 700,
  /** Tracers, sparks, muzzle-flash cards, lens glints. REGISTERED BY VFX. */
  PostResolveVfx = 730,
  /**
   * Underwater: absorption tint, murk, surface-line distortion. Operates on the
   * resolved HDR image, so it is exposed, bloomed and tonemapped like the rest
   * of the frame instead of being painted on after the grade. After the TAA
   * resolve because the distortion would otherwise fight the history.
   * REGISTERED BY WATER.
   */
  Underwater = 745,
  MotionBlur = 760,
  Exposure = 780,
  Bloom = 800,
  DepthOfField = 830,
  Tonemap = 860,
  LensFx = 880,
  Hud = 900,
  /**
   * Developer readouts drawn over the finished frame: the audio voice table, the
   * frame-graph inspector, physics wireframes. After `Hud` so an overlay is never
   * hidden behind gameplay UI, and after `Tonemap` so its colours are literal
   * rather than graded — a debug readout whose contrast changes with exposure is
   * unreadable exactly when you need it.
   */
  DebugOverlay = 950,
  Present = 1000,
}

/**
 * A render-target declaration.
 *
 * SIZE IS FIXED AT `declare()` TIME. `scale` and `native` re-evaluate on resize,
 * but `size` does not, and no capacity here re-evaluates on a tier change: a
 * `QualityService.onChange` that raises `particles.maxLive` cannot re-declare a
 * state texture. Size a capacity target for the HIGHEST tier the session can
 * reach and index into it, rather than assuming a re-declare path exists.
 */
export interface RTDesc {
  readonly id: RTId | string;
  readonly format: RTFormat;
  /** Fraction of the INTERNAL render resolution. Ignored when `size` is given. */
  readonly scale?: number;
  /**
   * Allocate at NATIVE CANVAS resolution, ignoring `renderScale`. Post-tonemap
   * and UI resources only — `LdrColor` and anything the HUD pass composites
   * over. Mutually exclusive with `scale`.
   */
  readonly native?: boolean;
  /** Absolute size in texels; use for LUTs and atlases. */
  readonly size?: readonly [number, number];
  /** >1 allocates a Data3DTexture / DataArrayTexture target. */
  readonly depthLayers?: number;
  /** MRT attachment count. */
  readonly count?: number;
  readonly depthBuffer?: false | 'buffer' | 'texture';
  readonly depthFormat?: RTFormat.Depth24Stencil8 | RTFormat.Depth32F;
  /** Enables hardware sampler2DShadow PCF on a depth target. */
  readonly depthCompare?: boolean;
  readonly mips?: boolean;
  readonly filter?: 'nearest' | 'linear';
  readonly wrap?: 'clamp' | 'repeat';
  /** Persistent + double-buffered. Fetch with `history()`, not `target()`. */
  readonly history?: boolean;
  readonly clearColor?: readonly [number, number, number, number] | null;
}

/**
 * Double-buffered persistent resource: TAA, SSR, GTAO, clouds, volumetrics,
 * lane-owned simulation state.
 *
 * WHO SWAPS, AND WHEN: **the graph does, once per frame, after the last pass has
 * executed.** A pass therefore reads `previous` and writes `current` and never
 * touches the swap itself — if every owner swapped, a resource read by two
 * passes would flip mid-frame, and if nobody did, the simulation would freeze.
 * Do not cache either target across frames; re-fetch with `history()` each time.
 */
export interface RTHistory {
  readonly current: THREE.WebGLRenderTarget;
  readonly previous: THREE.WebGLRenderTarget;
  /**
   * False on the first frame after a resize, a teleport or a harness reset —
   * i.e. `previous` holds zeroes and must not be blended with. Re-seed your
   * state on the frame this is false.
   */
  readonly valid: boolean;
}

export interface RenderPass {
  readonly id: string;
  readonly order: PassOrder;
  readonly subOrder?: number;
  /** Declared for validation and the debug frame graph. Reading an undeclared
   *  resource throws in dev builds. */
  readonly reads: readonly (RTId | string)[];
  readonly writes: readonly (RTId | string)[];
  /** Estimated ms at 1080p on the reference discrete GPU. Asserted by Profiler. */
  readonly budgetMs: number;
  /**
   * Consulted at `validate()` AND once per frame in `execute()`, so a mid-session
   * tier change takes effect immediately. Must be a pure function of `quality`:
   * a pass that flickers on frame parity breaks `validate()`'s guarantee.
   */
  enabled(quality: Readonly<QualitySettings>): boolean;
  /**
   * Declare your targets here. Runs when the pass is added, which is before the
   * full pass set is known — so `graph.has()` is not yet meaningful; ask that in
   * `execute()`. `quality` is handed in because a target's format is usually
   * tier-dependent (`hdrFormat`) and there is nowhere else to read it.
   */
  setup?(graph: RenderGraph, quality: Readonly<QualitySettings>): void;
  resize?(width: number, height: number): void;
  execute(ctx: FrameCtx, graph: RenderGraph): void;
  dispose?(): void;
}

/** Optional extras for `RenderGraph.fullscreen`. */
export interface FullscreenOpts {
  /**
   * Global-scope GLSL inserted above `main()`: helper functions, structs, and
   * THE UNIFORM DECLARATIONS for everything in `uniforms`. Same rule as
   * `GpuBakeDesc.prelude`.
   */
  readonly prelude?: string;
  /**
   * MRT attachment count, default 1. When > 1 the body writes
   * `outColor0..N-1` and `dest` must be declared with `RTDesc.count` >= N.
   */
  readonly outputs?: number;
  /** Default `'opaque'`. `'alpha'` composites over what `dest` already holds. */
  readonly blend?: BlendMode;
  readonly defines?: Readonly<Record<string, string | number>>;
}

/**
 * THE ONLY CODE THAT MAY TOUCH `renderer.setRenderTarget`, scissor state or
 * autoClear. A lane that needs a custom pass registers it here; it never renders
 * inside its own `update()`. CI greps for `setRenderTarget` outside src/render/.
 *
 * Implemented by RCORE (`src/render/graph.ts`).
 */
export interface RenderGraph {
  readonly renderer: THREE.WebGLRenderer;
  /** Internal render resolution (canvas × renderScale). */
  readonly width: number;
  readonly height: number;
  /**
   * Canvas resolution, IGNORING renderScale. What the HUD pass lays out
   * against (architecture pass 27: native, never renderScale) and what a
   * `RTDesc.native` target is allocated at.
   */
  readonly nativeWidth: number;
  readonly nativeHeight: number;
  /**
   * IDEMPOTENT: declaring an id that already exists with an identical desc is a
   * no-op, so two passes may both declare `SceneDepth` without negotiating.
   * Declaring it with a DIFFERING desc throws at boot.
   */
  declare(desc: RTDesc): void;
  /**
   * True when `id` is declared AND some ENABLED pass writes it — i.e. reading it
   * this frame will give you real data.
   *
   * THE SUPPORTED WAY TO DEGRADE. On Low, `has(RTId.Gtao)` is false and
   * `texture(RTId.Gtao)` throws; soft particles ask `has(RTId.SceneDepth)` and
   * fall back to hard particles. Ask it from `execute()` or after boot: during
   * `RenderPass.setup` the pass set is still incomplete and the answer is a lie.
   */
  has(id: RTId | string): boolean;
  /** Throws if `id` was never declared. Guard with `has()` when degrading. */
  target(id: RTId | string): THREE.WebGLRenderTarget;
  texture(id: RTId | string, attachment?: number): THREE.Texture;
  history(id: RTId | string): RTHistory;
  /**
   * Bind several ALREADY-DECLARED targets as ONE MRT framebuffer for a single
   * pass; attachment order follows `ids`. Depth attachment, scale and clear
   * behaviour are inherited from `ids[0]`, and every id must share its
   * resolution or this throws at boot.
   *
   * This is how a forward pass writes colour AND velocity in one draw — pass 14,
   * water. Drawing twice instead costs the vertex work twice and lets the two
   * draws disagree, which looks exactly like a TAA bug.
   */
  mrtTarget(ids: readonly (RTId | string)[]): THREE.WebGLRenderTarget;
  /**
   * Register a pass. Call this from `BootContext.afterBoot`, not from your
   * factory body: `graph` may not be constructed yet when your factory runs, and
   * the null graph accepts passes silently. Registering after boot skips
   * `validate()`.
   */
  addPass(pass: RenderPass): void;
  removePass(id: string): void;
  /**
   * Fullscreen triangle. `dest` null = the default framebuffer.
   *
   * SHADER PROTOCOL — IDENTICAL TO `GpuBakeDesc.fragment`, minus the NoiseLib
   * chunks. `fragment` is the BODY of `main()`, not a whole shader: GLSL3,
   * `precision highp float`, with `in vec2 vUv` and `uniform vec2 uResolution`
   * already in scope, writing `outColor` — or `outColor0..N-1` when
   * `opts.outputs` > 1, which is how you write both halves of a state pair in
   * one pass instead of two.
   *
   * A body cannot declare anything at global scope, so helper functions and the
   * uniform declarations for `uniforms` go in `opts.prelude`. Nothing is
   * inferred from a runtime value's type.
   *
   * `key` caches the compiled program: reuse it across frames, and make it
   * unique per distinct `fragment` or you will get the first shader forever.
   */
  fullscreen(
    key: string,
    fragment: string,
    uniforms: Record<string, GpuUniform>,
    dest: THREE.WebGLRenderTarget | null,
    opts?: Readonly<FullscreenOpts>,
  ): void;
  blit(src: THREE.Texture, dest: THREE.WebGLRenderTarget | null): void;
  /**
   * Draw one RenderLayer's visible set with an optional material override.
   *
   * **COMPOSITES — it clears neither colour nor depth.** `SceneColor` is bound
   * by six passes in a frame and its depth buffer carries the opaque scene, so a
   * lane drawing its layer into it (water over the world, decals into it) adds
   * to what is already there and depth-tests against it. A lane that owns a
   * private target owns the decision to clear it too.
   */
  drawLayer(
    ctx: FrameCtx,
    layer: RenderLayer,
    dest: THREE.WebGLRenderTarget | null,
    override?: THREE.Material | null,
  ): void;
  /**
   * Draw a LANE-OWNED object tree with a LANE-OWNED camera into `dest`.
   *
   * The only way to render an orthographic screen-space overlay — the HUD, debug
   * gizmos, a minimap — because `drawLayer` submits the culled WORLD set through
   * `FrameCtx.camera`, which is perspective and frustum-culled in world space.
   *
   * `clear` defaults to false, so the draw composites over whatever `dest`
   * already holds (the HUD over `LdrColor`). The graph still owns the target
   * binding, the scissor and autoClear, exactly as for every other primitive
   * here: a lane calling `renderer.render()` from inside `execute()` is a §4.2
   * violation even though the CI grep does not catch it.
   */
  drawScene(
    ctx: FrameCtx,
    scene: THREE.Object3D,
    camera: THREE.Camera,
    dest: THREE.WebGLRenderTarget | null,
    clear?: boolean,
  ): void;
  /** Throws at BOOT (never mid-frame) if an enabled pass reads an unwritten resource. */
  validate(): void;
  execute(ctx: FrameCtx): void;
  /** Clears every temporal history: TAA, SSR, GTAO, clouds, volumetrics, exposure. */
  resetHistories(): void;
  readonly passes: readonly string[];
  readonly renderTargetBytes: number;
}

/**
 * The camera as the rest of the engine sees it. `projection` is UNJITTERED and
 * is what velocity, culling and any world-to-screen maths must use; only the
 * actual draw uses `jitteredProjection`.
 */
export interface CameraState {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly fovDeg: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly jitteredProjection: Mat4;
  readonly viewProjection: Mat4;
  readonly inverseViewProjection: Mat4;
  /** Unjittered previous-frame VP. The only correct camera-motion input. */
  readonly prevViewProjection: Mat4;
  /** Halton(2,3) sub-pixel offset in NDC, already folded into `jitteredProjection`. */
  readonly jitter: Vec2;
  /** Auto-exposure result in EV. FROZEN while `deterministic` is true. */
  readonly exposureEv: number;
  readonly world: THREE.PerspectiveCamera;
  /** Separate near camera (0.01–6 m) so hands never clip and never eat world depth. */
  readonly viewmodel: THREE.PerspectiveCamera;
}

/**
 * THE ONLY WRITER OF CAMERA TRANSFORM IN THE PROJECT. Composes, in order:
 * interpolated eye position → sim yaw/pitch → aimPunch → cosmetic cameraKick →
 * sway → bob → lean → trauma shake → ADS FOV blend → TAA jitter.
 *
 * Implemented by RCORE (`src/render/camera-rig.ts`).
 */
export interface CameraRig {
  readonly state: Readonly<CameraState>;
  update(ctx: FrameCtx): Readonly<CameraState>;
  addTrauma(amount: number, frequencyHz?: number): void;
  /** Harness override: pose absolutely and freeze ALL procedural motion. */
  poseAbsolute(position: Vec3, target: Vec3, fovDeg?: number): void;
  setPoseLocked(locked: boolean): void;
  worldToScreen(world: Vec3, out: Vec2): boolean;
}

/** The renderer-facing facade a lane uses when it is not registering a pass. */
export interface RenderService {
  readonly renderer: THREE.WebGLRenderer;
  readonly graph: RenderGraph;
  readonly camera: CameraRig;
  /** Set by ShotContext.setOverlays. */
  overlays: { viewmodel: boolean; hud: boolean };
  /** Sky/time-of-day changed: re-prefilter the environment cubemap and probes. */
  requestEnvironmentRebake(reason: string): void;
  readonly stats: Readonly<FrameStats>;
}

/* =============================================================================
 * SECTION 13 — LIGHTING                                       amender: LIGHT
 * ========================================================================== */

export enum LightType {
  Point = 0,
  Spot = 1,
}

/**
 * A clustered punctual light. These are NOT `THREE.PointLight`s — adding a real
 * three light recompiles every program in the scene, which is a guaranteed hitch
 * every time a bot opens fire. They live in a cluster texture instead.
 */
export interface LocalLight {
  readonly type: LightType;
  position: Vec3;
  /** Linear Rec.709, unit luminance. */
  color: Color;
  /** Luminous intensity in candela. A rifle muzzle flash is ~6e5 cd for ~35 ms. */
  intensityCd: number;
  radius: number;
  direction?: Vec3;
  innerConeCos?: number;
  outerConeCos?: number;
  castShadow?: boolean;
  /** Contributes to the volumetric froxel injection. */
  volumetric?: boolean;
}

export interface SunState {
  /** Unit vector pointing FROM the surface TOWARD the sun. */
  readonly direction: Vec3;
  readonly color: Color;
  /** Illuminance on a surface normal to the sun, lux. Golden hour ≈ 12k–25k. */
  readonly illuminanceLux: number;
  /** Sun disc angular radius, radians (~0.00465 for the real sun). */
  readonly angularRadius: number;
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
}

/** Implemented by LIGHT (`src/render/lighting/service.ts`). */
export interface LightingService {
  readonly sun: Readonly<SunState>;
  /** 9 RGB SH coefficients (27 floats) of sky + bounce irradiance. */
  readonly ambientSH: Float32Array;
  readonly skyIlluminanceLux: number;
  readonly cascadeMatrices: Float32Array;
  readonly cascadeSplits: Float32Array;
  /** GGX-prefiltered environment for IBL and the SSR miss fallback. */
  readonly environment: THREE.Texture;
  addLight(light: LocalLight): LightHandle;
  updateLight(handle: LightHandle, patch: Partial<LocalLight>): void;
  removeLight(handle: LightHandle): void;
  /**
   * Pooled, auto-expiring world flash. Safe to call from every shot of every
   * bot: the pool caps by tier and drops the dimmest/farthest when saturated.
   */
  flash(position: Vec3, color: Color, intensityCd: number, radius: number, seconds: number): void;
  readonly maxLocalLights: number;
  readonly activeLights: number;
}

/* =============================================================================
 * SECTION 14 — SKY / ATMOSPHERE / WEATHER                     amender: SKY
 * ========================================================================== */

export interface SkyState {
  readonly timeOfDayHours: number;
  /** 0 = clear, 1 = full overcast. */
  readonly overcast: number;
  readonly turbidity: number;
  readonly windSpeed: number;
  readonly windDirectionRad: number;
  readonly rain: number;
  readonly fogDensity: number;
  /** Suspended dust — the thing that makes golden-hour god rays read. */
  readonly dustDensity: number;
  /** Wets surfaces: raises specular, lowers roughness, darkens albedo. */
  readonly wetness: number;
}

/** Implemented by SKY (`src/world/sky/system.ts`). */
export interface SkyService {
  readonly state: Readonly<SkyState>;
  setState(patch: Partial<SkyState>): void;
  setTimeOfDay(hours: number): void;
  setWeather(overcast: number, options?: { wind?: number; rain?: number; fog?: number }): void;
  sunDirection(out: Vec3): Vec3;
  /** Sun disc radiance, already in the renderer's linear working space. */
  sunRadiance(out: Color): Color;
  /** Sky radiance in a direction, cd/m². Used by AI vision and art debugging. */
  radianceTowards(direction: Vec3, out: Color): Color;
  /** True when the LUTs need a rebake this frame (sun moved > 0.15°). */
  readonly dirty: boolean;
}

/* =============================================================================
 * SECTION 15 — TERRAIN / WATER / VEGETATION / LEVEL           amender: TERRAIN
 * ========================================================================== */

/**
 * THE FROZEN MACRO SILHOUETTE OF HARBOUR REACH, owned by CORE in
 * `src/engine/macro.ts` and never changed after day 0.
 *
 * TERRAIN uses it as the base layer under erosion; LEVEL, VEG, WATER and AI use
 * it to place things correctly BEFORE the real eroded heightfield exists.
 * Because both sides evaluate the same function, buildings sit on the ground the
 * first time they are composed, with neither lane reading the other's code.
 */
export interface MacroTerrain {
  readonly seaLevel: number;
  readonly bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>;
  height(x: number, z: number): number;
  /** Metres to the waterline; negative offshore. */
  shoreDistance(x: number, z: number): number;
}

/**
 * Implemented by TERRAIN (`src/world/terrain/system.ts`).
 *
 * INVARIANT: `heightAt` must be LITERALLY the function the terrain vertex
 * shader displaces with. Any shader displacement finer than the collider cell
 * size must be NORMAL-ONLY, or players visibly float over bumps and sink into
 * dips.
 */
export interface TerrainService {
  readonly ready: boolean;
  readonly bounds: Box3;
  readonly seaLevel: number;
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: Vec3): Vec3;
  slopeAt(x: number, z: number): number;
  surfaceAt(x: number, z: number): SurfaceId;
  /** Cheap heightfield march, not a physics query. Returns distance or -1. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, out: Vec3): number;
  readonly collisionHeightfield: Readonly<{ data: Float32Array; size: number; scale: Vec3 }>;
  readonly heightMap: THREE.Texture;
  readonly splatMap: THREE.Texture;
  /**
   * Signed distance to the shoreline. WATER reads this for foam and wave
   * shoaling, VEG for the beach exclusion. R8, decoded through
   * `shoreRangeMetres` — see `mapRect` for the world→UV mapping, and note that a
   * CPU/GPU disagreement here puts the foam band and the wave damping in
   * different places, which reads as a water bug rather than a terrain one.
   */
  readonly shoreMask: THREE.Texture;
  /**
   * HOW TO SAMPLE `heightMap`, `splatMap` AND `shoreMask` FROM A SHADER. All
   * three share this rect and this mapping:
   *
   *     uv = (worldXZ - vec2(minX, minZ)) / vec2(sizeX, sizeZ)
   *
   * A bare `THREE.Texture` with no rect is unsamplable from world space, and
   * every lane would otherwise invent its own constant.
   */
  readonly mapRect: Readonly<{ minX: number; minZ: number; sizeX: number; sizeZ: number }>;
  /**
   * Decode for `shoreMask`, which is unsigned R8 carrying a signed distance:
   *
   *     metres = (texel.r * 2.0 - 1.0) * shoreRangeMetres
   *
   * NEGATIVE OFFSHORE, positive inland — the same sign convention as
   * `MacroTerrain.shoreDistance`, so the CPU and GPU paths agree by
   * construction. Distances beyond ±`shoreRangeMetres` clamp.
   */
  readonly shoreRangeMetres: number;
  /**
   * Coarse (64²) ground albedo over `mapRect`, sRGB-encoded, sea cells carrying
   * the sea's albedo rather than the land's.
   *
   * LOOK_SPEC §2.4 asks the terrain lane for exactly this and it has one
   * consumer: LIGHT integrates it into the LOWER (bounce) SH lobe. Without it
   * every downward-facing surface in the map is lit by a grey constant, upward-
   * and downward-facing shadow read identically, and the frame flattens — and
   * the warm-landward / cool-seaward split the spec calls the map's most
   * valuable composition cannot happen at all, because the bounce lobe would not
   * know the ground is water on one side of the wall.
   *
   * OPTIONAL because `src/bootstrap/nulls.ts` is frozen: a required member could
   * not be added without editing it. Read it with a null check and fall back to
   * a constant ground colour.
   */
  readonly groundAlbedoMap?: THREE.Texture;
}

/** Implemented by WATER (`src/world/water/system.ts`). */
export interface WaterService {
  readonly seaLevel: number;
  /** Displaced sea-surface height at a world point, this frame. */
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: Vec3): Vec3;
  isSubmerged(point: Vec3): boolean;
  /** Ring-wave impulse: bullet splash, debris, explosion. */
  splash(position: Vec3, energyJ: number): void;
  setUnderwater(active: boolean): void;
}

/** Implemented by VEG (`src/world/vegetation/system.ts`). */
export interface VegetationService {
  /** Shared wind so flora, cloth, particles and audio agree on gust phase. */
  windAt(position: Vec3, time: number, out: Vec3): Vec3;
  /** Carve-outs handed over by LEVEL so nothing grows through a wall. */
  addExclusion(centre: Vec3, radius: number): ExclusionHandle;
  removeExclusion(handle: ExclusionHandle): void;
  /** Bend a region: explosions, footfall, prop wash. */
  disturb(position: Vec3, radius: number, strength: number): void;
  /** Flatten + scorch, recovering over `seconds`. */
  scorch(centre: Vec3, radius: number, seconds: number): void;
  /** 0..1 foliage density. AI vision and audio occlusion both read it. */
  densityAt(x: number, z: number): number;
  readonly stats: Readonly<{ grass: number; trees: number; impostors: number; drawCalls: number }>;
}

export type CapturePointId = 'ALPHA' | 'BRAVO' | 'CHARLIE';

export interface CapturePointDef {
  readonly id: CapturePointId;
  readonly label: string;
  readonly centre: Vec3;
  readonly radius: number;
  readonly height: number;
  readonly initialOwner: Team;
}

export interface SpawnPointDef {
  readonly team: Team;
  readonly position: Vec3;
  readonly yaw: number;
  readonly linkedPoint: CapturePointId | null;
}

export interface CoverSlot {
  readonly position: Vec3;
  /** Direction the cover protects AGAINST. */
  readonly facing: Vec3;
  readonly stance: 'prone' | 'crouch' | 'stand';
  /** 0..1 quality score. */
  readonly quality: number;
  /** The destructible that provides it, or NULL_ENTITY for terrain/permanent cover. */
  readonly owner: EntityId;
}

/** Named camera poses shared by every lane's shots, the fly-in and the attract loop. */
export interface CameraRigPose {
  readonly name: string;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fovDeg: number;
}

/** Implemented by LEVEL (`src/level/harbour-reach.ts`). */
export interface LevelService {
  readonly name: string;
  readonly ready: boolean;
  readonly root: THREE.Object3D;
  readonly capturePoints: readonly CapturePointDef[];
  readonly spawnPoints: readonly SpawnPointDef[];
  readonly coverSlots: readonly CoverSlot[];
  readonly playableBounds: Box3;
  /** Static colliders for PHYS. A DELIBERATE second representation, not render geometry. */
  collectColliders(): readonly StaticColliderDef[];
  /** Destructible registrations for PHYS/DESTRUCTION. */
  collectDestructibles(): readonly DestructibleDef[];
  /** Best cover near `position` protecting from `threat`. Null if none in range. */
  findCover(position: Vec3, threat: Vec3, maxRange: number): CoverSlot | null;
  cameraPose(name: string): Readonly<CameraRigPose> | undefined;
  readonly cameraPoseNames: readonly string[];
}

/* =============================================================================
 * SECTION 16 — PHYSICS + DESTRUCTION                          amender: PHYS
 * ========================================================================== */

export enum CollisionGroup {
  Terrain = 1 << 0,
  StaticGeo = 1 << 1,
  Prop = 1 << 2,
  Debris = 1 << 3,
  Character = 1 << 4,
  Vehicle = 1 << 5,
  Projectile = 1 << 6,
  Trigger = 1 << 7,
  Water = 1 << 8,
  /** Blocks nothing, but bullets and footsteps notice it. */
  Foliage = 1 << 9,
  Hitbox = 1 << 10,
  All = 0xffff,
}

export const LAYER_SOLID =
  CollisionGroup.Terrain | CollisionGroup.StaticGeo | CollisionGroup.Prop | CollisionGroup.Debris | CollisionGroup.Vehicle;

export const LAYER_SHOOTABLE = LAYER_SOLID | CollisionGroup.Character | CollisionGroup.Hitbox;

export type ColliderShape =
  | { kind: 'box'; half: Vec3; offset?: Vec3; rotation?: Quat }
  | { kind: 'sphere'; radius: number; offset?: Vec3 }
  | { kind: 'capsule'; halfHeight: number; radius: number; offset?: Vec3 }
  | { kind: 'cylinder'; halfHeight: number; radius: number; offset?: Vec3 }
  | { kind: 'convex'; points: Float32Array; offset?: Vec3 }
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
  | { kind: 'heightfield'; rows: number; cols: number; heights: Float32Array; scale: Vec3 };

/**
 * WHICH DRAWN GEOMETRY IS THIS SOLID, so destruction can take it out of frame.
 *
 * A destructible is authored as a COLLIDER, and a collider is invisible. The
 * thing the player sees is drawn by whichever lane owns the geometry, and that
 * lane is the only one that can say which object — and, if it batched it, which
 * instance of that object — the collider stands behind.
 *
 * `instanceId >= 0` ⇒ one instance of a batched draw, hidden through
 * `SceneGraph.hideBatchInstance`. Omitted or negative ⇒ the whole `object` is
 * the solid and is hidden outright.
 */
export interface DestructibleVisual {
  readonly object: THREE.Object3D;
  readonly instanceId?: number;
}

export interface StaticColliderDef {
  readonly matrix: Mat4;
  readonly shape: ColliderShape;
  readonly surface: SurfaceId;
  readonly group: CollisionGroup;
  /** Present ⇒ this collider is destructible and DESTRUCTION registers it. */
  readonly destructible?: DestructibleDef;
  /**
   * The drawn geometry of the intact solid, forwarded to
   * `DestructionService.attachVisual` / `attachBatchInstance` by
   * `PhysicsService.addStatic` — which is the only place that knows the entity
   * a destructible collider was minted with.
   *
   * A list, not one entry, because one piece of cover is routinely several
   * draws: a sandbag emplacement is forty bags across three materials and
   * therefore three batch instances, all of which have to go at once.
   *
   * ABSENT ⇒ COLLIDER-ONLY. The collider is removed and the sightline opens
   * while the geometry stays standing. That is a bug, not a feature; see
   * `DestructionService.attachVisual`.
   */
  readonly visuals?: readonly DestructibleVisual[];
  readonly occluder?: boolean;
}

/**
 * Authority mode. THIS SINGLE FIELD decides transform-sync direction and is why
 * the player controller and rapier never fight:
 *   'character' → we own velocity, rapier only does collide-and-slide
 *   'dynamic'   → rapier owns the transform, we read it back after step()
 *   'kinematic' → we own the transform, rapier pushes others out of the way
 *   'static' / 'sensor' → never moves / never collides
 */
export type BodyMode = 'static' | 'dynamic' | 'kinematic' | 'character' | 'sensor';

export interface BodyDesc {
  readonly mode: BodyMode;
  readonly entity: EntityId;
  readonly position: Vec3;
  readonly rotation?: Quat;
  readonly shapes: readonly ColliderShape[];
  readonly surface: SurfaceId;
  readonly group: CollisionGroup;
  /** Bitmask of groups this body collides with. */
  readonly collidesWith: number;
  readonly massKg?: number;
  readonly linearDamping?: number;
  readonly angularDamping?: number;
  readonly restitution?: number;
  readonly friction?: number;
  readonly ccd?: boolean;
  /** Debris relies on aggressive sleeping to stay cheap. */
  readonly canSleep?: boolean;
  readonly lifetimeSeconds?: number;
  /**
   * Reported as `RayHit.zone` for every collider of this body. Character rigs
   * create ONE BODY PER ZONE at `CollisionGroup.Hitbox` and set this;
   * everything else omits it and reads back `HitZone.None`.
   *
   * WITHOUT THIS NOTHING IN THE REPO CAN PRODUCE A NON-`None` HIT ZONE, and
   * `BallisticsDef.zoneMultipliers`, `DamageInfo.zone`, the `entity.killed`
   * headshot flag, the hitmarker and the killfeed all silently stop working
   * together. AI owns the rig, so AI is the only lane that can set it.
   */
  readonly zone?: HitZone;
}

export interface RayHit {
  hit: boolean;
  distance: number;
  point: Vec3;
  normal: Vec3;
  surface: SurfaceId;
  body: BodyHandle;
  entity: EntityId;
  /** `BodyDesc.zone` of the body that was hit, or `HitZone.None`. */
  zone: HitZone;
  /** True when the ray EXITED rather than entered — penetration measures wall
   *  thickness by casting backwards from beyond the far face. */
  backface: boolean;
}

export interface QueryFilter {
  /** Bitmask of CollisionGroup values to consider. */
  readonly groups: number;
  readonly excludeEntity?: EntityId;
  readonly excludeBody?: BodyHandle;
  readonly solid?: boolean;
}

export interface CharacterConfig {
  readonly entity: EntityId;
  readonly radius: number;
  readonly standHeight: number;
  readonly crouchHeight: number;
  readonly proneHeight: number;
  readonly position: Vec3;
  /** Skin width. Too small jitters, too large floats. 0.02 m. */
  readonly skinWidth: number;
  readonly maxSlopeDeg: number;
  readonly stepHeight: number;
  readonly snapToGroundDistance: number;
  readonly group: CollisionGroup;
  readonly collidesWith: number;
}

export interface CharacterMoveResult {
  /** The movement rapier actually permitted. Apply THIS, not the desired delta. */
  readonly translation: Vec3;
  readonly grounded: boolean;
  readonly groundNormal: Vec3;
  readonly groundSurface: SurfaceId;
  readonly groundEntity: EntityId;
  readonly hitWall: boolean;
  readonly wallNormal: Vec3;
  /** 1 = moved freely, 0 = fully blocked. Drives slide-along-wall feel. */
  readonly slideRatio: number;
  readonly steppedUp: number;
  readonly ceilingHit: boolean;
}

/**
 * Rapier as a collide-and-slide SERVICE, not a motion authority. The caller
 * integrates acceleration, friction, gravity and air control itself, asks for a
 * desired delta, and applies what comes back. No forces are ever applied to a
 * character body.
 */
export interface CharacterController {
  readonly position: Vec3;
  readonly grounded: boolean;
  readonly groundNormal: Vec3;
  readonly groundSurface: SurfaceId;
  move(desiredDelta: Vec3, dt: number): CharacterMoveResult;
  teleport(position: Vec3): void;
  /** Crouch/prone resize. Returns false when blocked from standing back up. */
  setHeight(height: number): boolean;
  readonly config: Readonly<CharacterConfig>;
  dispose(): void;
}

/**
 * Implemented by PHYS (`src/physics/system.ts`).
 *
 * DETERMINISM WARNING: rapier's solver is deterministic for identical INPUT
 * SEQUENCES but not across differing body-insertion order. Every spawn and
 * despawn must be driven by a stable integer key and a deterministic sort, or
 * two runs of the same shot produce different debris piles.
 */
export interface PhysicsService {
  readonly ready: boolean;
  readonly world: RAPIER.World;
  readonly rapier: typeof RAPIER;
  /** Stepped EXACTLY once per tick at exactly Sim.TICK_DT, from TickPhase.Physics. */
  step(ctx: TickCtx): void;
  createBody(desc: BodyDesc): BodyHandle;
  destroyBody(handle: BodyHandle): void;
  addStatic(def: StaticColliderDef, entity?: EntityId): BodyHandle;
  setKinematicTarget(handle: BodyHandle, position: Vec3, rotation?: Quat): void;
  bodyTransform(handle: BodyHandle, outPos: Vec3, outRot: Quat): boolean;
  applyImpulse(handle: BodyHandle, impulse: Vec3, atPoint?: Vec3): void;
  applyRadialImpulse(centre: Vec3, radius: number, peakNs: number, groups: number): void;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter, out: RayHit): boolean;
  /** Ordered near→far. Drives wall penetration chains. Returns the hit count. */
  raycastAll(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter, out: RayHit[]): number;
  /** Swept sphere: the correct primitive for projectile CCD and grenade travel. */
  sphereCast(origin: Vec3, direction: Vec3, radius: number, maxDistance: number, filter: QueryFilter, out: RayHit): boolean;
  overlapSphere(centre: Vec3, radius: number, filter: QueryFilter, out: EntityId[]): number;
  /** 0..1 line of sight INCLUDING foliage attenuation. AI and audio occlusion use it. */
  visibility(from: Vec3, to: Vec3, groups: number): number;
  createCharacter(config: CharacterConfig): CharacterController;
  entityOf(handle: BodyHandle): EntityId;
  readonly stats: Readonly<{ bodies: number; awake: number; stepMs: number }>;
}

export interface DestructibleDef {
  readonly id: string;
  readonly material: 'concrete' | 'brick' | 'stucco' | 'wood' | 'glass' | 'sandbag' | 'sheetmetal';
  readonly health: number;
  readonly surface: SurfaceId;
  /**
   * Pre-fractured Voronoi shards, generated at BAKE time. Runtime fracture is a
   * frame-hitch generator and is banned.
   *
   * The asset MUST resolve to a `ShardedMeshAsset` — a plain `MeshAsset` carries
   * no `shards` and the collapse spawns NO rubble at all (`chunksSpawned: 0`)
   * while still removing the collider, which reads to a player as broken
   * destruction rather than as subtle destruction.
   */
  readonly chunks: AssetKey<MeshAsset>;
  /**
   * Half-extents of the INTACT solid, when it differs from the size the shard
   * set was baked at.
   *
   * A shard set is shared by hundreds of instances — that sharing is the only
   * reason destruction fits in the asset budget — so one set has to serve a
   * 5 m garden wall and a 1 m sandbag stack. The shards are baked inside the
   * asset's own `bounds`, and this is the box they are re-proportioned into:
   * shard CENTRES scale per axis so the rubble covers the real footprint, shard
   * SHAPES scale uniformly so a wall does not shed wafers.
   *
   * Omitted ⇒ the shard set was baked at this solid's exact size (PHYS's own
   * templates in `destruction/defs.ts`) and nothing is rescaled.
   */
  readonly extent?: Vec3;
  /** Damage below this is cosmetic: a decal and a spall burst, no state change. */
  readonly chipThreshold: number;
  /** Masonry shrugs off bullets and dies to rockets. */
  readonly explosiveMultiplier: number;
  readonly debrisLifetime: number;
  /**
   * After this many seconds asleep, chunks are merged into a static instanced
   * mesh and their bodies freed. LOAD-BEARING, not an optimisation.
   */
  readonly settleAfter: number;
  readonly blocksLosWhenIntact: boolean;
  readonly coverValue: number;
}

export interface DestructionResult {
  readonly destroyed: boolean;
  readonly chunksSpawned: number;
  readonly surface: SurfaceId;
  /** A sightline just opened; AI must re-evaluate its cover graph. */
  readonly coverLost: boolean;
  readonly position: Vec3;
}

/**
 * ONE PRE-FRACTURED PIECE of a destructible solid, produced at BAKE time.
 *
 * Cross-lane because the two halves live in different lanes: LEVEL and PHYS
 * each bake shard sets for the material classes they author, and PHYS's chunk
 * pool is the only thing that ever turns one into a rigid body.
 *
 * `centre` is in the SOURCE SOLID'S LOCAL FRAME and is where the body spawns;
 * `geometry` and `collider` are both centred on it, so the body's origin is its
 * centre of mass and it tumbles about the right axis. `volumeM3` is what gives
 * the shard its MASS, and is why a keystone falls like a keystone and a corner
 * chip skitters.
 */
export interface DestructionShard {
  readonly geometry: THREE.BufferGeometry;
  readonly collider: ColliderShape;
  readonly centre: Vec3;
  readonly volumeM3: number;
}

/**
 * The asset `DestructibleDef.chunks` must resolve to: a `MeshAsset` that also
 * carries its shard set.
 *
 * `AssetKey<T>` is contravariant in `T`, so a key of a subtype cannot be stored
 * in an `AssetKey<MeshAsset>` field. A fracture bake therefore DECLARES
 * `AssetKey<MeshAsset>` and RETURNS this; PHYS narrows on the way out. Every
 * value here is a valid `MeshAsset`, so nothing that only wants the mesh breaks.
 */
export interface ShardedMeshAsset extends MeshAsset {
  readonly shards: readonly DestructionShard[];
}

/** Implemented by PHYS (`src/physics/destruction/system.ts`). */
export interface DestructionService {
  register(entity: EntityId, def: DestructibleDef, body: BodyHandle): void;
  /**
   * HAND DESTRUCTION THE INTACT GEOMETRY so it can take it out of the frame when
   * the solid comes down. `object.visible = false` on collapse, never rebuilt.
   *
   * THE INVARIANT, AND THE BUG IT EXISTS TO PREVENT
   * ----------------------------------------------
   * `register()` gives destruction a collider and a health pool and NOTHING
   * ELSE. A destructible with neither `attachVisual` nor `attachBatchInstance`
   * is COLLIDER-ONLY: on collapse its body is destroyed, its cover is lost, its
   * dust fires and its debris spawns — and its mesh is still standing, solid,
   * in the middle of the sightline that just opened. The player walks through a
   * wall that looks intact and reads the whole feature as broken.
   *
   * That was the shipped behaviour for all ~244 pieces of LEVEL cover, for
   * exactly this reason: the method existed on PHYS's class but not on this
   * interface, so the lane that owned the geometry could not reach it.
   *
   * OPTIONAL ONLY because `src/bootstrap/nulls.ts` is frozen and cannot grow an
   * implementation. Every real destructible should call one of the two.
   */
  attachVisual?(entity: EntityId, object: THREE.Object3D): void;
  /**
   * The batched equivalent, for geometry that is ONE INSTANCE of a shared draw
   * rather than an `Object3D` of its own — which is what any lane that cares
   * about draw-call count emits. Hidden through
   * `SceneGraph.hideBatchInstance(object, instanceId)`, so the batch loses the
   * instance without a geometry rebuild.
   *
   * Call once PER BATCH the destructible contributes to: a piece of cover made
   * of several materials is several instances and all of them have to go
   * together. Calls accumulate; they do not replace each other.
   *
   * The same collider-only invariant as `attachVisual` applies.
   */
  attachBatchInstance?(entity: EntityId, object: THREE.Object3D, instanceId: number): void;
  applyDamage(info: DamageInfo): DestructionResult;
  /** Sub-lethal ballistic chip: geometry survives, decal + spall burst emitted. */
  chip(point: Vec3, normal: Vec3, energyJ: number, surface: SurfaceId): void;
  isIntact(entity: EntityId): boolean;
  healthFraction(entity: EntityId): number;
  /** Called by the HarnessDriver between shots so damage cannot leak across captures. */
  reset(): void;
  readonly stats: Readonly<{ chunksLive: number; chunksSettled: number; budgetUsed01: number }>;
}

/* =============================================================================
 * SECTION 17 — WEAPONS + BALLISTICS                           amender: WEAPONS
 * ========================================================================== */

export type WeaponId = 'ar_service' | 'carbine' | 'dmr_marksman' | 'smg_compact' | 'lmg_support' | 'shotgun' | 'sidearm';

export enum FireMode {
  Safe = 0,
  Semi = 1,
  Burst = 2,
  Auto = 3,
}

export interface DamageCurvePoint {
  readonly distance: number;
  readonly damage: number;
}

export interface SpreadDef {
  /** Cone HALF-angle in degrees. */
  readonly baseHip: number;
  readonly baseAds: number;
  readonly crouchMultiplier: number;
  readonly proneMultiplier: number;
  /** Added per shot, decays at `decay` deg/s once firing stops. */
  readonly perShot: number;
  readonly max: number;
  readonly decay: number;
  /** Additional spread per m/s of horizontal player speed. */
  readonly movementFactor: number;
  readonly airborneMultiplier: number;
}

export interface RecoilPattern {
  /**
   * Authored per-shot aim kick, [pitchDeg, yawDeg]. The index clamps at the end
   * so a sustained burst has a learnable, memorisable shape.
   */
  readonly steps: ReadonlyArray<readonly [pitchDeg: number, yawDeg: number]>;
  /** Jitter on top; small enough that the pattern still dominates. */
  readonly randomPitch: number;
  readonly randomYaw: number;
  readonly recovery: SpringParams;
  readonly recoveryDelay: number;
  /** 0..1 auto-returned; the remainder is drift the player must pull down. */
  readonly recoveredFraction: number;
  readonly adsMultiplier: number;
}

/** COSMETIC feel. None of this ever changes where a bullet goes. */
export interface ViewFeelDef {
  readonly cameraKick: SpringParams;
  /** pitch, yaw, roll — radians. */
  readonly cameraKickImpulse: Vec3;
  readonly weaponKick: SpringParams;
  /** metres, in weapon local space. */
  readonly weaponKickPos: Vec3;
  readonly weaponKickRot: Vec3;
  readonly sway: { gain: Vec3; spring: SpringParams; maxOffset: number; adsScale: number };
  readonly bob: {
    walk: Vec3;
    sprint: Vec3;
    /** Cycles per METRE travelled, so bob stays in step with footfalls. */
    cyclesPerMetre: number;
    landImpulse: number;
    adsScale: number;
  };
  readonly lean: { maxDeg: number; offset: number; speed: number };
  /** Visible only when scoped and stationary. */
  readonly breathe: { amplitude: number; frequencyHz: number; holdScale: number };
  readonly sprintPose: { position: Vec3; rotation: Vec3; blendTime: number };
}

export interface AdsDef {
  readonly time: number;
  readonly curve: EaseId;
  readonly fovMultiplier: number;
  readonly sensitivityMultiplier: number;
  readonly hipOffset: Vec3;
  /**
   * Viewmodel euler (pitch, yaw, roll in radians) at the hip, the counterpart of
   * `adsRotation`. OPTIONAL and defaulting to zero so nothing that already
   * builds an `AdsDef` has to change.
   *
   * Without it a hip-fire weapon points exactly down the camera axis and sits
   * dead-square in the frame, which is the "the viewmodel floats" read on the
   * brief's defect list: a held rifle is always canted a few degrees off the
   * look axis because it is braced against a shoulder that is not on the
   * centreline. Added by WEAPONS.
   */
  readonly hipRotation?: Vec3;
  readonly adsOffset: Vec3;
  readonly adsRotation: Vec3;
  /** >1 switches to the scoped render path. */
  readonly magnification: number;
}

export interface BallisticsDef {
  readonly muzzleVelocity: number;
  readonly massKg: number;
  /** Deceleration = k · v². Authored, not derived from a real BC. */
  readonly dragCoefficient: number;
  readonly gravityScale: number;
  readonly maxRange: number;
  readonly damage: readonly DamageCurvePoint[];
  readonly zoneMultipliers: Readonly<Record<HitZone, number>>;
  /** Joules available for punching through cover. */
  readonly penetrationEnergy: number;
  readonly maxPenetrations: number;
  /** 0 = no tracers, 3 = every third round. */
  readonly tracerEvery: number;
}

export interface WeaponSoundSet {
  readonly fire: SoundId;
  readonly fireDistant: SoundId;
  readonly tail: SoundId;
  readonly dryFire: SoundId;
  readonly magOut: SoundId;
  readonly magIn: SoundId;
  readonly bolt: SoundId;
  readonly ads: SoundId;
}

/**
 * Every feel constant for one weapon, in one frozen object. NO MAGIC NUMBER
 * ESCAPES `src/weapons/defs/`.
 */
export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  readonly class: 'ar' | 'carbine' | 'smg' | 'dmr' | 'lmg' | 'shotgun' | 'pistol';
  readonly fireModes: readonly FireMode[];
  readonly rpm: number;
  readonly burstCount: number;
  readonly magazine: number;
  readonly reserve: number;
  readonly pelletsPerShot: number;
  readonly reloadTactical: number;
  readonly reloadEmpty: number;
  readonly deployTime: number;
  readonly spread: SpreadDef;
  readonly recoil: RecoilPattern;
  readonly view: ViewFeelDef;
  readonly ads: AdsDef;
  readonly ballistics: BallisticsDef;
  readonly mesh: AssetKey<MeshAsset>;
  readonly sounds: WeaponSoundSet;
  readonly muzzle: {
    readonly offset: Vec3;
    readonly flashIntensityCd: number;
    readonly flashRadius: number;
    readonly flashDuration: number;
    readonly smokeRate: number;
  };
  readonly ejection: { readonly offset: Vec3; readonly velocity: Vec3 };
}

/**
 * SIMULATION weapon state. Tick rate. Deterministic. Only WeaponService writes.
 *
 * `aimPunch` is the recoil that ACTUALLY DEFLECTS BULLETS. It is deliberately
 * separate from the cosmetic `WeaponFeelState.cameraKick` so that what the
 * crosshair says and where the bullet goes can never diverge.
 */
export interface WeaponState {
  readonly def: WeaponId;
  readonly ammo: number;
  readonly reserve: number;
  readonly fireMode: FireMode;
  readonly nextFireTick: number;
  readonly reloadEndTick: number;
  readonly lastFireTick: number;
  readonly shotIndex: number;
  readonly burstRemaining: number;
  readonly recoilStep: number;
  readonly reloading: boolean;
  readonly firing: boolean;
  /** 0..1 tick-rate ADS blend. Drives spread and recoil, NOT the camera. */
  readonly adsSim: number;
  readonly adsWanted: boolean;
  /** Radians, added to the aim basis before a bullet direction is computed. */
  readonly aimPunch: Vec3;
  readonly aimPunchVelocity: Vec3;
  readonly currentSpreadDeg: number;
  readonly heat: number;
}

/** RENDER-side feel state. Frame rate. Purely cosmetic. */
export interface WeaponFeelState {
  readonly adsBlend: number;
  readonly sprintBlend: number;
  readonly bobPhase: number;
  /** Viewmodel local offsets: metres and radians. */
  readonly positionOffset: Vec3;
  readonly rotationOffset: Vec3;
  /** Cosmetic camera kick, pitch/yaw/roll radians. Added by CameraRig only. */
  readonly cameraKick: Vec3;
  readonly fovMultiplier: number;
  readonly muzzleWorld: Vec3;
  readonly muzzleDirection: Vec3;
  readonly secondsSinceFire: number;
}

/** Implemented by WEAPONS (`src/weapons/system.ts`). */
export interface WeaponService {
  def(id: WeaponId): Readonly<WeaponDef>;
  readonly all: readonly Readonly<WeaponDef>[];
  stateOf(entity: EntityId): Readonly<WeaponState> | null;
  equip(entity: EntityId, weapon: WeaponId): void;
  /**
   * DIRECT trigger override, for the harness and scripted sequences ONLY.
   *
   * The per-tick fire-control system reads `Btn.Fire` from
   * `PlayerService.intentOf(entity)` for every controlled entity, human and bot
   * alike (architecture §3.4 rule 4). PRODUCERS SET THE INTENT BIT AND NEVER
   * CALL THIS — a bot that calls `setTrigger` instead of setting `Btn.Fire`
   * fires twice per trigger pull; one that sets the bit against an
   * implementation reading only `setTrigger` aims perfectly and never shoots.
   */
  setTrigger(entity: EntityId, held: boolean): void;
  setAds(entity: EntityId, wants: boolean): void;
  requestReload(entity: EntityId): void;
  cycleFireMode(entity: EntityId): void;
  /**
   * Aim basis AFTER aimPunch. Ballistics AND the HUD reticle both read this, so
   * the crosshair can never lie about the spread cone.
   */
  aimBasis(entity: EntityId, outOrigin: Vec3, outDirection: Vec3): void;
  spreadDegrees(entity: EntityId): number;
  /**
   * Throwable inventory for `entity`. Null before the entity has been issued a
   * loadout (i.e. before it is under locomotion control).
   *
   * THE HUD'S THROWABLE ROW READS THIS. See `ThrowableState`. OPTIONAL so the
   * frozen null service in `bootstrap/nulls.ts` — which builds a `WeaponService`
   * literal and may not be edited — stays valid; call it as
   * `services.weapons.throwableOf?.(entity) ?? null`.
   */
  throwableOf?(entity: EntityId): Readonly<ThrowableState> | null;
  /**
   * Refill `entity`'s throwables to capacity. The resupply seam: an ammo crate,
   * a supply drop or a respawn. Returns the units actually added.
   *
   * OPTIONAL for the same frozen-nulls reason as `throwableOf`.
   */
  restockThrowables?(entity: EntityId): number;
  /**
   * Put rounds back in `entity`'s pouch. Returns the rounds actually added.
   *
   * THE RESUPPLY SEAM FOR AMMUNITION, and the reason it has to exist: a soldier
   * carried `magazine + reserve` rounds and NOTHING in the whole repo could add
   * one back, so a match had a hard round budget — 210 for the service rifle —
   * and every player who reached it was dry for the rest of the game. The crates
   * are LEVEL's (`src/level/ammo.ts`, one at every capture point) and the
   * ammunition is WEAPONS', so this method is the only place the two meet.
   *
   * `fraction` is of the weapon's own `WeaponDef.reserve` and the total is
   * clamped to it: a crate cannot make a soldier carry more than a soldier
   * carries, so standing on one is not an infinite magazine. RESERVE ONLY — it
   * deliberately does not load the magazine, because a free instant reload
   * mid-firefight is a different mechanic and this one must not quietly be it.
   *
   * OPTIONAL for the same frozen-nulls reason as `throwableOf`; call it as
   * `services.weapons.resupply?.(entity) ?? 0`.
   */
  resupply?(entity: EntityId, fraction?: number): number;
}

export interface ShotRequest {
  readonly shooter: EntityId;
  readonly team: Team;
  readonly weapon: WeaponId;
  /**
   * Bullets start at the CAMERA so the crosshair is truthful, then lerp toward
   * the true muzzle over the first few metres.
   */
  readonly origin: Vec3;
  readonly muzzle: Vec3;
  readonly direction: Vec3;
  readonly spreadDeg: number;
  readonly pellets: number;
  /** Derived from (shooter, shotIndex): a shot is reproducible in isolation. */
  readonly seed: number;
  readonly tracer: boolean;
}

export interface ImpactEvent {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly incoming: Vec3;
  readonly surface: SurfaceId;
  readonly energyJ: number;
  readonly shooter: EntityId;
  readonly target: EntityId;
  readonly zone: HitZone;
  readonly weapon: WeaponId;
  readonly distanceM: number;
  readonly penetrated: boolean;
  readonly ricochet: boolean;
}

/**
 * Implemented by WEAPONS (`src/weapons/ballistics.ts`). Projectiles are pooled
 * entries in a fixed-size array integrated at tick rate and swept with a
 * shape-cast — NOT rapier dynamic bodies. No body explosion, no CCD tunnelling.
 */
export interface BallisticsService {
  fire(request: ShotRequest, ctx: TickCtx): number;
  /** Where a shot lands, for AI aim solving and for the HUD range readout. */
  predictImpact(origin: Vec3, direction: Vec3, weapon: WeaponId, out: Vec3): boolean;
  /** Aim direction that hits a target moving at `velocity`. Used by bots. */
  solveLead(origin: Vec3, target: Vec3, targetVelocity: Vec3, weapon: WeaponId, out: Vec3): boolean;
  /** Closest supersonic pass this frame; returns miss distance in m, or -1. */
  nearestWhizby(listener: Vec3, out: Vec3): number;
  readonly liveProjectiles: number;
  clear(): void;
}

/* ------------------------------------------------------- throwables (WEAPONS) */

/**
 * Throwable gadgets. One member today. A union rather than a bare string so a
 * second throwable is a compile error at every switch that has to grow, not a
 * silent fall-through.
 */
export type ThrowableId = 'frag';

/**
 * Live throwable inventory for ONE entity — the seam the HUD's gadget/throwable
 * row reads, and the reason it exists.
 *
 * `src/ui/system.ts` currently hardcodes `{ icon: 'frag', key: 'G', count: 2 }`
 * with the comment "no lane publishes deployed gadgets on the contract". This is
 * that publication: `GadgetSlot` needs `count`, `infinite` and `cooldown`, and
 * every one of them is here in the same units, so the HUD row can be driven
 * from the simulation with no arithmetic of its own.
 *
 *     const frag = services.weapons.throwableOf(services.player.localEntity);
 *     { icon: 'frag', key: 'G', count: frag?.count ?? 0,
 *       infinite: false, cooldown: frag?.cooldown ?? 0, selected: false }
 */
export interface ThrowableState {
  readonly id: ThrowableId;
  /** Units left in hand. 0 ⇒ pressing the button does nothing but click. */
  readonly count: number;
  /** Units carried on a fresh spawn. The denominator for a stock bar. */
  readonly capacity: number;
  /**
   * 0 = ready, 1 = fully unavailable — exactly `GadgetSlot.cooldown`'s meaning,
   * so it drives the tile's 45° hatch directly. 1 while empty, and ramping down
   * through the post-throw refractory.
   */
  readonly cooldown: number;
  /**
   * 0..1 of the way through the maximum cook while the button is HELD, 0 when
   * it is not. A ring around the tile, or a bar; the fuse is already burning.
   */
  readonly cook: number;
  /** True between pin-pull and release. */
  readonly cooking: boolean;
  /** Units in flight or on the ground with a live fuse, thrown by this entity. */
  readonly live: number;
}

/** Implemented by WEAPONS (`src/weapons/viewmodel/rig.ts`). */
export interface ViewmodelRig {
  readonly root: THREE.Object3D;
  readonly state: Readonly<WeaponFeelState>;
  /** THE one place sway/bob/ADS/kick are composed, from WeaponDef data alone. */
  update(ctx: FrameCtx, sim: Readonly<WeaponState>, def: Readonly<WeaponDef>): Readonly<WeaponFeelState>;
  muzzleWorld(out: Vec3): Vec3;
  setVisible(visible: boolean): void;
  /** Harness hook: 'idle' | 'ads' | 'sprint' | 'firing' | 'reload' | 'inspect'. */
  forcePose(pose: string): void;
}

/* =============================================================================
 * SECTION 18 — VFX + DECALS                                   amender: VFX
 * ========================================================================== */

export type VfxId =
  | 'muzzle.rifle'
  | 'muzzle.pistol'
  | 'muzzle.smoke'
  | 'shell.eject'
  | 'tracer'
  | 'impact.stone'
  | 'impact.metal'
  | 'impact.wood'
  | 'impact.glass'
  | 'impact.sand'
  | 'impact.water'
  | 'impact.flesh'
  | 'impact.foliage'
  | 'impact.fabric'
  | 'explosion.small'
  | 'explosion.large'
  | 'explosion.fuel'
  | 'smoke.column'
  | 'smoke.grenade'
  | 'rubble.puff'
  | 'debris.chunks'
  | 'ambient.dust'
  | 'ambient.pollen'
  | 'ambient.embers'
  | 'ambient.spray'
  | 'water.wake';

export enum DecalKind {
  BulletStone = 0,
  BulletMetal = 1,
  BulletWood = 2,
  BulletGlass = 3,
  Blood = 4,
  Scorch = 5,
  Crack = 6,
  Grime = 7,
  /** Soft debris ring that kills the hard seam where geometry meets ground. */
  GroundTransition = 8,
  Puddle = 9,
  None = 10,
}

export interface DecalRequest {
  readonly kind: DecalKind;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly tangent?: Vec3;
  readonly sizeM: number;
  readonly rotationRad: number;
  readonly surface: SurfaceId;
  /** 0 = permanent level dressing. Otherwise seconds until fully faded. */
  readonly lifetimeSeconds?: number;
  /** Reject surfaces deviating more than this from `normal` (kills smearing). */
  readonly angleCutoffDeg?: number;
  readonly opacity?: number;
  /** Follow a moving body. */
  readonly attachBody?: BodyHandle;
}

export interface VfxSpawnParams {
  readonly position: Vec3;
  readonly normal?: Vec3;
  readonly direction?: Vec3;
  readonly velocity?: Vec3;
  readonly scale?: number;
  readonly intensity?: number;
  readonly surface?: SurfaceId;
  readonly color?: Color;
  readonly parent?: THREE.Object3D;
  readonly seed?: number;
}

/**
 * Implemented by VFX (`src/vfx/system.ts`). Subscribes to FxEventMap in its
 * constructor; gameplay never calls it directly. Over-budget requests are
 * DROPPED BY PRIORITY — never throw, never stall.
 */
export interface VfxService {
  spawn(id: VfxId, params: VfxSpawnParams): VfxHandle;
  stop(handle: VfxHandle, fade?: boolean): void;
  addDecal(request: DecalRequest): DecalHandle;
  removeDecal(handle: DecalHandle): void;
  tracer(from: Vec3, to: Vec3, speedMs: number, weapon: WeaponId): VfxHandle;
  /** Harness reset: kills every transient emitter, decal, ribbon and debris chunk. */
  clearTransient(): void;
  readonly stats: Readonly<{ particles: number; decals: number; ribbons: number; drawCalls: number }>;
}

/* =============================================================================
 * SECTION 19 — AUDIO                                          amender: AUDIO
 * ========================================================================== */

export type SoundId =
  | 'w.rifle.fire'
  | 'w.carbine.fire'
  | 'w.dmr.fire'
  | 'w.smg.fire'
  | 'w.lmg.fire'
  | 'w.shotgun.fire'
  | 'w.pistol.fire'
  | 'w.tail'
  | 'w.distant'
  | 'w.dry'
  | 'w.magout'
  | 'w.magin'
  | 'w.bolt'
  | 'w.ads'
  | 'w.shell'
  | 'b.whizby'
  | 'b.crack'
  | 'i.stone'
  | 'i.metal'
  | 'i.wood'
  | 'i.glass'
  | 'i.sand'
  | 'i.water'
  | 'i.flesh'
  | 'i.fabric'
  | 'i.foliage'
  | 'p.footstep'
  | 'p.land'
  | 'p.jump'
  | 'p.gear'
  | 'p.breath'
  | 'p.hurt'
  | 'x.near'
  | 'x.far'
  | 'x.debris'
  | 'x.collapse'
  | 'amb.surf'
  | 'amb.wind'
  | 'amb.palms'
  | 'amb.gull'
  | 'amb.halyard'
  | 'amb.distant'
  | 'ui.capture'
  | 'ui.lost'
  | 'ui.ticket'
  | 'ui.hit'
  | 'ui.spawn'
  | 'ui.select';

export interface SoundEmitDesc {
  readonly position?: Vec3;
  readonly velocity?: Vec3;
  readonly gainDb?: number;
  readonly pitch?: number;
  readonly surface?: SurfaceId;
  /** 'gunshot' swaps in the long-range tail / air-absorption / echo model. */
  readonly model?: 'default' | 'gunshot' | 'ui' | 'ambience';
  /** 0 = clear line of sight, 1 = fully occluded. */
  readonly occlusion?: number;
  readonly maxDistance?: number;
  readonly loop?: boolean;
  readonly follow?: EntityId;
  readonly seed?: number;
}

export interface AcousticEnvironment {
  readonly name: 'open' | 'street' | 'courtyard' | 'interior' | 'tunnel' | 'harbour' | 'fort';
  /** 0 = open shoreline, 1 = tight stone street. Blends the convolution tails. */
  readonly enclosure: number;
  readonly reverbSeconds: number;
  readonly wetDb: number;
  /** Stone streets ring, sand and cloth do not. */
  readonly dampingHz: number;
}

/**
 * Implemented by AUDIO (`src/audio/system.ts`).
 *
 * CRITICAL: an AudioContext cannot start without a user gesture and the capture
 * page never gets one. Every method MUST be a safe no-op while `unlocked` is
 * false — a throw or an unresolved await during boot means `markReady()` never
 * fires and EVERY shot in the repo goes red at once. All synthesis happens at
 * bake time on an OfflineAudioContext producing Float32Arrays.
 */
export interface AudioService {
  readonly unlocked: boolean;
  unlock(): Promise<void>;
  play(id: SoundId, desc?: SoundEmitDesc): SoundHandle;
  stop(handle: SoundHandle, fadeSeconds?: number): void;
  setListener(position: Vec3, forward: Vec3, up: Vec3, velocity: Vec3): void;
  setEnvironment(env: Readonly<AcousticEnvironment>): void;
  setBusGainDb(bus: 'master' | 'sfx' | 'weapons' | 'ambience' | 'ui', db: number): void;
  /** Post-explosion ducking plus transient hearing loss, then recovery. */
  duck(seconds: number, amountDb: number): void;
  readonly stats: Readonly<{ voices: number; bufferBytes: number }>;
}

/* =============================================================================
 * SECTION 20 — HUD                                            amender: HUD
 * ========================================================================== */

export interface KillFeedEntry {
  readonly killer: string;
  readonly victim: string;
  readonly killerTeam: Team;
  readonly victimTeam: Team;
  readonly weapon: WeaponId | null;
  readonly headshot: boolean;
}

/**
 * Implemented by HUD (`src/ui/system.ts`).
 *
 * The HUD is rendered INTO THE WEBGL CANVAS as an orthographic pass after
 * tonemapping. `tools/capture.mjs` screenshots the canvas only, so a DOM HUD
 * would be invisible in every shot. There is no DOM UI anywhere in this project.
 * Drawing UI before tonemap is the single most common giveaway that a frame came
 * out of a hobby post stack.
 */
export interface HudService {
  /**
   * HUD's own visibility. The HUD draws when `visible && overlays.hud` — the
   * harness drives `RenderService.overlays.hud` through `setOverlays`, and a
   * shot that hides the HUD must win over a HudService that wants it shown.
   */
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  readonly font: AssetKey<BakedFont>;
  showHitmarker(kind: 'body' | 'head' | 'armour' | 'kill'): void;
  pushKillFeed(entry: KillFeedEntry): void;
  pushNotice(text: string, kind: 'capture' | 'lost' | 'objective' | 'system', durationSeconds?: number): void;
  setDamageDirection(worldDirection: Vec3, amount: number): void;
  /** Harness hook: 'default' | 'spawnmenu' | 'scoreboard' | 'dead' | 'capturing'. */
  forceState(state: string): void;
}

/* =============================================================================
 * SECTION 21 — NAVIGATION + AI                                amender: AI
 * ========================================================================== */

export interface NavmeshData {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly polyFlags: Uint8Array;
  readonly polyNeighbours: Int32Array;
  readonly polyCentres: Float32Array;
  readonly cellSize: number;
}

/**
 * Navmesh queries. Baked by LEVEL (which owns the geometry), queried by AI.
 * Implemented by AI (`src/ai/nav.ts`) over LEVEL's `NavmeshData`.
 */
export interface NavService {
  readonly ready: boolean;
  /** Nearest navmesh point within `radius`. Returns false if none. */
  sample(position: Vec3, radius: number, out: Vec3): boolean;
  /** Corridor + funnel string-pull. Returns the corner count written into `out`. */
  findPath(from: Vec3, to: Vec3, out: Vec3[]): number;
  /** Straight walkable segment test; the local steering primitive. */
  raycastWalkable(from: Vec3, to: Vec3, out: Vec3): boolean;
  randomPointNear(position: Vec3, radius: number, rng: Rng, out: Vec3): boolean;
  /** Called after destruction changes the world; re-bakes only the dirty rect. */
  invalidate(min: Vec3, max: Vec3): void;
  /**
   * Hand over a navmesh baked elsewhere — LEVEL's `navmesh-bake.ts`, which owns
   * the geometry and therefore bakes the real thing. THIS IS THE ONLY SEAM
   * BETWEEN THE TWO LANES: `LevelService` exposes no `NavmeshData` accessor, so
   * without it a mesh LEVEL bakes can never reach the service that queries it,
   * and AI is stuck on the one it derives from colliders.
   *
   * OPTIONAL so the null nav service stays valid. Call it as
   * `services.nav.build?.(data)` once, after `level.build()`.
   *
   * THE READING OF `NavmeshData` IT ASSUMES, because the struct does not state
   * it: `indices` is triples (one triangle per polygon), `polyFlags`,
   * `polyCentres` (3 floats) and `polyNeighbours` (3 ints) are all indexed by
   * TRIANGLE, and neighbour slot `e` is the triangle across the edge from ring
   * vertex `e` to `(e + 1) % 3`, or -1 at a border. A polyFlags entry of 0
   * means the polygon is not walkable.
   */
  build?(data: NavmeshData): void;
}

export enum BotBehaviour {
  Idle = 0,
  Advance = 1,
  Capture = 2,
  Engage = 3,
  Suppress = 4,
  TakeCover = 5,
  Reload = 6,
  Flank = 7,
  Regroup = 8,
  Retreat = 9,
  Dead = 10,
}

export interface BotProfile {
  readonly id: string;
  /** Seconds between first sighting and first shot. */
  readonly reactionTime: number;
  /** Steady-state aim error cone in degrees at 50 m. */
  readonly aimErrorDeg: number;
  readonly aimSpring: SpringParams;
  readonly burstDiscipline: number;
  readonly aggression: number;
  readonly coverPreference: number;
  readonly hearingRange: number;
  readonly visionRange: number;
  readonly visionConeDeg: number;
  readonly preferredWeapons: readonly WeaponId[];
}

export interface BotView {
  readonly entity: EntityId;
  readonly team: Team;
  readonly name: string;
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly health: number;
  readonly behaviour: BotBehaviour;
  readonly target: EntityId;
  readonly squad: number;
}

export type SquadOrder =
  | { kind: 'attack'; point: CapturePointId }
  | { kind: 'defend'; point: CapturePointId }
  | { kind: 'regroup'; position: Vec3 }
  | { kind: 'hold'; position: Vec3 };

/**
 * Implemented by AI (`src/ai/system.ts`). Perception is round-robin over a fixed
 * per-tick budget so cost is flat and the evaluation order is deterministic.
 * Bots emit `PlayerIntent`, so they drive the same controller as the player.
 */
export interface AiService {
  /**
   * ONE source for every bot; `sample()` switches on the entity it is handed.
   * AI does NOT dispatch it — `PlayerService` does, from its single
   * `TickPhase.Intent` system, for every entity in `PlayerService.controlled`.
   */
  readonly intentSource: IntentSource;
  readonly bots: readonly Readonly<BotView>[];
  readonly count: number;
  /**
   * Allocate the entity, then hand it to locomotion:
   * `services.player.attachController(entity, team, this.intentSource)`.
   * A bot that is not attached is never sampled and never moves.
   */
  spawnBot(team: Team, profile: Readonly<BotProfile>, spawn: Readonly<SpawnPointDef>): EntityId;
  /**
   * The frozen profile table, in stable order. THE ONLY WAY ANOTHER LANE GETS A
   * `BotProfile` — the tables live in `src/ai/profiles.ts`, which GAME's
   * `director.ts` may not import, and `spawnBot` is otherwise uncallable by the
   * lane the architecture assigns bot-count balancing to.
   */
  readonly profiles: readonly Readonly<BotProfile>[];
  /** `BotProfile.id` lookup. Undefined if the id is unknown. */
  profile(id: string): Readonly<BotProfile> | undefined;
  despawn(entity: EntityId): void;
  despawnAll(): void;
  /** 0..1. Scales reaction time, aim error cone and lead accuracy. */
  setDifficulty(value: number): void;
  /**
   * DIRECT push, for emitters that are NOT on the SimBus.
   *
   * AI subscribes to `SimEventMap['noise.emitted']` itself, so anything that
   * already emits that event MUST NOT also call this — the same gunshot heard
   * twice puts every hearing threshold out by 6 dB, and both the double-count
   * and the "nobody emits, nobody calls, bots are deaf" case are silent.
   */
  notifyNoise(event: NoiseEvent): void;
  orderFor(bot: EntityId): SquadOrder | null;
  /**
   * Freeze bots in a posed tableau for a deterministic shot. NOT a harness hook
   * — `ShotContext` has no route to a service — so `src/shots/ai.ts` cannot
   * reach it and AI calls it from its own lane instead.
   */
  forceState(state: string): void;
}

/* =============================================================================
 * SECTION 22 — PLAYER + GAME MODE                             amender: GAME
 * ========================================================================== */

export enum Stance {
  Stand = 0,
  Crouch = 1,
  Prone = 2,
}

export interface PlayerState {
  readonly entity: EntityId;
  readonly team: Team;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly eyeHeight: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly health: number;
  readonly stance: Stance;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  readonly alive: boolean;
  /** 0..1. Gates sprint and adds sway. */
  readonly stamina: number;
  /** Suppression from near misses: adds sway, desaturates, muffles audio. */
  readonly suppression: number;
  /** m/s along the ground plane. Drives bob and footstep rate. */
  readonly groundSpeed: number;
  /** -1..1 lean. */
  readonly lean: number;

  /* ---- appended by GAME. OPTIONAL BY NECESSITY, not by taste: `nulls.ts` is
   * frozen and builds a `PlayerState` literal, so a REQUIRED field added here
   * would break a file nobody is allowed to edit. Consumers read them with a
   * `?? default` and behave exactly as before when GAME has not landed. ---- */

  /**
   * What the body is DOING, as one value rather than five booleans that can
   * disagree. WEAPONS gates the sprint/slide viewmodel pose on it, HUD gates
   * the stance pip, AUDIO picks the footstep set.
   */
  readonly move?: MoveMode;
  /**
   * COSMETIC camera roll, radians, positive = roll right. Strafe lean plus
   * hard lean plus slide. Composed by `CameraRig` in the `lean` slot of its
   * composition order; it never affects the aim basis, so a bullet and the
   * crosshair can never disagree about it.
   */
  readonly viewRoll?: number;
  /** Downed but not dead: bleeding out, crawling, revivable. */
  readonly downed?: boolean;
  /** 1 → 0 over `BLEEDOUT_TIME` while downed. The HUD's bleedout ring. */
  readonly bleedout?: number;
}

/**
 * Locomotion, for EVERY intent-driven entity — the local human and all 24 bots.
 * Implemented by GAME (`src/game/player.ts`).
 *
 * THE ONE LOCOMOTION CODE PATH (architecture decision #6). A bot is not a second
 * kind of mover; it is an entity attached here with a bot `IntentSource` instead
 * of the human one. `attachController` is the whole seam:
 *
 *     // AI, inside spawnBot:
 *     ctx.services.player.attachController(entity, team, this.intentSource);
 *
 * GAME — and only GAME — dispatches. It registers exactly two `TickSystem`s:
 *
 *   `TickPhase.Intent`   walk `controlled` in order, call
 *                        `source.sample(entity, ctx, <that entity's intent>)`
 *   `TickPhase.Movement` turn each stored intent into accel/friction/air control
 *                        and one `CharacterController.move()` per entity
 *
 * No other lane may register a system at `TickPhase.Intent` or
 * `TickPhase.Movement`. AI thinks at `TickPhase.Ai` and writes nothing but the
 * `PlayerIntent` its own `sample()` is handed.
 */
export interface PlayerService {
  /** The entity the local human drives. Stable for the whole session. */
  readonly localEntity: EntityId;
  /** The LOCAL player. Exactly `stateOf(localEntity)`, never null. */
  readonly state: Readonly<PlayerState>;
  /**
   * Every entity currently under locomotion control, in attach order. Dense and
   * stable, so iterating it is deterministic (see §9.2 of the architecture).
   */
  readonly controlled: readonly EntityId[];
  /** Per-entity locomotion state. Null if `entity` is not controlled. */
  stateOf(entity: EntityId): Readonly<PlayerState> | null;
  /**
   * The capsule GAME created for `entity` — radius, stand/crouch/prone heights,
   * step height, slope limit. Null if `entity` is not controlled.
   *
   * CHARACTER RIGS, HITBOXES, EYE AND MUZZLE OFFSETS MUST BE SIZED FROM THIS,
   * never from their own constants. AI builds the soldier mesh and the per-zone
   * hitbox stack; GAME creates the capsule; if the two disagree by 5 cm the bots
   * float, the hitboxes sit off the mesh, and it looks like a physics bug.
   */
  configOf(entity: EntityId): Readonly<CharacterConfig> | null;
  /**
   * Put `entity` under locomotion control, driven by `source`. Idempotent:
   * attaching an already-controlled entity replaces its source and nothing else.
   */
  attachController(entity: EntityId, team: Team, source: IntentSource): void;
  /** Remove `entity` from the controlled set. Safe on an unknown entity. */
  releaseController(entity: EntityId): void;
  /**
   * The intent sampled for `entity` at `TickPhase.Intent` THIS tick. WEAPONS
   * reads the trigger bits from here, HUD reads lean, AI reads back what its own
   * brain asked for. Null if `entity` is not controlled. Never mutate it.
   */
  intentOf(entity: EntityId): Readonly<PlayerIntent> | null;
  teleport(entity: EntityId, position: Vec3, yaw: number, pitch: number): void;
  /** SIM recoil: deflects `entity`'s aim basis, and therefore its bullets. */
  applyAimPunch(entity: EntityId, pitchDeg: number, yawDeg: number): void;
  /** Harness hook, LOCAL player only: 'idle' | 'ads' | 'sprint' | 'firing' | 'crouch' | 'prone' | 'dead'. */
  setForcedState(state: string | null): void;
}

/**
 * Locomotion mode — appended by GAME.
 *
 * ONE value instead of a bag of booleans. `sprinting && sliding` is a state that
 * cannot be represented here, which is the point: three lanes reading three
 * booleans is three chances to disagree about what the body is doing.
 */
export enum MoveMode {
  Idle = 0,
  Walk = 1,
  Sprint = 2,
  /** Weapon carried low; cannot fire without a transition. */
  TacticalSprint = 3,
  Crouch = 4,
  Prone = 5,
  Air = 6,
  Slide = 7,
  /** Waist-high traversal, momentum kept. */
  Vault = 8,
  /** Chest-high pull-up, momentum spent. */
  Mantle = 9,
  /** Downed, crawling, bleeding out. */
  Downed = 10,
  Dead = 11,
}

export enum MatchPhase {
  Warmup = 0,
  Live = 1,
  Overtime = 2,
  Ended = 3,
}

export enum CaptureState {
  Neutral = 0,
  OwnedCoalition = 1,
  OwnedInsurgent = 2,
  Contested = 3,
  CapturingCoalition = 4,
  CapturingInsurgent = 5,
}

export interface CapturePointRuntime {
  readonly id: CapturePointId;
  readonly state: CaptureState;
  readonly owner: Team;
  /** -1 fully Insurgent … 0 neutral … +1 fully Coalition. */
  readonly progress: number;
  readonly contested: boolean;
  /**
   * Live occupant counts, keyed by `Team`. A RECORD AND NOT A 2-TUPLE: `Team`
   * has three members and `owner` genuinely returns `Team.Neutral`, so a tuple
   * makes `occupants[point.owner]` a hard type error (TS2493) at every call
   * site and invites an `as` cast that indexes off the end.
   * `Team.Neutral` is always 0.
   */
  readonly occupants: Readonly<Record<Team, number>>;
}

export interface PlayerScore {
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly captures: number;
  readonly score: number;
}

export type SpawnChoice =
  | { kind: 'base' }
  | { kind: 'point'; point: CapturePointId }
  | { kind: 'squad'; on: EntityId };

export interface MatchState {
  readonly phase: MatchPhase;
  readonly timeRemaining: number;
  /** Keyed by `Team`; `Team.Neutral` is always 0. See `CapturePointRuntime.occupants`. */
  readonly tickets: Readonly<Record<Team, number>>;
  /**
   * Tickets each team starts the round with — THE TICKET BAR'S DENOMINATOR.
   * Without it a bar has no fill fraction and HUD hardcodes a number that
   * silently disagrees with `src/game/conquest.ts`.
   */
  readonly ticketsMax: number;
  readonly points: readonly Readonly<CapturePointRuntime>[];
  readonly winner: Team | null;
  readonly localTeam: Team;
  readonly localScore: Readonly<PlayerScore>;
  readonly scores: ReadonlyMap<EntityId, Readonly<PlayerScore>>;
}

/** Implemented by GAME (`src/game/conquest.ts`). */
export interface GameMode {
  readonly id: string;
  readonly state: Readonly<MatchState>;
  /** Validated spawn position, or null if the choice is unsafe/invalid. */
  requestSpawn(entity: EntityId, choice: SpawnChoice): Readonly<SpawnPointDef> | null;
  teamOf(entity: EntityId): Team;
  nameOf(entity: EntityId): string;
  /** Harness hook: 'preround' | 'alpha_contested' | 'endgame' | 'dead' | 'live'. */
  forceState(state: string): void;
  reset(seed: number): void;
}

/* =============================================================================
 * SECTION 23 — RE-EXPORTS FROM THE LOCKED HARNESS             amender: CORE
 * ========================================================================== */

/**
 * Re-exported so a lane writing `src/shots/<area>.ts` imports only from
 * `@/engine/types` and `@/engine/harness`'s `registerShot`.
 */
export type { HarnessDriver, ShotContext };
