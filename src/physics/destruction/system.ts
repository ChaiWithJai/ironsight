/**
 * DestructionService. OWNER: PHYS.
 *
 * Destruction is the most cross-cutting feature in the project, and the reason is
 * that a wall coming down is SEVEN consequences in six lanes from one event:
 *
 *   geometry   the intact mesh leaves the frame            (hide, never rebuild)
 *   collision  its static collider leaves the world        (PHYS)
 *   debris     N pre-fractured shards become bodies        (PHYS, inside budget)
 *   cover      the CoverSlots it provided are void         (AI, via prop.destroyed)
 *   nav        the sightline and the path both open        (AI, via nav.dirty)
 *   vfx        a dust column and a spall burst             (VFX, via FxBus)
 *   audio      a collapse, and a noise the bots can hear   (AUDIO + AI)
 *
 * ALL SEVEN ARE DRIVEN FROM ONE `applyDamage` CALL and none of the six lanes
 * knows this file exists. That is the entire design: the events are the API.
 *
 * WHY THE EVENTS ARE QUEUED RATHER THAN EMITTED IMMEDIATELY. `applyDamage` is
 * called from GAME at `TickPhase.Damage` and has no `TickCtx` — there is no bus
 * in scope, by design, because a service method that reaches for a global bus is
 * how ordering guarantees die. So the consequences are queued and flushed from
 * this lane's own system at `TickPhase.Destruction`, which is the phase after
 * Damage. A wall damaged this tick therefore collapses this tick, and everything
 * downstream sees it in the right order.
 *
 * DAMAGE IS ACCUMULATED, NOT THRESHOLDED. A wall that survives a rocket at 1 HP
 * must fall to the next rifle round, and a wall chipped by fifty rounds must
 * still be standing if fifty rounds is not enough. `chipThreshold` is only about
 * whether a hit is worth a decal and a spall puff.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  DamageKind,
  NULL_ENTITY,
  Team,
  TickPhase,
  type AssetRegistry,
  type BodyHandle,
  type BootContext,
  type DamageInfo,
  type DestructibleDef,
  type DestructionResult,
  type DestructionService,
  type EntityId,
  type MeshAsset,
  type QualitySettings,
  type Services,
  type SurfaceId,
  type TickCtx,
  type Vec3,
} from '@/engine/types';
import { createNullDestruction, trackNull } from '@/bootstrap/nulls';
import { physicsLayoutRng } from '@/physics/world';
import { physicsSystem, type PhysicsSystem } from '@/physics/system';
import { ChunkPool } from '@/physics/destruction/chunks';
import { shardsOf } from '@/physics/destruction/fracture';
import { registerFractureBakes } from '@/physics/destruction/defs';

interface Destructible {
  readonly entity: EntityId;
  readonly def: DestructibleDef;
  body: BodyHandle;
  health: number;
  intact: boolean;
  /** The intact mesh, hidden on collapse. Null when the solid is a batch instance. */
  visual: THREE.Object3D | null;
  /**
   * The intact geometry as INSTANCES OF BATCHED DRAWS, hidden on collapse
   * through `SceneGraph.hideBatchInstance`. Several, because one piece of cover
   * is routinely several materials and therefore several batches.
   *
   * A record with an empty list and a null `visual` is COLLIDER-ONLY: it will
   * leave its geometry standing. See `DestructionService.attachVisual`.
   */
  readonly batches: { object: THREE.Object3D; instanceId: number }[];
  /** World transform of the solid, captured at registration. */
  readonly matrix: THREE.Matrix4;
}

interface PendingEvent {
  readonly kind: 'destroyed' | 'chip';
  readonly entity: EntityId;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly surface: SurfaceId;
  readonly result: DestructionResult | null;
  readonly info: DamageInfo | null;
  readonly extent: THREE.Vector3;
}

let instance: DestructionSystem | null = null;

/** Lane-internal accessor for `scenario.ts`. */
export function destructionSystem(): DestructionSystem | null {
  return instance;
}

export class DestructionSystem implements DestructionService {
  private readonly byEntity = new Map<number, Destructible>();
  /** Registration order, so iteration never depends on Map insertion identity. */
  private readonly order: Destructible[] = [];
  private readonly pending: PendingEvent[] = [];
  private readonly pool: ChunkPool;
  private readonly rng = physicsLayoutRng('debris');
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpFit = new THREE.Vector3();
  private readonly statsValue = { chunksLive: 0, chunksSettled: 0, budgetUsed01: 0 };
  private readonly physics: PhysicsSystem;

  constructor(
    private readonly services: Services,
    private readonly assets: AssetRegistry,
    private readonly qualityOf: () => Readonly<QualitySettings>,
  ) {
    const physics = physicsSystem();
    if (!physics) throw new Error('PHYS: destruction constructed before the physics world.');
    this.physics = physics;
    this.pool = new ChunkPool(physics.table, physics.visuals, qualityOf);
  }

  register(entity: EntityId, def: DestructibleDef, body: BodyHandle): void {
    const existing = this.byEntity.get(entity as number);
    if (existing) {
      existing.body = body;
      return;
    }
    const matrix = new THREE.Matrix4();
    if (this.physics.bodyTransform(body, this.tmpPos, this.tmpQuat)) {
      matrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale.set(1, 1, 1));
    }
    const record: Destructible = {
      entity,
      def,
      body,
      health: def.health,
      intact: true,
      visual: null,
      batches: [],
      matrix,
    };
    this.byEntity.set(entity as number, record);
    this.order.push(record);
  }

  /**
   * Hand destruction the mesh that represents the INTACT solid so it can take it
   * out of the frame on collapse. `DestructionService.attachVisual`.
   */
  attachVisual(entity: EntityId, object: THREE.Object3D): void {
    const record = this.byEntity.get(entity as number);
    if (record) record.visual = object;
  }

  /**
   * The batched form. `DestructionService.attachBatchInstance`.
   *
   * Accumulates rather than replaces: LEVEL's cover is drawn as one batch per
   * MATERIAL, so a sandbag emplacement in hessian, bleached canvas and stained
   * rubble is three instances of three different batches and all three have to
   * disappear on the same tick or the wall half-vanishes.
   */
  attachBatchInstance(entity: EntityId, object: THREE.Object3D, instanceId: number): void {
    if (!Number.isInteger(instanceId) || instanceId < 0) return;
    const record = this.byEntity.get(entity as number);
    if (!record) return;
    for (const b of record.batches) if (b.object === object && b.instanceId === instanceId) return;
    record.batches.push({ object, instanceId });
  }

  applyDamage(info: DamageInfo): DestructionResult {
    const record = this.byEntity.get(info.target as number);
    if (!record || !record.intact) {
      return {
        destroyed: false,
        chunksSpawned: 0,
        surface: info.surface,
        coverLost: false,
        position: info.point,
      };
    }

    const def = record.def;
    const explosive = info.kind === DamageKind.Explosion;
    const amount = info.amount * (explosive ? def.explosiveMultiplier : 1);

    if (amount < def.chipThreshold && !explosive) {
      // Cosmetic: the geometry survives, but the hit is still worth a decal and
      // a puff of spall, and the wall still remembers the damage.
      record.health -= amount;
      this.chip(info.point, info.normal, info.energyJ, def.surface);
      if (record.health > 0) {
        return {
          destroyed: false,
          chunksSpawned: 0,
          surface: def.surface,
          coverLost: false,
          position: info.point,
        };
      }
    } else {
      record.health -= amount;
    }

    if (record.health > 0) {
      return {
        destroyed: false,
        chunksSpawned: 0,
        surface: def.surface,
        coverLost: false,
        position: info.point,
      };
    }
    return this.collapse(record, info.point, info.normal, Math.max(info.energyJ, amount * 12));
  }

  /** The whole consequence chain for one solid coming down. */
  private collapse(
    record: Destructible,
    point: Vec3,
    normal: Vec3,
    energyJ: number,
  ): DestructionResult {
    record.intact = false;
    record.health = 0;

    // 1. The collider leaves the world. Do this BEFORE spawning shards, or the
    //    shards spawn interpenetrating the wall they came from and the pile
    //    explodes on the first solve.
    if (record.body) this.physics.destroyBody(record.body);

    // 2. The intact geometry leaves the frame — hidden, never rebuilt.
    //    Two forms: an Object3D of its own, or N instances of batched draws.
    //    A record with NEITHER is collider-only and leaves its mesh standing.
    if (record.visual) record.visual.visible = false;
    for (const b of record.batches) {
      this.services.scene.hideBatchInstance(b.object, b.instanceId);
    }

    // 3. Shards, inside the tier's budget.
    let spawned = 0;
    const asset = this.assets.tryGet(record.def.chunks);
    const shards = asset ? shardsOf(asset) : [];
    const impact = new THREE.Vector3(point.x, point.y, point.z);
    if (asset && shards.length > 0) {
      const fit = this.shardFit(record.def, asset);
      spawned = this.pool.spawn(
        {
          shards,
          matrix: record.matrix,
          surface: record.def.surface,
          entity: record.entity,
          impactPoint: impact,
          energyJ,
          lifetimeSeconds: record.def.debrisLifetime,
          settleAfter: record.def.settleAfter,
          centreScale: fit.centreScale,
          shapeScale: fit.shapeScale,
        },
        this.rng,
        this.services.clock.simTime,
      );
    }

    const result: DestructionResult = {
      destroyed: true,
      chunksSpawned: spawned,
      surface: record.def.surface,
      coverLost: record.def.coverValue > 0,
      position: impact.clone(),
    };

    // 4..7 are events, flushed next phase with a bus in scope.
    record.matrix.decompose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.pending.push({
      kind: 'destroyed',
      entity: record.entity,
      point: impact.clone(),
      normal: new THREE.Vector3(normal.x, normal.y, normal.z),
      surface: record.def.surface,
      result,
      info: null,
      extent: this.tmpPos.clone(),
    });
    return result;
  }

  /**
   * How a SHARED shard set is re-proportioned into the solid that actually
   * broke. See `DestructibleDef.extent`.
   *
   * The shape scale is the cube root of the volume ratio and is CLAMPED: a
   * 0.02 m³ prop and a 12 m³ wall share one set, and letting the ratio run
   * unbounded turns the small one into grit and the large one into boulders.
   */
  private shardFit(
    def: DestructibleDef,
    asset: MeshAsset,
  ): { centreScale: THREE.Vector3; shapeScale: number } {
    const scale = this.tmpFit.set(1, 1, 1);
    if (!def.extent) return { centreScale: scale, shapeScale: 1 };
    const b = asset.bounds;
    const hx = Math.max(1e-3, (b.max.x - b.min.x) * 0.5);
    const hy = Math.max(1e-3, (b.max.y - b.min.y) * 0.5);
    const hz = Math.max(1e-3, (b.max.z - b.min.z) * 0.5);
    scale.set(def.extent.x / hx, def.extent.y / hy, def.extent.z / hz);
    const ratio = Math.max(1e-6, scale.x * scale.y * scale.z);
    return { centreScale: scale, shapeScale: Math.min(2.4, Math.max(0.4, Math.cbrt(ratio))) };
  }

  chip(point: Vec3, normal: Vec3, energyJ: number, surface: SurfaceId): void {
    this.pending.push({
      kind: 'chip',
      entity: NULL_ENTITY,
      point: new THREE.Vector3(point.x, point.y, point.z),
      normal: new THREE.Vector3(normal.x, normal.y, normal.z),
      surface,
      result: null,
      info: null,
      extent: new THREE.Vector3(energyJ, 0, 0),
    });
  }

  isIntact(entity: EntityId): boolean {
    const record = this.byEntity.get(entity as number);
    return record ? record.intact : true;
  }

  healthFraction(entity: EntityId): number {
    const record = this.byEntity.get(entity as number);
    if (!record) return 1;
    return Math.max(0, Math.min(1, record.health / Math.max(1, record.def.health)));
  }

  /** `TickPhase.Destruction`: flush consequences, then run the chunk budget. */
  tick(ctx: TickCtx): void {
    for (const event of this.pending) {
      if (event.kind === 'chip') {
        const energyJ = event.extent.x;
        ctx.fx.emit('debrisBurst', {
          point: event.point,
          normal: event.normal,
          surface: event.surface,
          // A rifle round takes a fist-sized bite; a 40 mm takes a chunk.
          count: Math.max(2, Math.min(12, Math.round(energyJ / 220))),
        });
        continue;
      }

      const result = event.result;
      if (!result) continue;
      ctx.sim.emit('prop.destroyed', { entity: event.entity, result });
      // AI must re-evaluate its cover graph AND its paths: the wall was both.
      ctx.sim.emit('nav.dirty', {
        min: event.point.clone().addScalar(-4),
        max: event.point.clone().addScalar(4),
      });
      ctx.sim.emit('noise.emitted', {
        position: event.point,
        // A masonry wall coming down is about 105 dB SPL at 1 m — louder than a
        // rifle report, and it is the loudest thing bots will hear all match.
        loudnessDb: 105,
        team: Team.Neutral,
        source: event.entity,
        kind: 'collapse',
      });
      ctx.fx.emit('sound', { cue: 'x.collapse', position: event.point.clone() });
      // Three bursts along the base rather than one at the impact: the dust of a
      // collapse comes off the whole footprint, and one puff at the muzzle end
      // reads as an explosion instead.
      for (let i = -1; i <= 1; i++) {
        ctx.fx.emit('debrisBurst', {
          point: event.point.clone().add(new THREE.Vector3(i * 1.6, -0.6, 0)),
          normal: new THREE.Vector3(0, 1, 0),
          surface: event.surface,
          count: 18,
        });
      }
    }
    this.pending.length = 0;

    this.pool.tick(ctx.time, this.qualityOf().destruction.settleSeconds);
    this.statsValue.chunksLive = this.pool.liveCount;
    this.statsValue.chunksSettled = this.pool.settled;
    this.statsValue.budgetUsed01 = this.pool.budgetUsed01;
  }

  /**
   * Called by the harness driver between shots. Damage that leaks across a
   * capture makes a screenshot depend on the ORDER shots were taken in.
   */
  reset(): void {
    this.pool.clear();
    this.pending.length = 0;
    for (const record of this.order) {
      record.health = record.def.health;
      record.intact = true;
      if (record.visual) record.visual.visible = true;
      // Batch instances are NOT restored here: `SceneGraph` exposes hide only,
      // and the lane that built the batch is the one that can re-show it. LEVEL
      // does exactly that in `resetLevel`, which the same reset chain calls.
      record.batches.length = 0;
    }
    // Registrations themselves are cleared: the scenario that made them is torn
    // down too, and a stale entity id would resolve to a destroyed body.
    this.byEntity.clear();
    this.order.length = 0;
    this.statsValue.chunksLive = 0;
    this.statsValue.chunksSettled = 0;
    this.statsValue.budgetUsed01 = 0;
  }

  get stats(): Readonly<{ chunksLive: number; chunksSettled: number; budgetUsed01: number }> {
    return this.statsValue;
  }

  /* ----------------------------------------------------------- diagnostics */

  /**
   * The registration table, summarised. `colliderOnly` is THE number this whole
   * seam exists to drive to zero: it counts destructibles that will lose their
   * collider and leave their geometry standing.
   */
  registrationSummary(): {
    registered: number;
    withVisual: number;
    withBatch: number;
    colliderOnly: number;
    batchInstances: number;
    intact: number;
    withShards: number;
  } {
    let withVisual = 0;
    let withBatch = 0;
    let colliderOnly = 0;
    let batchInstances = 0;
    let intact = 0;
    let withShards = 0;
    for (const r of this.order) {
      if (r.visual) withVisual++;
      if (r.batches.length > 0) {
        withBatch++;
        batchInstances += r.batches.length;
      }
      if (!r.visual && r.batches.length === 0) colliderOnly++;
      if (r.intact) intact++;
      const asset = this.assets.tryGet(r.def.chunks);
      if (asset && shardsOf(asset).length > 0) withShards++;
    }
    return {
      registered: this.order.length,
      withVisual,
      withBatch,
      colliderOnly,
      batchInstances,
      intact,
      withShards,
    };
  }

  /**
   * The nearest INTACT destructible to `from`, with everything a driver needs to
   * aim at it and then check whether it actually left the frame.
   */
  nearestIntact(from: Vec3, maxDistance: number): {
    entity: number;
    id: string;
    position: [number, number, number];
    extent: [number, number, number];
    distance: number;
    health: number;
    batches: number;
    hasVisual: boolean;
    shards: number;
  } | null {
    let best: Destructible | null = null;
    let bestD = maxDistance * maxDistance;
    const p = new THREE.Vector3();
    for (const r of this.order) {
      if (!r.intact) continue;
      p.setFromMatrixPosition(r.matrix);
      const d = p.distanceToSquared(from as THREE.Vector3);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (!best) return null;
    p.setFromMatrixPosition(best.matrix);
    const e = best.def.extent;
    const asset = this.assets.tryGet(best.def.chunks);
    return {
      entity: best.entity as number,
      id: best.def.id,
      position: [p.x, p.y, p.z],
      extent: e ? [e.x, e.y, e.z] : [0, 0, 0],
      distance: Math.sqrt(bestD),
      health: best.health,
      batches: best.batches.length,
      hasVisual: best.visual !== null,
      shards: asset ? shardsOf(asset).length : 0,
    };
  }

  /**
   * Every destructible within `radius` of `from`, intact or not, with its
   * geometry state. The pairing of `intact` with `drawing` is the whole point:
   * `intact: false, drawing: true` is the defect this change exists to kill —
   * the collider gone, the sightline open, the wall still standing.
   */
  nearbyRegistrations(from: Vec3, radius: number): {
    entity: number;
    id: string;
    position: [number, number, number];
    distance: number;
    batches: number;
    intact: boolean;
    drawing: true | false | 'unattached';
  }[] {
    const out: ReturnType<DestructionSystem['nearbyRegistrations']> = [];
    const p = new THREE.Vector3();
    const r2 = radius * radius;
    for (const record of this.order) {
      p.setFromMatrixPosition(record.matrix);
      const d2 = p.distanceToSquared(from as THREE.Vector3);
      if (d2 > r2) continue;
      out.push({
        entity: record.entity as number,
        id: record.def.id,
        position: [p.x, p.y, p.z],
        distance: Math.sqrt(d2),
        batches: record.batches.length,
        intact: record.intact,
        drawing: this.visibleFor(record.entity as number),
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /**
   * Is `entity` still drawing anything?
   *
   * `'unattached'` is deliberately NOT folded into `false`: a collider-only
   * destructible draws geometry nobody can hide, and reporting that as "not
   * visible" is exactly the confusion this whole change exists to remove.
   */
  visibleFor(entity: number): true | false | 'unattached' {
    const r = this.byEntity.get(entity);
    if (!r) return false;
    if (!r.visual && r.batches.length === 0) return 'unattached';
    if (r.visual && r.visual.visible) return true;
    for (const b of r.batches) {
      const batched = b.object as THREE.BatchedMesh;
      if (typeof batched.getVisibleAt === 'function' && batched.getVisibleAt(b.instanceId)) return true;
    }
    return false;
  }
}

/**
 * LANE-PRIVATE DIAGNOSTIC PROBE. Not gameplay, not the contract, not read by
 * anything in `src/`. Same shape and same rationale as WEAPONS' `__THROWABLES__`
 * and CORE's `__SOAK__`.
 *
 * It exists because BOTH of this repo's instruments are structurally blind to
 * destruction: `EngineDriver.resetChain` calls `DestructionService.reset()`,
 * which clears the registration table, and only `PhysicsService.addStatic`
 * refills it at world build — so inside every `tools/shoot.sh` capture and every
 * `tools/soak.sh` run all ~244 level destructibles are inert static colliders
 * and nothing can be broken at all. Live play never resets. Any claim about
 * destruction therefore has to be read out of a live page, and this is the
 * readout: how many destructibles have geometry attached, how many are
 * collider-only, and whether a specific wall is still being drawn after it fell.
 */
export interface DestructionProbe {
  readonly available: true;
  summary(): ReturnType<DestructionSystem['registrationSummary']>;
  nearest(from: [number, number, number], maxDistance: number): ReturnType<DestructionSystem['nearestIntact']>;
  nearby(from: [number, number, number], radius: number): ReturnType<DestructionSystem['nearbyRegistrations']>;
  visible(entity: number): true | false | 'unattached';
  intact(entity: number): boolean;
  chunkStats(): { chunksLive: number; chunksSettled: number; budgetUsed01: number };
}

declare global {
  // eslint-disable-next-line no-var
  var __DESTR__: DestructionProbe | undefined;
}

function installDestructionProbe(system: DestructionSystem): void {
  const scratch = new THREE.Vector3();
  globalThis.__DESTR__ = {
    available: true,
    summary: () => system.registrationSummary(),
    nearest: (from, maxDistance) =>
      system.nearestIntact(scratch.set(from[0], from[1], from[2]), maxDistance),
    nearby: (from, radius) =>
      system.nearbyRegistrations(scratch.set(from[0], from[1], from[2]), radius),
    visible: (entity) => system.visibleFor(entity),
    intact: (entity) => system.isIntact(entity as unknown as EntityId),
    chunkStats: () => ({ ...system.stats }),
  };
}

export function createDestructionService(ctx: BootContext): DestructionService {
  const physics = physicsSystem();
  if (!physics) {
    // PHYS fell back to the null service, so there is no world to break things
    // in. Degrade in step rather than throwing the whole boot away.
    return trackNull(createNullDestruction());
  }
  const system = new DestructionSystem(ctx.services, ctx.assets, () => ctx.quality.settings);
  instance = system;
  ctx.addTick({
    name: 'phys.destruction',
    phase: TickPhase.Destruction,
    tick: (tick) => system.tick(tick),
  });
  installDestructionProbe(system);
  ctx.afterBoot((services) => {
    // LEVEL's own destructibles. It hands out defs; the colliders they belong to
    // came through `PhysicsService.addStatic` with `destructible` set.
    void services.level.collectDestructibles();
    const s = system.registrationSummary();
    console.info(
      `[boot] destruction · ${s.registered} registered · ${s.withBatch} batched ` +
        `(${s.batchInstances} instances) · ${s.withVisual} meshed · ` +
        `${s.colliderOnly} COLLIDER-ONLY · ${s.withShards} with shards`,
    );
  });
  return system;
}

export function registerDestructionBakes(
  assets: AssetRegistry,
  quality: Readonly<QualitySettings>,
): void {
  registerFractureBakes(assets, quality);
}

/**
 * Harness reset chain. `DestructionService.reset()` is called explicitly earlier
 * in the chain; this hook exists for anything the interface method does not
 * cover — and the chunk pool, which is not part of the interface, is exactly
 * that.
 */
export function resetDestruction(_seed: number): void {
  instance?.reset();
}

/** Collision group used for the static side of a destructible. */
export const DESTRUCTIBLE_GROUP = CollisionGroup.StaticGeo;
