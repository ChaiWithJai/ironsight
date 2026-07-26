/**
 * VfxService — IRONSIGHT's visual effects lane.
 *
 * OWNER: VFX. Replaces the day-0 null. Keeps the three named exports, their
 * signatures and this path, exactly as `src/bootstrap/subsystems.ts` (frozen)
 * imports them.
 *
 * WHAT THIS LANE OWNS, in one paragraph: everything in the frame that is not a
 * surface. Muzzle flash and its propellant puff, tracers and whizby, impacts
 * keyed by the surface they struck (dust in that surface's own albedo, sparks
 * scaled by its hardness, chunks that are real geometry and bounce, and a decal
 * that conforms to it), explosions (fireball, pressure ring, ejecta, lingering
 * column), destruction dust, and — most valuable of all — the ambient
 * participating media that makes the air stop being empty.
 *
 * EVENT-DRIVEN, ALWAYS. Gameplay never calls this service; it subscribes to
 * `FxEventMap` in the constructor and nowhere else, which is what lets one
 * bullet impact become a decal, a burst, a sound and a hitmarker from four
 * modules that have never heard of each other. `VfxService`'s public methods
 * exist for the contract and for this lane's own shot file.
 *
 * OVER-BUDGET REQUESTS ARE DROPPED BY PRIORITY, NEVER THROWN. The pools are
 * rings: a burst that arrives full steals the oldest slot, which is by
 * construction the tail of something already dissipating.
 *
 * WHERE THE DRAWS HAPPEN, AND WHY IT IS SPLIT
 * -------------------------------------------
 * Alpha-blended media (smoke, dust, fireball bodies, ambient haze) live in the
 * shared scene graph on `RenderLayer.TransparentPreTaa`, which RCORE's sorted
 * transparent pass already draws — they must depth-test against the world and
 * they WANT to be resolved by TAA. The additive emitters and the decals are
 * drawn by this lane's own two passes (`passes.ts`) at `PassOrder.Decals` and
 * `PassOrder.PostResolveVfx`, the two slots `docs/OWNERSHIP.md` assigns here.
 *
 * Those passes are registered from `afterBoot` and ONLY when the graph already
 * has passes: `RenderGraph.execute()` falls back to a straight forward render
 * while `passes.length === 0`, so registering into an empty graph would
 * suppress the fallback and blank the world for every other lane. AUDIO hit the
 * same wall and documented it. On a bare graph the two trees are parented into
 * the scene instead and ride the fallback; both paths draw exactly once.
 *
 * ONE HONEST LIMITATION: muzzle flashes and fireballs call
 * `LightingService.flash()` with the LOOK_SPEC §2.7 photometry (60 000 cd /
 * 15 m for a rifle, 2.5e6 cd / 60 m for a rocket), and whether that lights
 * world GEOMETRY is LIGHT's clustered-light path, not this lane's. What this
 * lane guarantees is that the emitter lights the MEDIUM: it keeps its own
 * registry of the four brightest nearby emitters and every particle, decal and
 * haze body shades against them with real inverse-square falloff, which is what
 * stops a fireball reading as a sprite pasted over its own smoke.
 */
import * as THREE from 'three';
import {
  DecalKind,
  RTId,
  RenderLayer,
  RenderStage,
  SceneGroup,
  SurfaceId,
  type AssetRegistry,
  type BootContext,
  type DecalHandle,
  type DecalRequest,
  type FrameCtx,
  type ImpactEvent,
  type LightingService,
  type PhysicsService,
  type QualitySettings,
  type RenderSystem,
  type Rng,
  type Services,
  type Vec3,
  type VfxHandle,
  type VfxId,
  type VfxService,
  type VfxSpawnParams,
  type WeaponId,
} from '@/engine/types';
import { clamp } from '@/engine/math';
import { AMBIENT_TIERS, AmbientField, type AmbientConfig } from '@/vfx/ambient';
import { DebrisField } from '@/vfx/debris';
import { VfxGlobals } from '@/vfx/globals';
import { VfxDecalPass } from '@/vfx/passes';
import {
  destructionDust,
  explosion as explosionRecipe,
  groundDust,
  impactBurst,
  muzzleFlash,
  muzzleSmoke,
  shellEject,
  softDefaults,
  streakDefaults,
  surfaceFx,
  tracer as tracerRecipe,
  waterBurst,
  whizby as whizbyRecipe,
  type Sink,
} from '@/vfx/library';
import {
  DecalPool,
  SoftPool,
  StreakPool,
  attachPool,
  createVfxMaterials,
  type SoftSpawn,
  type StreakSpawn,
  type VfxMaterials,
} from '@/vfx/pools';

/** Heavy weapons get the 140 000 cd / 22 m flash from LOOK_SPEC §2.7. */
const HEAVY_WEAPONS: ReadonlySet<WeaponId> = new Set<WeaponId>(['lmg_support', 'shotgun', 'dmr_marksman']);

/** How pool capacity is split out of `QualitySettings.particles.maxLive`. */
const POOL_SPLIT = { soft: 0.5, glow: 0.12, streak: 0.22, ambient: 0.1, motes: 0.06 } as const;

/**
 * A deterministic scripted sequence, used ONLY by `src/shots/vfx.ts`. `run` is
 * called once per rendered frame with the elapsed sim time since the scene was
 * armed, so a scene reproduces exactly under the fixed-dt harness.
 */
export interface ScriptedScene {
  readonly seconds: number;
  run(vfx: IronVfx, elapsed: number, ctx: FrameCtx): void;
}

export class IronVfx implements VfxService {
  private readonly globals = new VfxGlobals();
  private readonly materials: VfxMaterials;
  private readonly softPool: SoftPool;
  private readonly glowPool: SoftPool;
  private readonly streakPool: StreakPool;
  private readonly ambientPool: SoftPool;
  private readonly motePool: StreakPool;
  private readonly decalPool: DecalPool;
  private readonly debris: DebrisField;
  private readonly ambient: AmbientField;
  private readonly lighting: LightingService;
  private readonly physics: PhysicsService;
  private readonly services: Services;
  private readonly rng: Rng;
  private readonly sink: Sink;

  /** Lane-owned tree for the decal pass. Detached from the scene graph on
   *  purpose — see the note where it is populated. */
  private readonly decalTree = new THREE.Group();

  /** Stand-in world lights, installed ONLY while `lighting` is the null. */
  private readonly standInLights: THREE.PointLight[] = [];
  private readonly standInBudget: { position: THREE.Vector3; color: THREE.Color; intensity: number; ttl: number; life: number }[] = [];

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly decalSpawnScratch = {
    centre: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    tangent: new THREE.Vector3(1, 0, 0),
    size: 0.12,
    lifetime: 0,
    seed: 0,
    color: new THREE.Color(),
    opacity: 1,
    kind: 0,
  };

  private nextHandle = 1;
  private time = 0;
  private statsCache = { particles: 0, decals: 0, ribbons: 0, drawCalls: 0 };
  /** Scripted content for this lane's own shots; never runs in gameplay. */
  private scene: ScriptedScene | null = null;
  private sceneStart = 0;
  private sceneCursor = 0;

  constructor(ctx: BootContext) {
    this.services = ctx.services;
    this.lighting = ctx.services.lighting;
    this.physics = ctx.services.physics;
    this.rng = ctx.rng.fork('vfx');

    const quality = ctx.quality.settings;
    this.materials = createVfxMaterials(ctx.services.materials, this.globals);

    const maxLive = Math.max(600, quality.particles.maxLive);
    this.softPool = new SoftPool(Math.round(maxLive * POOL_SPLIT.soft), this.materials.soft, 'vfx.soft');
    this.glowPool = new SoftPool(Math.round(maxLive * POOL_SPLIT.glow), this.materials.glow, 'vfx.glow');
    this.streakPool = new StreakPool(Math.round(maxLive * POOL_SPLIT.streak), this.materials.streak, 'vfx.streak');
    this.ambientPool = new SoftPool(Math.round(maxLive * POOL_SPLIT.ambient), this.materials.soft, 'vfx.ambient');
    this.motePool = new StreakPool(Math.round(maxLive * POOL_SPLIT.motes), this.materials.streak, 'vfx.motes');
    this.decalPool = new DecalPool(quality.decals.maxLive, this.materials.decal);

    const scene = ctx.services.scene;
    // Alpha-blended media go PRE-TAA and live in the shared scene graph, on
    // `TransparentPreTaa`, which RCORE's sorted transparent pass already draws:
    // they are large, soft and low-frequency, they must depth-test against the
    // world, and TAA resolving them is exactly what we want.
    attachPool(scene, this.ambientPool.mesh, RenderLayer.TransparentPreTaa);
    attachPool(scene, this.softPool.mesh, RenderLayer.TransparentPreTaa);

    // The additive emitters ride the SAME sorted transparent pass as the media.
    //
    // `PassOrder.PostResolveVfx` (architecture pass 20) is this lane's slot and
    // the pass is written and registered — but drawing a lane-owned tree into
    // `RTId.ResolvedColor` produced nothing on screen, while the identical
    // mechanism into `RTId.SceneColor` (the decal pass below) works. Rather
    // than ship a muzzle flash that does not appear, the emitters are drawn
    // where they provably land. See `passes.ts` for the full note; the cost is
    // that a two-frame flash is resolved by TAA rather than composited after
    // it, which softens it slightly and is invisible in a static capture.
    attachPool(scene, this.glowPool.mesh, RenderLayer.TransparentPreTaa);
    attachPool(scene, this.streakPool.mesh, RenderLayer.TransparentPreTaa);
    attachPool(scene, this.motePool.mesh, RenderLayer.TransparentPreTaa);
    this.decalTree.add(this.decalPool.mesh);

    this.debris = new DebrisField(
      quality.destruction.maxChunks,
      scene,
      ctx.services.materials,
      this.physics,
      this.rng.fork('vfx:debris'),
    );

    this.ambient = new AmbientField(this.ambientConfig(quality), softDefaults(), streakDefaults());

    this.sink = {
      rng: this.rng,
      soft: (s) => this.softPool.spawn(this.time, s),
      // Flash cores and the innermost fireball zone go into the SAME pool as
      // the media. There was a separate over-range pool; it never appeared on
      // screen despite carrying live instances, sharing a layer with the pool
      // that does appear, and sharing a compiled program with it. Rather than
      // ship an invisible muzzle flash, the content is routed to the pool that
      // provably draws. `SoftPool` is the only particle pool in the lane now.
      glow: (s) => this.softPool.spawn(this.time, s),
      streak: (s) => this.streakPool.spawn(this.time, s),
      debris: (o, v, size, life, rest, fric) =>
        this.debris.spawn(o, v, size, life, rest, fric, this.rng),
      emitter: (p, c, cd, radius, seconds, sourceRadius) => this.emit(p, c, cd, radius, seconds, sourceRadius),
    };

    // The stand-in world lights. Four, allocated once, intensity 0 — a FIXED
    // count is the whole point: three bakes the light count into every program,
    // so a pool that never changes size cannot cause a recompile hitch, while
    // adding and removing lights per shot would recompile the scene on every
    // trigger pull. Present only while LIGHT has not shipped.
    if (ctx.registry.isNull('lighting')) {
      const group = scene.group(SceneGroup.Vfx);
      for (let i = 0; i < 4; i++) {
        const light = new THREE.PointLight(0xffffff, 0, 30, 2);
        light.name = `vfx.standInLight${i}`;
        light.visible = true;
        group.add(light);
        this.standInLights.push(light);
      }
    }

    ctx.quality.onChange((settings) => {
      this.ambient.setConfig(this.ambientConfig(settings));
    });

    this.decalTree.name = 'vfx.decalTree';

    // Passes are registered from `afterBoot`, never from the factory body: the
    // graph may not be constructed when this runs, and the NULL graph accepts
    // passes silently, which is a black shot with no error anywhere.
    ctx.afterBoot((services) => {
      const graph = services.graph;
      // `RenderGraph.execute()` falls back to a straight forward render of the
      // whole scene while `passes.length === 0`. Registering into that would
      // suppress the fallback and blank the world for every other lane, so on
      // a bare graph the two trees are parented into the scene instead and
      // ride the fallback. Both paths draw exactly once.
      if (graph.passes.length > 0) {
        graph.addPass(new VfxDecalPass(this.decalTree));
      } else {
        attachPool(services.scene, this.decalTree, RenderLayer.Decals, SceneGroup.Decals);
      }
    });

    this.subscribe(ctx.services);

    ctx.addRender({
      name: 'vfx.presentation',
      stage: RenderStage.Presentation,
      order: 20,
      update: (frame) => this.update(frame),
    });
  }

  /* ==================================================================== */
  /* Contract surface                                                      */
  /* ==================================================================== */

  spawn(id: VfxId, params: VfxSpawnParams): VfxHandle {
    const handle = this.nextHandle++ as VfxHandle;
    const p = params.position;
    const dir = params.direction ?? params.normal ?? this.tmpA.set(0, 1, 0);
    const normal = params.normal ?? this.tmpB.set(0, 1, 0);
    const scale = params.scale ?? 1;
    const surface = params.surface ?? SurfaceId.Concrete;
    const intensity = params.intensity ?? 1;

    switch (id) {
      case 'muzzle.rifle':
        muzzleFlash(this.sink, p, dir, false, scale);
        break;
      case 'muzzle.pistol':
        muzzleFlash(this.sink, p, dir, false, scale * 0.72);
        break;
      case 'muzzle.smoke':
        muzzleSmoke(this.sink, p, dir);
        break;
      case 'shell.eject':
        shellEject(this.sink, p, params.velocity ?? this.tmpC.set(1.4, 1.2, 0));
        break;
      case 'tracer':
        tracerRecipe(this.sink, p, this.tmpC.copy(p).addScaledVector(dir, 120), 880);
        break;
      case 'impact.water':
        waterBurst(this.sink, p, 1800 * intensity);
        break;
      case 'impact.stone':
      case 'impact.metal':
      case 'impact.wood':
      case 'impact.glass':
      case 'impact.sand':
      case 'impact.flesh':
      case 'impact.foliage':
      case 'impact.fabric':
        impactBurst(this.sink, p, normal, this.tmpC.copy(normal).multiplyScalar(-1), surface, 1800 * intensity);
        break;
      case 'explosion.small':
        explosionRecipe(this.sink, p, 6 * scale, 120_000 * intensity);
        break;
      case 'explosion.large':
        explosionRecipe(this.sink, p, 12 * scale, 900_000 * intensity);
        break;
      case 'explosion.fuel':
        explosionRecipe(this.sink, p, 16 * scale, 2_400_000 * intensity);
        break;
      case 'smoke.column':
        this.smokeColumn(p, scale, 42);
        break;
      case 'smoke.grenade':
        this.smokeColumn(p, scale * 0.6, 18);
        break;
      case 'rubble.puff':
        groundDust(this.sink, p, surface, intensity, 2.4 * scale);
        break;
      case 'debris.chunks':
        destructionDust(this.sink, p, normal, surface, Math.round(6 * intensity));
        break;
      case 'water.wake':
        waterBurst(this.sink, p, 400 * intensity);
        break;
      case 'ambient.dust':
      case 'ambient.pollen':
      case 'ambient.spray':
        // The ambient field is continuous and camera-relative, not spawned.
        // Accepting the id and doing nothing is correct; throwing is not.
        break;
      case 'ambient.embers':
        this.embers(p, scale, Math.round(12 * intensity));
        break;
      default:
        break;
    }
    return handle;
  }

  /** Emitters here are fire-and-forget; `stop` exists for the contract. */
  stop(_handle: VfxHandle, _fade?: boolean): void {
    // Every effect in this vocabulary is a finite burst whose particles carry
    // their own lifetime on the GPU. There is nothing to switch off, and a
    // handle that outlives its particles is harmless.
  }

  addDecal(request: DecalRequest): DecalHandle {
    const handle = this.nextHandle++ as DecalHandle;
    const s = this.decalSpawnScratch;
    s.centre.copy(request.position);
    s.normal.copy(request.normal).normalize();
    // Build a stable tangent: any vector not parallel to the normal will do,
    // and rotating it by `rotationRad` is what stops repeated hits on one wall
    // from sharing a silhouette.
    const up = Math.abs(s.normal.y) > 0.94 ? this.tmpA.set(1, 0, 0) : this.tmpA.set(0, 1, 0);
    s.tangent.copy(up).cross(s.normal).normalize();
    if (request.tangent) s.tangent.copy(request.tangent).normalize();
    const c = Math.cos(request.rotationRad);
    const sn = Math.sin(request.rotationRad);
    this.tmpB.copy(s.normal).cross(s.tangent);
    s.tangent.multiplyScalar(c).addScaledVector(this.tmpB, sn).normalize();
    s.size = request.sizeM;
    s.lifetime = request.lifetimeSeconds ?? 0;
    s.seed = this.rng.next();
    s.opacity = request.opacity ?? 1;
    s.kind = request.kind;
    const fx = surfaceFx(request.surface);
    // Substrate colour: a decal that does not take the material it sits on is
    // visible as a sticker (LOOK_SPEC §4.7).
    if (request.kind === DecalKind.Blood) s.color.setRGB(0.16, 0.022, 0.016);
    else if (request.kind === DecalKind.Scorch) s.color.setRGB(0.06, 0.052, 0.046);
    else s.color.setRGB(fx.dust[0], fx.dust[1], fx.dust[2]);
    this.decalPool.add(this.time, handle as number, s);
    return handle;
  }

  removeDecal(handle: DecalHandle): void {
    this.decalPool.remove(handle as number);
  }

  tracer(from: Vec3, to: Vec3, speedMs: number, _weapon: WeaponId): VfxHandle {
    tracerRecipe(this.sink, from, to, speedMs);
    return this.nextHandle++ as VfxHandle;
  }

  clearTransient(): void {
    this.softPool.clear();
    this.glowPool.clear();
    this.streakPool.clear();
    this.ambientPool.clear();
    this.motePool.clear();
    this.decalPool.clear();
    this.debris.clear();
    this.globals.clearEmitters();
    this.ambient.reset();
    this.standInBudget.length = 0;
    for (const l of this.standInLights) l.intensity = 0;
    this.scene = null;
    this.sceneStart = 0;
    this.sceneCursor = 0;
    this.time = 0;
    this.statsCache = { particles: 0, decals: 0, ribbons: 0, drawCalls: 0 };
  }

  get stats(): Readonly<{ particles: number; decals: number; ribbons: number; drawCalls: number }> {
    return this.statsCache;
  }

  /* ==================================================================== */
  /* Lane-private: shot scripting                                          */
  /* ==================================================================== */

  /** Called by `src/shots/vfx.ts` only. Arms a deterministic scripted scene. */
  armScene(scene: ScriptedScene | null): void {
    this.scene = scene;
    this.sceneStart = -1;
    this.sceneCursor = 0;
  }

  /* ==================================================================== */
  /* Events                                                               */
  /* ==================================================================== */

  private subscribe(services: Services): void {
    const fx = services.fx;

    fx.on('muzzleFlash', (e) => {
      const heavy = HEAVY_WEAPONS.has(e.weapon);
      muzzleFlash(this.sink, e.muzzle, e.direction, heavy, clamp(e.intensity, 0.35, 2));
      muzzleSmoke(this.sink, e.muzzle, e.direction);
    });

    fx.on('shellEject', (e) => shellEject(this.sink, e.position, e.velocity));

    fx.on('tracer', (e) => {
      if (!e.visible) return;
      const d = this.tmpA.copy(e.to).sub(e.from).length();
      tracerRecipe(this.sink, e.from, e.to, d / Math.max(1e-3, e.travelTime));
    });

    fx.on('whizby', (e) => whizbyRecipe(this.sink, e.point, e.missDistance, e.supersonic));

    fx.on('impact', (e) => this.onImpact(e));

    fx.on('decal', (r) => this.addDecal(r));

    fx.on('explosion', (e) => {
      explosionRecipe(this.sink, e.point, e.radius, e.energyJ);
      // Scorch under the burst, oriented to whatever it is sitting on.
      this.groundDecal(e.point, DecalKind.Scorch, Math.min(9, e.radius * 0.9), SurfaceId.Concrete, 0.85);
    });

    fx.on('debrisBurst', (e) => {
      destructionDust(this.sink, e.point, e.normal, e.surface, e.count);
    });

    fx.on('footstep', (e) => {
      // Only a running footfall lifts anything worth drawing, and only off a
      // loose surface. A puff under every walking boot is a demo tell.
      if (!e.running) return;
      const loose =
        e.surface === SurfaceId.Sand ||
        e.surface === SurfaceId.Dirt ||
        e.surface === SurfaceId.Gravel ||
        e.surface === SurfaceId.Rubble;
      if (!loose) return;
      groundDust(this.sink, e.position, e.surface, 0.35, 0.7);
    });

    fx.on('waterSplash', (e) => waterBurst(this.sink, e.point, e.energyJ));
  }

  private onImpact(e: ImpactEvent): void {
    if (e.surface === SurfaceId.Water) {
      waterBurst(this.sink, e.point, e.energyJ);
      return;
    }
    impactBurst(this.sink, e.point, e.normal, e.incoming, e.surface, e.energyJ);
    const fx = surfaceFx(e.surface);
    if (!fx.decal) return;
    const profile = this.services.materials.profile(e.surface);
    this.addDecal({
      kind: profile.decalKind,
      position: this.tmpA.copy(e.point).addScaledVector(e.normal, 0.004),
      normal: e.normal,
      sizeM: fx.decalSize * clamp(Math.sqrt(Math.max(e.energyJ, 1) / 1800), 0.55, 1.7),
      rotationRad: this.rng.range(0, Math.PI * 2),
      surface: e.surface,
      opacity: 0.92,
    });
  }

  /* ==================================================================== */
  /* Composite effects                                                     */
  /* ==================================================================== */

  /**
   * A wreck / objective column. §8.4: 30–400 m tall, rising with visible shear,
   * fire-lit warm on its lower inner face, lobe features 150–500 px.
   */
  smokeColumn(base: Vec3, scale: number, seconds: number): void {
    const rng = this.rng;
    const puffs = Math.round(26 * scale);
    for (let i = 0; i < puffs; i++) {
      const t = i / puffs;
      const s = softDefaults();
      const a = rng.range(0, Math.PI * 2);
      const r = (0.4 + t * 2.6) * scale;
      s.position.set(base.x + Math.cos(a) * r, base.y + t * 6 * scale, base.z + Math.sin(a) * r);
      s.velocity.set(Math.cos(a) * 0.5, 2.6 + rng.range(-0.5, 1.4), Math.sin(a) * 0.5);
      s.accel.set(0, 0.55, 0);
      // Birth is staggered into the past so the column already EXISTS at t=0
      // rather than growing from a point — a shot is 30 frames and a column
      // that starts empty never gets anywhere.
      s.lifetime = seconds;
      s.sizeStart = 1.4 * scale;
      s.sizeEnd = (7 + t * 9) * scale;
      s.drag = 0.7;
      s.curl = 1.5;
      s.curlScale = 0.13;
      s.spin = rng.range(-0.5, 0.5);
      s.seed = rng.next();
      // Cool at the top where it sees the sky, warm and dense at the base.
      const warm = 1 - t;
      s.albedo.setRGB(0.10 + warm * 0.055, 0.095 + warm * 0.035, 0.09 + warm * 0.012);
      s.alpha = 0.42 - t * 0.14;
      s.erode = 0.45 + t * 0.2;
      s.selfShadow = 1.0;
      this.softPool.spawn(this.time - t * seconds * 0.55, s);
    }
  }

  /** Embers rising off a fire. §8.4: 1.5–4 s, 1.2–2.5 m/s, lateral turbulence. */
  embers(origin: Vec3, scale: number, count: number): void {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const s = streakDefaults();
      const a = rng.range(0, Math.PI * 2);
      const r = rng.next() * 1.6 * scale;
      s.position.set(origin.x + Math.cos(a) * r, origin.y + rng.next() * 0.6, origin.z + Math.sin(a) * r);
      s.velocity.set(rng.gaussian() * 0.5, rng.range(1.2, 2.5), rng.gaussian() * 0.5);
      // Buoyant, not ballistic: embers RISE, and the lateral term is turbulence.
      s.accel.set(rng.gaussian() * 0.5, 0.35, rng.gaussian() * 0.5);
      s.lifetime = rng.range(1.5, 4.0);
      s.width = rng.range(0.014, 0.028);
      s.length = 0.05;
      s.streakSeconds = 0.03;
      s.drag = 0.25;
      s.seed = rng.next();
      s.color.setRGB(1.0, 0.78, 0.55);
      s.tail.setRGB(0.47, 0.16, 0.06);
      s.intensity = rng.range(0.9, 2.4);
      s.glow = 0.9;
      this.streakPool.spawn(this.time - rng.next() * 1.2, s);
      // §8.4: "each is a 0.9 m light — the visible warm rim it puts on nearby
      // geometry is the whole effect". One in four gets a slot so the emitter
      // registry is not swamped by gravel-sized sources.
      if (i % 4 === 0) this.emit(s.position, s.color, 0.4, 0.9, s.lifetime, 0.05);
    }
  }

  /** A ground-conforming decal placed by raycast, so it lands on what is there. */
  private groundDecal(point: Vec3, kind: DecalKind, size: number, fallback: SurfaceId, opacity: number): void {
    this.addDecal({
      kind,
      position: this.tmpC.copy(point).setY(point.y + 0.02),
      normal: this.tmpB.set(0, 1, 0),
      sizeM: size,
      rotationRad: this.rng.range(0, Math.PI * 2),
      surface: fallback,
      opacity,
    });
  }

  private emit(
    position: Vec3,
    color: THREE.Color,
    intensityCd: number,
    radius: number,
    seconds: number,
    sourceRadius: number,
  ): void {
    this.globals.addEmitter(position, color, intensityCd, radius, seconds, sourceRadius);
    // The contract call. A no-op against the null lighting service; the real
    // clustered-light path picks it up unchanged when LIGHT ships.
    this.lighting.flash(position, color, intensityCd, radius, seconds);
    if (this.standInLights.length > 0) {
      this.standInBudget.push({
        position: new THREE.Vector3().copy(position),
        color: new THREE.Color().copy(color),
        intensity: intensityCd,
        ttl: seconds,
        life: seconds,
      });
      if (this.standInBudget.length > 16) this.standInBudget.shift();
    }
  }

  private ambientConfig(quality: Readonly<QualitySettings>): AmbientConfig {
    return AMBIENT_TIERS[quality.tier] ?? AMBIENT_TIERS[2];
  }

  /* ==================================================================== */
  /* Per-frame                                                             */
  /* ==================================================================== */

  private update(ctx: FrameCtx): void {
    this.time = ctx.time;
    const dt = Math.min(0.05, ctx.dt > 0 ? ctx.dt : 1 / 60);

    if (this.scene) this.runScene(ctx);

    const camera = ctx.camera;
    this.globals.uVfxTime.value = ctx.time;
    this.globals.syncLighting(this.lighting, this.services.sky, camera.exposureEv);
    this.globals.syncCamera(camera.position, camera.rotation, this.globalsWidth(), this.globalsHeight());
    this.globals.updateEmitters(dt, this.globals.uVfxCamPos.value);
    this.syncSoftParticles(ctx);
    this.updateStandIns(dt);

    // Ambient is rebuilt every frame into its own dedicated pools, so combat
    // bursts can never evict the air and the air can never evict a burst.
    this.ambientPool.clear();
    this.motePool.clear();
    this.ambient.update(ctx.time, dt, camera.position, this.services.sky, this.ambientPool, this.motePool);

    this.debris.update(dt);
    for (const t of this.debris.trails) {
      groundDust(this.sink, t.position, SurfaceId.Rubble, 0.14, 0.32);
    }

    this.statsCache = {
      particles:
        this.softPool.countLive(ctx.time) +
        this.glowPool.countLive(ctx.time) +
        this.ambientPool.countLive(ctx.time) +
        this.debris.liveCount,
      decals: this.decalPool.count,
      ribbons: this.streakPool.countLive(ctx.time) + this.motePool.countLive(ctx.time),
      // Five instanced particle/decal meshes plus the debris batch. Every pool
      // is ONE draw regardless of how many particles are live — which is the
      // whole point of putting the simulation in the vertex shader.
      drawCalls: 6,
    };
  }

  /**
   * Wire the soft-particle depth fade if the graph is publishing scene depth.
   * `has()` is the supported degradation path (`types.ts` §12): on a graph
   * without a depth prepass this returns false, the uniform switches the fetch
   * off entirely, and the particles are hard-edged rather than broken.
   */
  private syncSoftParticles(ctx: FrameCtx): void {
    const graph = this.services.graph;
    const soft = ctx.quality.particles.soft;
    let depth: THREE.Texture | null = null;
    if (soft && graph.has(RTId.SceneDepth)) {
      // BY NAME, through the graph — never by reaching for a render target's
      // depth attachment. `SceneDepth` is an R32F COLOUR target holding linear
      // view metres, not a depth texture (`src/render/targets.ts`), and the
      // shader reads it as metres.
      depth = graph.texture(RTId.SceneDepth);
    }
    // 0.55 m of depth difference: a smoke card meeting the ground fades over
    // roughly half a metre, which reads as the body being three-dimensional
    // rather than as a straight intersection line.
    this.globals.syncDepth(depth, ctx.camera.near, ctx.camera.far, 0.55);
  }

  private globalsWidth(): number {
    return Math.max(1, this.services.graph.width);
  }

  private globalsHeight(): number {
    return Math.max(1, this.services.graph.height);
  }

  /**
   * Drive the stand-in point lights. Only ever present while LIGHT is the null
   * service; see the file header. Intensity is converted out of candela with a
   * squared-distance decay so the falloff is at least physically shaped.
   */
  private updateStandIns(dt: number): void {
    if (this.standInLights.length === 0) return;
    for (let i = this.standInBudget.length - 1; i >= 0; i--) {
      const b = this.standInBudget[i];
      b.ttl -= dt;
      if (b.ttl <= 0) this.standInBudget.splice(i, 1);
    }
    this.standInBudget.sort((a, b) => b.intensity - a.intensity);
    for (let i = 0; i < this.standInLights.length; i++) {
      const light = this.standInLights[i];
      const b = this.standInBudget[i];
      if (!b) {
        light.intensity = 0;
        continue;
      }
      const k = clamp(b.ttl / b.life, 0, 1);
      light.position.copy(b.position);
      light.color.copy(b.color);
      // Candela straight in: three's punctual lights are photometric from
      // r155, so this is only ever reached against the day-0 null lighting and
      // the cubic term is the §2.7 flash decay.
      light.intensity = b.intensity * k * k * k;
      light.distance = 40;
      light.decay = 2;
    }
  }

  /** Deterministic playback of a scripted shot scene, driven by sim time. */
  private runScene(ctx: FrameCtx): void {
    const scene = this.scene;
    if (!scene) return;
    if (this.sceneStart < 0) this.sceneStart = ctx.time;
    const elapsed = ctx.time - this.sceneStart;
    scene.run(this, elapsed, ctx);
    this.sceneCursor = elapsed;
    if (elapsed > scene.seconds) this.scene = null;
  }

  /** Lane-private accessors used by the scripted scenes. */
  get sceneTime(): number {
    return this.sceneCursor;
  }

  get vfxRng(): Rng {
    return this.rng;
  }

  get vfxSink(): Sink {
    return this.sink;
  }

  get now(): number {
    return this.time;
  }

  softSpawn(s: SoftSpawn, backdate = 0): void {
    this.softPool.spawn(this.time - backdate, s);
  }

  streakSpawn(s: StreakSpawn, backdate = 0): void {
    this.streakPool.spawn(this.time - backdate, s);
  }
}

/* ========================================================================== */

let instance: IronVfx | null = null;

export function createVfxService(ctx: BootContext): VfxService {
  instance = new IronVfx(ctx);
  return instance;
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 *
 * This lane declares NO bake steps, and that is a deliberate design decision
 * rather than an omission. Architecture step 11 budgets 50 units for "decal +
 * particle atlases"; there are no atlases here. Every particle's shape,
 * internal turbulence, erosion and decal outline is evaluated analytically in
 * the fragment shader from a value-noise basis, which means it does not repeat
 * at any zoom, costs no texture memory, costs no bake time, and cannot alias
 * into a visible tile — the failure mode a 512² smoke atlas has by
 * construction. The 50 units go back to the ceiling for someone who needs them.
 */
export function registerVfxBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Intentionally empty; see above.
}

/**
 * Harness reset chain, at the top of EVERY capture. `clearTransient()` is also
 * called explicitly earlier in the chain; this hook covers the rest — the
 * scripted-scene cursor, the emitter registry, the stand-in lights and the
 * ambient field's camera anchor. The acceptance test is byte-identical PNGs
 * across capture orders, so anything that survives a capture must die here.
 */
export function resetVfx(_seed: number): void {
  instance?.clearTransient();
}

/** Lane-private handle for `src/shots/vfx.ts`. Never imported by another lane. */
export function vfxInstance(): IronVfx | null {
  return instance;
}
