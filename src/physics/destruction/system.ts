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
  /** The intact mesh, hidden on collapse. Null when another lane owns it. */
  visual: THREE.Object3D | null;
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
      matrix,
    };
    this.byEntity.set(entity as number, record);
    this.order.push(record);
  }

  /**
   * Lane-internal: hand destruction the mesh that represents the INTACT solid so
   * it can take it out of the frame on collapse.
   *
   * The contract has no seam for this yet — `StaticColliderDef.destructible`
   * names a def but not the batch instance it was drawn as, so a LEVEL-owned
   * wall currently collapses with its collider and its debris but leaves its
   * geometry standing. Closing that needs a `hideBatchInstance` handle on the
   * registration, which is an addition to LEVEL's side of the contract, not
   * PHYS's. Called out in the lane report.
   */
  attachVisual(entity: EntityId, object: THREE.Object3D): void {
    const record = this.byEntity.get(entity as number);
    if (record) record.visual = object;
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
    if (record.visual) record.visual.visible = false;

    // 3. Shards, inside the tier's budget.
    let spawned = 0;
    const asset = this.assets.tryGet(record.def.chunks);
    const shards = asset ? shardsOf(asset) : [];
    const impact = new THREE.Vector3(point.x, point.y, point.z);
    if (shards.length > 0) {
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
  ctx.afterBoot((services) => {
    // LEVEL's own destructibles. It hands out defs; the colliders they belong to
    // came through `PhysicsService.addStatic` with `destructible` set.
    void services.level.collectDestructibles();
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
