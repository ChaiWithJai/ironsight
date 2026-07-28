/**
 * PhysicsService over rapier3d-compat. OWNER: PHYS.
 *
 * THE SHAPE OF THIS LANE
 * ----------------------
 * `world.ts` owns the solver and its async init; `bodies.ts` owns the
 * handle↔collider↔entity bookkeeping; `queries.ts` owns every cast;
 * `character.ts` owns collide-and-slide; `ragdoll.ts` owns articulation;
 * `destruction/` owns fracture and debris. THIS file is the service facade, the
 * three tick systems, and the one place the world is built from other lanes'
 * data.
 *
 * WHY `ready` MATTERS MORE THAN IT LOOKS
 * --------------------------------------
 * GAME's `WorldProbe` resolves ground analytically against `MACRO_TERRAIN` while
 * `PhysicsService.ready` is false, and switches every query to rapier the moment
 * it flips. So `ready` is not "did the constructor finish" — it is "is the world
 * SOLID AND CORRECT". If the terrain collider fails its verification probe below,
 * we tear it out and stay not-ready, because a wrong floor is far worse than a
 * missing one: the analytic fallback puts soldiers on the ground, a transposed
 * heightfield puts them inside a hill.
 *
 * DETERMINISM, restated because it is the whole reason for `BodyTable`: rapier's
 * f32 solver is reproducible for identical INPUT SEQUENCES but not across
 * differing BODY-INSERTION ORDER, and destruction makes insertion order dynamic.
 * Every spawn and despawn is driven by a stable integer key and every iteration
 * is in key order.
 *
 * Colliders are a DELIBERATE SECOND REPRESENTATION: heightfield for terrain,
 * boxes and convex hulls for built geometry, trimesh only where a hull would lie
 * (the freighter hull, the cranes, the fort ramparts). Nothing here ever turns
 * `mesh.geometry` into a collider.
 */
import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import {
  AssetKind,
  BakeKind,
  CollisionGroup,
  NULL_ENTITY,
  RenderStage,
  SurfaceId,
  TickPhase,
  type AssetKey,
  type AssetRegistry,
  type BodyDesc,
  type BodyHandle,
  type BootContext,
  type CharacterConfig,
  type CharacterController,
  type EntityId,
  type PhysicsService,
  type Quat,
  type QualitySettings,
  type QueryFilter,
  type RayHit,
  type Services,
  type StaticColliderDef,
  type TickCtx,
  type Vec3,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import { createNullPhysics, trackNull } from '@/bootstrap/nulls';
import { createRapierWorld, initRapier, rapierReady, rapierModule } from '@/physics/world';
import { BodyTable, freshRayHit, type BodyRecord } from '@/physics/bodies';
import { QueryService } from '@/physics/queries';
import { KinematicCharacter } from '@/physics/character';
import { PhysicsVisuals } from '@/physics/visuals';
import { spawnRagdoll, type Ragdoll } from '@/physics/ragdoll';
import { destructionSystem } from '@/physics/destruction/system';
import { tickScenario, teardownScenario, armScenario } from '@/physics/scenario';

/** Sampled macro heightfield, baked once and turned into one static collider. */
export interface HeightfieldAsset {
  /** Cell counts, i.e. one less than the sample counts along each axis. */
  readonly rows: number;
  readonly cols: number;
  /** Column-major, `heights[row + col * (rows + 1)]`; col→X, row→Z. */
  readonly heights: Float32Array;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly centreX: number;
  readonly centreZ: number;
}

/**
 * 128 cells per axis, which is EXACTLY the tessellation of the placeholder
 * terrain mesh. Matching it means the collider triangles and the visible
 * triangles share their vertices, so nothing floats above the ground or sinks
 * into it. When TERRAIN lands a real eroded heightfield it supplies its own
 * through `collisionHeightfield` and this is bypassed entirely.
 */
const TERRAIN_CELLS = 128;

let terrainKey: AssetKey<HeightfieldAsset> | null = null;
let rapierKey: AssetKey<boolean> | null = null;
let instance: PhysicsSystem | null = null;

/** Lane-internal handle for `destruction/` and `scenario.ts`. Never exported past PHYS. */
export function physicsSystem(): PhysicsSystem | null {
  return instance;
}

export class PhysicsSystem implements PhysicsService {
  readonly world: RAPIER.World;
  readonly rapier = rapierModule();
  readonly table: BodyTable;
  readonly queries: QueryService;
  readonly visuals: PhysicsVisuals;

  private readonly events = new RAPIER.EventQueue(true);
  private readonly characters = new Set<KinematicCharacter>();
  private readonly ragdolls = new Set<Ragdoll>();
  private readonly statics: BodyHandle[] = [];
  private readonly scratchHit: RayHit = freshRayHit();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly statsValue = { bodies: 0, awake: 0, stepMs: 0 };
  private terrainBody: BodyRecord | null = null;
  private worldReady = false;
  private staticStats = { colliders: 0, destructibles: 0 };

  constructor(
    private readonly services: Services,
    private readonly qualityOf: () => Readonly<QualitySettings>,
  ) {
    this.world = createRapierWorld(qualityOf());
    this.table = new BodyTable(this.world);
    this.queries = new QueryService(this.world, this.table, (record, x, _y, z) => {
      // The terrain is the one body whose material is a function of position:
      // wet sand at the waterline, dirt on the terrace, rubble on the headland.
      if (record && this.terrainBody && record.key === this.terrainBody.key) {
        return this.services.terrain.surfaceAt(x, z);
      }
      return record ? record.surface : SurfaceId.Concrete;
    });
    this.visuals = new PhysicsVisuals(services.scene, services.materials);
  }

  get ready(): boolean {
    return this.worldReady;
  }

  /** What the static world build actually produced. Surfaced in the boot log. */
  get worldStats(): Readonly<{ colliders: number; destructibles: number }> {
    return this.staticStats;
  }

  get simTime(): number {
    return this.services.clock.simTime;
  }

  /* ----------------------------------------------------------- world build */

  /**
   * Build the static world: the terrain heightfield, then LEVEL's colliders.
   * Called from `afterBoot`, i.e. once every service exists.
   */
  buildStatics(assets: AssetRegistry): void {
    this.buildTerrain(assets);
    let count = 0;
    let breakable = 0;
    for (const def of this.services.level.collectColliders()) {
      this.addStatic(def);
      count++;
      if (def.destructible) breakable++;
    }
    this.staticStats = { colliders: count, destructibles: breakable };
    this.primeQueries();
    this.worldReady = this.terrainBody !== null && this.verifyTerrain();
    if (this.terrainBody && !this.worldReady) {
      console.error(
        '[PHYS] terrain heightfield failed its verification probe (row/column convention). ' +
          'Removing it and falling back to analytic ground.',
      );
      this.table.destroy(this.terrainBody.handle);
      this.terrainBody = null;
    }
    if (!this.worldReady) {
      console.error(
        '[PHYS] no terrain collider — staying not-ready so GAME keeps its analytic ground.',
      );
    }
  }

  private buildTerrain(assets: AssetRegistry): void {
    const supplied = this.services.terrain.collisionHeightfield;
    let field: HeightfieldAsset | null = null;
    if (supplied.size > 1 && supplied.data.length >= supplied.size * supplied.size) {
      // TERRAIN's own field. Square, centred on the map, scale carries the extent.
      const cells = supplied.size - 1;
      field = {
        rows: cells,
        cols: cells,
        heights: supplied.data,
        sizeX: supplied.scale.x,
        sizeZ: supplied.scale.z,
        centreX: 0,
        centreZ: 0,
      };
    } else if (terrainKey && assets.has(terrainKey)) {
      field = assets.get(terrainKey);
    }
    if (!field) return;

    const body = this.table.create(
      {
        mode: 'static',
        entity: NULL_ENTITY,
        position: new THREE.Vector3(field.centreX, 0, field.centreZ),
        shapes: [
          {
            kind: 'heightfield',
            rows: field.rows,
            cols: field.cols,
            heights: field.heights,
            // Heights are absolute metres, so the Y scale is 1.
            scale: new THREE.Vector3(field.sizeX, 1, field.sizeZ),
          },
        ],
        surface: SurfaceId.Dirt,
        group: CollisionGroup.Terrain,
        collidesWith: CollisionGroup.All,
      },
      0,
    );
    this.terrainBody = body;
  }

  /**
   * REBUILD THE BROAD-PHASE BVH WITHOUT ADVANCING TIME, and read this before
   * deleting it.
   *
   * rapier populates its query acceleration structure inside `step()`. A collider
   * inserted after the last step is therefore INVISIBLE TO EVERY QUERY until the
   * next one: raycasts miss it, shape casts pass through it, and a character
   * controller walks into it as if it were not there. Insert the static world at
   * boot and query it before the first tick and everything misses — which is
   * indistinguishable from "PHYS has not landed yet" and is exactly the kind of
   * failure that costs another lane a day.
   *
   * Stepping with `timestep = 0` builds the structure and integrates nothing:
   * verified against rapier 0.19 with a dynamic body that does not move a single
   * float. This is NOT the per-tick step the architecture reserves for
   * `TickPhase.Physics` — no time passes, and it only ever runs after a bulk
   * insert of statics.
   */
  primeQueries(): void {
    const dt = this.world.timestep;
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = dt;
  }

  /**
   * Cast down at four ASYMMETRIC points and check the collider agrees with the
   * analytic field. A transposed height matrix mirrors the map across its
   * diagonal, which is invisible at the four corners of a square and obvious
   * here — and it would otherwise show up three lanes away as "the bots walk
   * through the headland".
   */
  private verifyTerrain(): boolean {
    const probes: readonly [number, number][] = [
      [90, 140],
      [-150, -30],
      [40, -60],
      [-60, 180],
    ];
    const filter: QueryFilter = { groups: CollisionGroup.Terrain, solid: true };
    const down = this.tmpB.set(0, -1, 0);
    for (const [x, z] of probes) {
      const expected = MACRO_TERRAIN.height(x, z);
      this.tmpA.set(x, expected + 60, z);
      if (!this.queries.raycast(this.tmpA, down, 200, filter, this.scratchHit)) return false;
      if (Math.abs(this.scratchHit.point.y - expected) > 1.5) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------- tick systems */

  step(ctx: TickCtx): void {
    ctx.services.profiler.scope('physics.step', () => {
      this.world.step(this.events);
    });
  }

  /** PrePhysics: scenario scripting and kinematic targets. */
  preStep(ctx: TickCtx): void {
    tickScenario(this, ctx);
  }

  /** PostPhysics: contact drain, lifetime expiry, table compaction, stats. */
  postStep(ctx: TickCtx): void {
    this.drainContacts(ctx);
    this.table.expire(ctx.time);
    this.table.compact();
    this.statsValue.bodies = this.table.count;
    this.statsValue.awake = this.table.countAwake();
    this.statsValue.stepMs = ctx.services.profiler.frame.systemMs['physics.step'] ?? 0;
  }

  /**
   * Contact-force events become presentation events: a lump of masonry landing
   * makes a noise and kicks up dust, and neither AUDIO nor VFX has to know that
   * rapier exists. Capped per tick — a collapse generates dozens of contacts in
   * one frame and forty simultaneous dust puffs is a white screen.
   */
  private drainContacts(ctx: TickCtx): void {
    let emitted = 0;
    this.events.drainContactForceEvents((event) => {
      if (emitted >= 4) return;
      const record =
        this.table.recordOfCollider(event.collider1()) ?? this.table.recordOfCollider(event.collider2());
      if (!record || !record.alive) return;
      if (record.group !== CollisionGroup.Debris) return;
      const t = record.body.translation();
      this.tmpA.set(t.x, t.y, t.z);
      const magnitude = event.totalForceMagnitude();
      // Below a body weight or so it is a settle, not an impact.
      if (magnitude < 200) return;
      emitted++;
      ctx.fx.emit('debrisBurst', {
        point: this.tmpA.clone(),
        normal: new THREE.Vector3(0, 1, 0),
        surface: record.surface,
        count: 4,
      });
      ctx.fx.emit('sound', { cue: 'x.debris', position: this.tmpA.clone() });
    });
    // Collision start/stop events are drained too, or the queue grows unbounded
    // across a match even with autoDrain on the force events.
    this.events.drainCollisionEvents(() => {});
  }

  syncVisuals(): void {
    this.visuals.sync();
  }

  /* -------------------------------------------------------------- bodies */

  createBody(desc: BodyDesc): BodyHandle {
    return this.table.create(desc, this.simTime).handle;
  }

  destroyBody(handle: BodyHandle): void {
    this.table.destroy(handle);
  }

  /**
   * A static collider, and — if it carries a `destructible` — its registration
   * with DESTRUCTION.
   *
   * Doing the registration HERE rather than making every caller remember it is
   * what makes LEVEL's breakable cover actually breakable: LEVEL tags a few
   * hundred colliders with a `DestructibleDef` and hands them over through
   * `collectColliders()`, and nothing else in the repo is in a position to turn
   * that tag into a live destructible. A destructible also needs an ENTITY —
   * damage is addressed to entities — so one is minted here when the caller did
   * not supply one, and the body carries it so `entityOf(hit.body)` resolves for
   * damage attribution.
   */
  addStatic(def: StaticColliderDef, entity?: EntityId): BodyHandle {
    def.matrix.decompose(this.tmpA, this.tmpQuat, this.tmpScale);
    let owner = entity ?? NULL_ENTITY;
    if (def.destructible && owner === NULL_ENTITY) {
      owner = this.services.entities.create('destructible');
    }
    const record = this.table.create(
      {
        mode: 'static',
        entity: owner,
        position: this.tmpA,
        rotation: this.tmpQuat,
        shapes: [def.shape],
        surface: def.surface,
        group: def.group,
        collidesWith: CollisionGroup.All,
      },
      this.simTime,
    );
    this.statics.push(record.handle);
    if (def.destructible) {
      const destruction = destructionSystem();
      destruction?.register(owner, def.destructible, record.handle);
      /**
       * THE GEOMETRY, not just the collider. This is the only place in the repo
       * that holds both the entity a destructible was minted with and the
       * drawing the lane that authored it handed over, so it is the only place
       * the two can be joined. Skip it and the collider goes, the sightline
       * opens, and the wall is still standing.
       */
      if (destruction) {
        for (const v of def.visuals ?? []) {
          if (v.instanceId !== undefined && v.instanceId >= 0) {
            destruction.attachBatchInstance(owner, v.object, v.instanceId);
          } else {
            destruction.attachVisual(owner, v.object);
          }
        }
      }
    }
    return record.handle;
  }

  setKinematicTarget(handle: BodyHandle, position: Vec3, rotation?: Quat): void {
    const record = this.table.record(handle);
    if (!record) return;
    record.body.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
    if (rotation) {
      record.body.setNextKinematicRotation({
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w,
      });
    }
  }

  bodyTransform(handle: BodyHandle, outPos: Vec3, outRot: Quat): boolean {
    const record = this.table.record(handle);
    if (!record) return false;
    this.table.readTransform(record, outPos, outRot);
    return true;
  }

  applyImpulse(handle: BodyHandle, impulse: Vec3, atPoint?: Vec3): void {
    const record = this.table.record(handle);
    if (!record || !record.body.isDynamic()) return;
    const i = { x: impulse.x, y: impulse.y, z: impulse.z };
    if (atPoint) record.body.applyImpulseAtPoint(i, { x: atPoint.x, y: atPoint.y, z: atPoint.z }, true);
    else record.body.applyImpulse(i, true);
  }

  /**
   * Blast impulse over every dynamic body in range, in SPAWN-KEY ORDER. Falloff
   * is 1/r² clamped at the body's own radius — a linear falloff makes an
   * explosion feel like a push rather than a shock, and an unclamped inverse
   * square launches whatever happens to be at the epicentre into orbit.
   */
  applyRadialImpulse(centre: Vec3, radius: number, peakNs: number, groups: number): void {
    const r2 = radius * radius;
    this.table.each((record) => {
      if (!record.body.isDynamic()) return;
      if ((record.group & groups) === 0) return;
      const t = record.body.translation();
      const dx = t.x - centre.x;
      const dy = t.y - centre.y;
      const dz = t.z - centre.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) return;
      const d = Math.max(0.5, Math.sqrt(d2));
      const falloff = Math.min(1, (radius * radius) / (d * d * 4));
      const scale = (peakNs * falloff) / d;
      record.body.applyImpulse({ x: dx * scale, y: dy * scale + peakNs * falloff * 0.15, z: dz * scale }, true);
    });
  }

  /* -------------------------------------------------------------- queries */

  raycast(origin: Vec3, direction: Vec3, maxDistance: number, filter: QueryFilter, out: RayHit): boolean {
    return this.queries.raycast(origin, direction, maxDistance, filter, out);
  }

  raycastAll(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
    out: RayHit[],
  ): number {
    return this.queries.raycastAll(origin, direction, maxDistance, filter, out);
  }

  sphereCast(
    origin: Vec3,
    direction: Vec3,
    radius: number,
    maxDistance: number,
    filter: QueryFilter,
    out: RayHit,
  ): boolean {
    return this.queries.sphereCast(origin, direction, radius, maxDistance, filter, out);
  }

  overlapSphere(centre: Vec3, radius: number, filter: QueryFilter, out: EntityId[]): number {
    return this.queries.overlapSphere(centre, radius, filter, out);
  }

  visibility(from: Vec3, to: Vec3, groups: number): number {
    return this.queries.visibility(from, to, groups);
  }

  /* ----------------------------------------------------------- characters */

  createCharacter(config: CharacterConfig): CharacterController {
    return this.createKinematicCharacter(config);
  }

  /** Lane-internal: the concrete controller, whose body record is reachable. */
  createKinematicCharacter(config: CharacterConfig): KinematicCharacter {
    const character = new KinematicCharacter(this.world, this.table, this.queries, config, this.simTime);
    this.characters.add(character);
    return character;
  }

  releaseCharacter(character: KinematicCharacter): void {
    if (!this.characters.delete(character)) return;
    character.dispose();
  }

  spawnRagdoll(entity: EntityId, origin: Vec3, yaw: number, impulse: Vec3): Ragdoll {
    const doll = spawnRagdoll(this.world, this.table, entity, origin, yaw, impulse, this.simTime);
    this.ragdolls.add(doll);
    return doll;
  }

  entityOf(handle: BodyHandle): EntityId {
    return this.table.record(handle)?.entity ?? NULL_ENTITY;
  }

  get stats(): Readonly<{ bodies: number; awake: number; stepMs: number }> {
    return this.statsValue;
  }

  /* --------------------------------------------------------------- reset */

  /**
   * Drop every transient body PHYS OWNS. Two things deliberately survive:
   *
   * - Statics (terrain, level geometry) are world data, not shot state, and
   *   rebuilding them per capture would change body insertion order and with it
   *   every debris pile in the repo.
   * - CHARACTER CONTROLLERS BELONG TO WHOEVER CREATED THEM. GAME's reset runs
   *   after this one and teleports its actors back to their spawns; disposing
   *   its controllers here left it holding a freed wasm handle and the next
   *   `teleport()` trapped inside the wasm heap. Lifetime is the caller's, through
   *   `CharacterController.dispose`.
   */
  resetTransients(): void {
    for (const doll of this.ragdolls) doll.dispose();
    this.ragdolls.clear();
    this.visuals.clear();
    this.table.compact();
  }
}

/* ============================================================== factory */

export function createPhysicsService(ctx: BootContext): PhysicsService {
  if (!rapierReady()) {
    console.error(
      '[PHYS] rapier wasm is not initialised — the `phys.rapier` bake step did not run. ' +
        'Falling back to the null physics service.',
    );
    return trackNull(createNullPhysics());
  }

  const system = new PhysicsSystem(ctx.services, () => ctx.quality.settings);
  instance = system;

  ctx.addTick({
    name: 'phys.prestep',
    phase: TickPhase.PrePhysics,
    tick: (tick) => system.preStep(tick),
  });
  ctx.addTick({
    name: 'phys.step',
    phase: TickPhase.Physics,
    tick: (tick) => system.step(tick),
  });
  ctx.addTick({
    name: 'phys.postphysics',
    phase: TickPhase.PostPhysics,
    tick: (tick) => system.postStep(tick),
  });
  ctx.addRender({
    name: 'phys.visuals',
    // Animation is "anything that moves a vertex": debris and ragdoll meshes are
    // exactly that, and they must be posed before culling reads their bounds.
    stage: RenderStage.Animation,
    update: () => system.syncVisuals(),
  });

  ctx.afterBoot(() => {
    system.buildStatics(ctx.assets);
    ctx.report(
      `physics: ${system.stats.bodies} bodies, ${system.worldStats.destructibles} destructible, ` +
        `ready=${system.ready}`,
    );
  });

  return system;
}

/**
 * Bake declaration. Runs after `assets` and BEFORE every other subsystem is
 * constructed, so there is no service to read here — only the registry.
 *
 * TWO STEPS. The rapier wasm instantiation is declared as a bake rather than
 * done lazily in the factory because `@dimforge/rapier3d-compat` needs an
 * `await init()` before a single symbol of it is legal to touch, and bakes are
 * the one place in boot that already knows how to wait for slow work and report
 * progress. The heightfield sampling is 16 641 evaluations of the analytic macro
 * field, which is real milliseconds and belongs on the progress bar rather than
 * inside a constructor.
 */
export function registerPhysicsBakes(assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  rapierKey = assets.define<boolean>('phys.rapier', AssetKind.Data, {
    kind: BakeKind.MainThread,
    version: 1,
    // The wasm is inlined as base64; instantiation is ~40 ms of main thread.
    cost: 40,
    cacheable: false,
    async run(): Promise<boolean> {
      await initRapier();
      return true;
    },
  });

  terrainKey = assets.define<HeightfieldAsset>('phys.terrain.heightfield', AssetKind.Data, {
    kind: BakeKind.MainThread,
    version: 1,
    cost: 24,
    cacheable: false,
    async run(bake): Promise<HeightfieldAsset> {
      const b = MACRO_TERRAIN.bounds;
      const sizeX = b.maxX - b.minX;
      const sizeZ = b.maxZ - b.minZ;
      const n = TERRAIN_CELLS;
      const heights = new Float32Array((n + 1) * (n + 1));
      for (let col = 0; col <= n; col++) {
        const x = b.minX + (col / n) * sizeX;
        for (let row = 0; row <= n; row++) {
          const z = b.minZ + (row / n) * sizeZ;
          // Column-major, col→X, row→Z. Verified against rapier's own
          // convention by `PhysicsSystem.verifyTerrain`.
          heights[row + col * (n + 1)] = MACRO_TERRAIN.height(x, z);
        }
        if ((col & 31) === 0) {
          bake.progress(col / n, 'terrain collision');
          await bake.yieldFrame();
        }
      }
      return {
        rows: n,
        cols: n,
        heights,
        sizeX,
        sizeZ,
        centreX: (b.minX + b.maxX) * 0.5,
        centreZ: (b.minZ + b.maxZ) * 0.5,
      };
    },
  });
  void rapierKey;
}

/**
 * Harness reset chain, at the top of EVERY capture.
 *
 * Transient bodies go; statics stay. The scenario seed protocol is documented in
 * `scenario.ts` — a shot selects a proving-ground by passing a tagged seed to
 * `ShotContext.seed`, which is the only channel a shot file has into a lane.
 */
export function resetPhysics(seed: number): void {
  teardownScenario();
  instance?.resetTransients();
  armScenario(seed);
}

